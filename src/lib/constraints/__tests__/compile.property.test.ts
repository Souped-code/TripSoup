// E2 ACCEPTANCE PROPERTY (the plan's, literally): "compileFromDoc(oldDoc)'s
// hard constraints are satisfied by the CURRENT solver's output on every
// fixture trip."
//
// The claim is one-directional on purpose: the property says nothing about
// docs the solver rejects or calls infeasible — it claims only that WHERE THE
// SOLVER SUCCEEDS, the plan it produces satisfies every hard constraint the
// compiler derived from the same doc. That is exactly the invariant E5's new
// engine must preserve, so this file becomes the differential harness later.
//
// Fixture mode + TRIPS_DIR temp isolation (the planStore.test.ts pattern): no
// live Maps or LLM call is ever made here, and nothing touches the real store.

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import fc from "fast-check";
import { compileFromDoc } from "../compile";
import { isHard, type ConstraintSet } from "../types";
import { planTripDay } from "../../planService";
import { FIXTURE_STOPS } from "../../maps/fixtureCity";
import type { TripDay, TripDoc, TripStop } from "../../store/types";
import type { DayPlan } from "../../schedule/types";

const ALL_IDS = FIXTURE_STOPS.map((s) => s.id);
const MAX_DAYS = 3;
const MAX_PER_DAY = 4; // keeps every day inside the solver's exhaustive regime
const POOL = MAX_DAYS * MAX_PER_DAY;

const tripStop = (id: string, durationMin: number, anchorStartMin?: number): TripStop => {
  const f = FIXTURE_STOPS.find((s) => s.id === id)!;
  return {
    id: f.id,
    name: f.name,
    location: f.location,
    durationMin,
    ...(anchorStartMin === undefined ? {} : { anchor: { startMin: anchorStartMin } }),
  };
};

// A fixture TripDoc: 1-3 days, a disjoint subset of FIXTURE_STOPS per day,
// optional anchors, optional precedence (same-day pairs drawn consistently with
// the day's list order, so they are always satisfiable; plus an optional
// cross-day pair, which compiles SOFT and is therefore not asserted on).
const docArb = (): fc.Arbitrary<TripDoc> =>
  fc
    .record({
      numDays: fc.integer({ min: 1, max: MAX_DAYS }),
      counts: fc.array(fc.integer({ min: 1, max: MAX_PER_DAY }), {
        minLength: MAX_DAYS,
        maxLength: MAX_DAYS,
      }),
      ids: fc.shuffledSubarray(ALL_IDS, { minLength: POOL, maxLength: POOL }),
      durations: fc.array(fc.integer({ min: 20, max: 75 }), { minLength: POOL, maxLength: POOL }),
      dayStarts: fc.array(fc.integer({ min: 8 * 60, max: 10 * 60 }), {
        minLength: MAX_DAYS,
        maxLength: MAX_DAYS,
      }),
      daySpans: fc.array(fc.integer({ min: 360, max: 660 }), {
        minLength: MAX_DAYS,
        maxLength: MAX_DAYS,
      }),
      // -1 = no anchor on that day; otherwise the position in the day's list.
      anchorAt: fc.array(fc.integer({ min: -1, max: MAX_PER_DAY - 1 }), {
        minLength: MAX_DAYS,
        maxLength: MAX_DAYS,
      }),
      anchorOffset: fc.array(fc.integer({ min: 60, max: 300 }), {
        minLength: MAX_DAYS,
        maxLength: MAX_DAYS,
      }),
      precRolls: fc.array(fc.integer({ min: 0, max: 99 }), {
        minLength: MAX_DAYS * MAX_PER_DAY * MAX_PER_DAY,
        maxLength: MAX_DAYS * MAX_PER_DAY * MAX_PER_DAY,
      }),
      crossDay: fc.boolean(),
    })
    .map((r) => {
      let cursor = 0;
      const days: TripDay[] = [];
      for (let d = 0; d < r.numDays; d++) {
        const count = r.counts[d];
        const dayStartMin = r.dayStarts[d];
        const dayEndMin = dayStartMin + r.daySpans[d];
        const anchorIndex = r.anchorAt[d] < count ? r.anchorAt[d] : -1;
        const anchorStartMin = Math.min(dayStartMin + r.anchorOffset[d], dayEndMin);

        const stops: TripStop[] = [];
        for (let k = 0; k < count; k++) {
          stops.push(
            tripStop(
              r.ids[cursor + k],
              r.durations[cursor + k],
              k === anchorIndex ? anchorStartMin : undefined
            )
          );
        }

        // Pairs (i < j) in list order: consistent with the day's own layout, so
        // an ok plan can always honour them.
        const precedence: NonNullable<TripDay["precedence"]>[number][] = [];
        for (let i = 0; i < count; i++) {
          for (let j = i + 1; j < count; j++) {
            const roll = r.precRolls[d * MAX_PER_DAY * MAX_PER_DAY + i * MAX_PER_DAY + j];
            if (roll < 30) precedence.push({ beforeId: stops[i].id, afterId: stops[j].id });
          }
        }
        if (d === 0 && r.crossDay && r.numDays > 1) {
          // Endpoint on day 1 — resolved after the loop, so record it by id now.
          precedence.push({ beforeId: stops[0].id, afterId: r.ids[r.counts[0]] });
        }

        days.push({
          date: `2026-07-0${d + 1}`,
          dayStartMin,
          dayEndMin,
          stops,
          ...(precedence.length > 0 ? { precedence } : {}),
        });
        cursor += count;
      }
      return {
        tripId: "prop-trip",
        days,
        settings: { walkMax: 10, driveOverheadMin: 10 },
        legOverrides: [],
      };
    });

/** How many of each hard constraint kind the run actually exercised — asserted
 * non-zero at the end so a future change to the arbitrary cannot quietly turn
 * this property into a tautology. */
