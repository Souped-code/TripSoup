// E5a ACCEPTANCE, NON-NEGOTIABLE: on a day in the OLD constraint class the new
// engine's answer is EXACTLY the old solver's answer.
//
// This is the whole reason the hybrid exhaustive floor exists. The old solver
// (src/lib/solver/solver.ts + src/lib/schedule/schedule.ts) is imported
// directly and stays in the tree as the oracle: on <=9-flexible-stop days with
// nothing but a day window and point anchors, its answer is the PROVEN optimum,
// so any divergence is the new engine being wrong — not merely different.
//
// "Exactly" means order, entries (arrive/start/depart/wait/kind), legs
// (mode/walkMin/driveMin/effectiveMin/chosenBy/times), totalTravelMin,
// daySlackMin and the `quality` label. Ties included: both engines enumerate
// permutations of the same lexicographically sorted stops and require STRICT
// improvement, so both land on the lexicographically smallest optimum.

import fc from "fast-check";
import { compileFromDoc } from "../../constraints/compile";
import { planDay } from "../../schedule/schedule";
import type { DayPlan } from "../../schedule/types";
import type { TripDay, TripStop } from "../../store/types";
import { buildProblem } from "../problem";
import { isLaunchMode, isOldClassDay } from "../exhaustive";
import { solveWithAlns } from "../alnsEngine";
import type { EngineProblem, SolveOptions } from "../types";
import {
  NO_HOURS_IDS,
  docOf,
  legacyDay,
  matricesFor,
  settingsOf,
  tripStop,
} from "../__fixtures__/tripFixtures";

/** No search at all: the floor is deterministic and rng-free, and pinning the
 * budget to zero proves the differential does not depend on how fast this
 * machine is. */
const OPTS: SolveOptions = { seed: 12345, timeBudgetMs: 0, iterCap: 1 };

function assertSameDay(engine: DayPlan, old: DayPlan, where: string): void {
  if (old.status !== "ok") throw new Error(`${where}: oracle not ok`);
  expect(engine.status).toBe("ok");
  if (engine.status !== "ok") return;
  expect(engine.order).toEqual(old.order);
  expect(engine.entries).toEqual(old.entries);
  expect(engine.legs).toEqual(old.legs);
  expect(engine.totalTravelMin).toBe(old.totalTravelMin);
  expect(engine.daySlackMin).toBe(old.daySlackMin);
  expect(engine.quality).toBe(old.quality);
}

type Coverage = {
  days: number;
  compared: number;
  withAnchor: number;
  withPrecedence: number;
  maxStops: number;
};

async function compare(doc: ReturnType<typeof docOf>, cover: Coverage): Promise<void> {
  const matrices = await matricesFor(doc);
  const problem: EngineProblem = buildProblem(doc, compileFromDoc(doc), matrices);
  const launch = isLaunchMode(problem);
  expect(launch).toBe(true);

  const solution = solveWithAlns(problem, OPTS);
  const settings = settingsOf(doc);

  for (let i = 0; i < doc.days.length; i++) {
    cover.days++;
    // Guard against a vacuous pass: if the generator ever drifts out of the old
    // class the floor would silently stop applying and this file would compare
    // an ALNS answer with an optimum.
    expect(isOldClassDay(problem, i, launch)).toBe(true);

    const oracle = planDay(legacyDay(doc, i), matrices[i], settings);
    if (oracle.status !== "ok") continue; // the old engine's dead ends are E5's conflicts
    cover.compared++;
    cover.maxStops = Math.max(cover.maxStops, doc.days[i].stops.length);
    if (doc.days[i].stops.some((s) => s.anchor)) cover.withAnchor++;
    if ((doc.days[i].precedence ?? []).length > 0) cover.withPrecedence++;
    assertSameDay(solution.days[i], oracle, `day ${i}`);
  }
}

// ---------------------------------------------------------------------------
// Generated days
// ---------------------------------------------------------------------------

const MAX_DAYS = 2;
// 6 keeps 720 permutations per run — both engines brute-force every one of them,
// twice per generated case, 50+ times. The 8- and 9-stop widths (40 320 and
// 362 880 permutations) are exercised once each, explicitly, below.
const MAX_PER_DAY = 6;
const POOL = MAX_DAYS * MAX_PER_DAY;