type Coverage = { okDays: number; totalDays: number; windows: number; precedence: number; pins: number };

/** Every hard constraint in `set` that says anything about day `dayIndex`,
 * checked against the plan the current solver produced for that day. */
function assertHardConstraintsSatisfied(
  set: ConstraintSet,
  dayIndex: number,
  plan: DayPlan,
  cover: Coverage
): void {
  cover.totalDays++;
  if (plan.status !== "ok") return; // property claims nothing about failures
  cover.okDays++;

  const dayWindow = set.days[dayIndex].window;
  expect(isHard(dayWindow)).toBe(true);

  const position = new Map(plan.entries.map((e, i) => [e.stopId, i]));

  for (const entry of plan.entries) {
    const stop = set.stops[entry.stopId];
    expect(stop).toBeDefined();

    // pinnedDay (hard, launch mode): the stop is on the day it was pinned to.
    if (stop.pinnedDay && isHard(stop.pinnedDay)) {
      cover.pins++;
      expect(stop.pinnedDay.value.index).toBe(dayIndex);
    }

    // window (hard): constrains the visit START — an anchor is [t, t].
    if (stop.window && isHard(stop.window)) {
      cover.windows++;
      expect(entry.startMin).toBeGreaterThanOrEqual(stop.window.value.startMin);
      expect(entry.startMin).toBeLessThanOrEqual(stop.window.value.endMin);
    }

    // duration (hard): the scheduled visit length sits inside the range.
    if (isHard(stop.duration)) {
      const scheduled = entry.departMin - entry.startMin;
      expect(scheduled).toBeGreaterThanOrEqual(stop.duration.value.minMin);
      expect(scheduled).toBeLessThanOrEqual(stop.duration.value.maxMin);
    }

    // day window (hard): nothing arrives before it opens or departs after it closes.
    expect(entry.arriveMin).toBeGreaterThanOrEqual(dayWindow.value.startMin);
    expect(entry.departMin).toBeLessThanOrEqual(dayWindow.value.endMin);
  }

  // priority "must" (hard): nothing pinned here was dropped, and nothing
  // appeared that wasn't pinned here.
  const expectedIds = Object.entries(set.stops)
    .filter(
      ([, c]) =>
        c.pinnedDay !== undefined &&
        isHard(c.pinnedDay) &&
        c.pinnedDay.value.index === dayIndex &&
        isHard(c.priority) &&
        c.priority.value === "must"
    )
    .map(([id]) => id)
    .sort();
  expect([...plan.entries.map((e) => e.stopId)].sort()).toEqual(expectedIds);

  // precedence (hard = both endpoints on one day): honoured by the visit order.
  for (const rel of set.relations) {
    if (rel.value.kind !== "precedence" || !isHard(rel)) continue;
    const before = position.get(rel.value.beforeId);
    const after = position.get(rel.value.afterId);
    if (before === undefined || after === undefined) continue;
    cover.precedence++;
    expect(before).toBeLessThan(after);
  }
}

describe("E2 acceptance: the current solver satisfies every compiled HARD constraint", () => {
  let tmpDir: string;
  let prevMapsProvider: string | undefined;
  let prevTripsDir: string | undefined;

  beforeEach(() => {
    prevMapsProvider = process.env.MAPS_PROVIDER;
    prevTripsDir = process.env.TRIPS_DIR;
    process.env.MAPS_PROVIDER = "fixture";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "constraints-test-"));
    process.env.TRIPS_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevMapsProvider === undefined) delete process.env.MAPS_PROVIDER;
    else process.env.MAPS_PROVIDER = prevMapsProvider;
    if (prevTripsDir === undefined) delete process.env.TRIPS_DIR;
    else process.env.TRIPS_DIR = prevTripsDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("holds over generated fixture trips (1-3 days, anchors, precedence)", async () => {
    const cover: Coverage = { okDays: 0, totalDays: 0, windows: 0, precedence: 0, pins: 0 };

    await fc.assert(
      fc.asyncProperty(docArb(), async (doc) => {
        const set = compileFromDoc(doc);
        for (let i = 0; i < doc.days.length; i++) {
          assertHardConstraintsSatisfied(set, i, await planTripDay(doc, i), cover);
        }
        return true;
      }),
      { numRuns: 40, seed: 421 }
    );

    // Guard against a vacuous pass: the property means nothing unless the
    // solver actually succeeded on a decent share of the generated trips AND
    // each hard constraint kind was really exercised.
    expect(cover.totalDays).toBeGreaterThan(0);
    expect(cover.okDays / cover.totalDays).toBeGreaterThan(0.5);
    expect(cover.windows).toBeGreaterThan(0); // anchors -> hard [t, t] windows
    expect(cover.precedence).toBeGreaterThan(0); // same-day hard precedence
    expect(cover.pins).toBeGreaterThan(0);
  }, 120_000);

  it("compileFromDoc is deterministic over generated docs", () => {
    fc.assert(
      fc.property(docArb(), (doc) => {
        expect(compileFromDoc(doc)).toEqual(compileFromDoc(doc));
        return true;
      }),
      { numRuns: 50, seed: 422 }
    );
  });

  it("every stop of every day is hard-pinned to that day (single-day launch mode)", () => {
    fc.assert(
      fc.property(docArb(), (doc) => {
        const set = compileFromDoc(doc);
        doc.days.forEach((day, i) => {
          for (const s of day.stops) {
            const pin = set.stops[s.id].pinnedDay;
            expect(pin).toBeDefined();
            expect(isHard(pin!)).toBe(true);
            expect(pin!.value.index).toBe(i);
          }
        });
        return true;
      }),
      { numRuns: 50, seed: 422 }
    );
  });
});