const docArb = () =>
  fc
    .record({
      numDays: fc.integer({ min: 1, max: MAX_DAYS }),
      counts: fc.array(fc.integer({ min: 1, max: MAX_PER_DAY }), {
        minLength: MAX_DAYS,
        maxLength: MAX_DAYS,
      }),
      ids: fc.shuffledSubarray(NO_HOURS_IDS, { minLength: POOL, maxLength: POOL }),
      durations: fc.array(fc.integer({ min: 15, max: 70 }), {
        minLength: POOL,
        maxLength: POOL,
      }),
      dayStarts: fc.array(fc.integer({ min: 8 * 60, max: 10 * 60 }), {
        minLength: MAX_DAYS,
        maxLength: MAX_DAYS,
      }),
      daySpans: fc.array(fc.integer({ min: 420, max: 720 }), {
        minLength: MAX_DAYS,
        maxLength: MAX_DAYS,
      }),
      anchorAt: fc.array(fc.integer({ min: -1, max: MAX_PER_DAY - 1 }), {
        minLength: MAX_DAYS,
        maxLength: MAX_DAYS,
      }),
      anchorOffset: fc.array(fc.integer({ min: 90, max: 330 }), {
        minLength: MAX_DAYS,
        maxLength: MAX_DAYS,
      }),
      precRolls: fc.array(fc.integer({ min: 0, max: 99 }), {
        minLength: MAX_DAYS * MAX_PER_DAY * MAX_PER_DAY,
        maxLength: MAX_DAYS * MAX_PER_DAY * MAX_PER_DAY,
      }),
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
        // Pairs consistent with the day's own list order, so they are always
        // satisfiable and both engines are being asked the same question.
        const precedence: NonNullable<TripDay["precedence"]> = [];
        for (let i = 0; i < count; i++) {
          for (let j = i + 1; j < count; j++) {
            const roll = r.precRolls[d * MAX_PER_DAY * MAX_PER_DAY + i * MAX_PER_DAY + j];
            if (roll < 20) precedence.push({ beforeId: stops[i].id, afterId: stops[j].id });
          }
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
      return docOf(days);
    });

describe("E5a differential: the engine reproduces the old solver's optimum exactly", () => {
  it("holds over generated fixture-city days (<=6 stops, anchors, precedence)", async () => {
    const cover: Coverage = {
      days: 0,
      compared: 0,
      withAnchor: 0,
      withPrecedence: 0,
      maxStops: 0,
    };
    await fc.assert(
      fc.asyncProperty(docArb(), async (doc) => {
        await compare(doc, cover);
        return true;
      }),
      { numRuns: 60, seed: 5001 }
    );

    expect(cover.days).toBeGreaterThan(0);
    expect(cover.compared / cover.days).toBeGreaterThan(0.6);
    expect(cover.withAnchor).toBeGreaterThan(0);
    expect(cover.withPrecedence).toBeGreaterThan(0);
    expect(cover.maxStops).toBeGreaterThanOrEqual(5);
  }, 300_000);

  it("holds at the exhaustive width the old solver was built for (8 flexible stops)", async () => {
    const ids = NO_HOURS_IDS.slice(0, 8);
    const doc = docOf([
      {
        date: "2026-07-06",
        dayStartMin: 9 * 60,
        dayEndMin: 21 * 60,
        stops: ids.map((id, i) => tripStop(id, 30 + (i % 3) * 10)),
      },
    ]);
    const cover: Coverage = { days: 0, compared: 0, withAnchor: 0, withPrecedence: 0, maxStops: 0 };
    await compare(doc, cover);
    expect(cover.compared).toBe(1);
  }, 300_000);

  // The widest run either engine will ever brute-force: 9! = 362 880 orderings,
  // enumerated twice (once per engine) and required to agree to the minute.
  it("holds at the maximum exhaustive width: 9 flexible stops in ONE run", async () => {
    const ids = NO_HOURS_IDS.slice(0, 9);
    const doc = docOf([
      {
        date: "2026-07-07",
        dayStartMin: 9 * 60,
        dayEndMin: 22 * 60,
        stops: ids.map((id, i) => tripStop(id, 20 + (i % 4) * 5)),
      },
    ]);
    const cover: Coverage = { days: 0, compared: 0, withAnchor: 0, withPrecedence: 0, maxStops: 0 };
    await compare(doc, cover);
    expect(cover.compared).toBe(1);
  }, 300_000);

  it("holds with 9 flexible stops split across an anchor", async () => {
    const ids = NO_HOURS_IDS.slice(0, 10);
    const stops = ids.map((id) => tripStop(id, 25));
    stops[4] = tripStop(ids[4], 25, 13 * 60); // 9 flexible + 1 anchor, runs of 4 and 5
    const doc = docOf([
      {
        date: "2026-07-09",
        dayStartMin: 9 * 60,
        dayEndMin: 22 * 60,
        stops,
      },
    ]);
    const cover: Coverage = { days: 0, compared: 0, withAnchor: 0, withPrecedence: 0, maxStops: 0 };
    await compare(doc, cover);
    expect(cover.compared).toBe(1);
    expect(cover.withAnchor).toBe(1);
  }, 300_000);

  it("holds when the day TOTAL exceeds maxExhaustive but no RUN does (audit finding 2)", async () => {
    // 12 flexible stops around two anchors: runs of 5, 4, 3 — every run within
    // the old solver's per-RUN exhaustive width, so the old solver was OPTIMAL
    // here. Gating on the day total (12 > 9) routed this day to ALNS and
    // churned its plan on the engine swap; the per-run gate keeps it on the
    // exhaustive floor, and this asserts exact equality with the old optimum.
    const ids = NO_HOURS_IDS.slice(0, 14);
    const stops = ids.map((id) => tripStop(id, 20));
    stops[5] = tripStop(ids[5], 20, 12 * 60 + 30); // anchor after run of 5
    stops[10] = tripStop(ids[10], 20, 17 * 60); // anchor after run of 4; 3 after
    const doc = docOf([
      { date: "2026-07-10", dayStartMin: 9 * 60, dayEndMin: 22 * 60, stops },
    ]);
    const cover: Coverage = { days: 0, compared: 0, withAnchor: 0, withPrecedence: 0, maxStops: 0 };
    await compare(doc, cover);
    expect(cover.compared).toBe(1);
    expect(cover.withAnchor).toBe(1);
  }, 300_000);

  it("an empty day matches the old path's empty plan", async () => {
    const doc = docOf([
      { date: "2026-07-08", dayStartMin: 9 * 60, dayEndMin: 20 * 60, stops: [] },
    ]);
    const problem = buildProblem(doc, compileFromDoc(doc), await matricesFor(doc));
    const solution = solveWithAlns(problem, OPTS);
    expect(solution.days[0]).toEqual({
      status: "ok",
      order: [],
      entries: [],
      legs: [],
      quality: "optimal",
      totalTravelMin: 0,
      daySlackMin: 11 * 60,
    });
  });
});
