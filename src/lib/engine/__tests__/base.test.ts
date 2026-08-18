// E6d — depot golden: the home base is REAL travel. Every day leaves it,
// returns to it, pays for both legs in the objective, and is bounded by them
// against the day window. A problem WITHOUT a base must remain byte-identical
// to its pre-depot self — that half of the contract is pinned by the whole
// pre-existing suite (determinism/differential/quality); this file pins the
// WITH-base half. Fixture city only — no network, no key, no spend.

import { HOME_BASE_KEY } from "../../maps/types";
import { solveWithAlns } from "../alnsEngine";
import { isLaunchMode, isOldClassDay } from "../exhaustive";
import {
  docOf,
  legacyDay,
  matricesFor,
  problemFor,
  settingsOf,
  tripStop,
} from "../__fixtures__/tripFixtures";
import { rescheduleDayWithBase } from "../../planEngine";
import type { TripDoc } from "../../store/types";
import type { DayPlan } from "../../schedule/types";

const OPTS = { seed: 4242, timeBudgetMs: 2000, iterCap: 3000 };

// A hotel in the old town, close to fx-01 (51.4545,-2.5879 area), far from
// nothing in particular — coordinates only matter through the metric formula.
const BASE: NonNullable<TripDoc["homeBase"]> = {
  id: "base-old-inn",
  name: "The Old Inn",
  location: { lat: 51.452, lng: -2.595 },
  source: "user",
};

const threeStopDay = () => ({
  date: "2026-07-07",
  dayStartMin: 540,
  dayEndMin: 1200,
  stops: [tripStop("fx-01", 30), tripStop("fx-02", 30), tripStop("fx-04", 30)],
});

const okPlan = (p: DayPlan): Extract<DayPlan, { status: "ok" }> => {
  if (p.status !== "ok") throw new Error(`expected ok plan, got ${p.status}`);
  return p;
};

describe("E6d depot semantics", () => {
  it("problem.base carries matrix-backed rows for on-day stops, estimates for cross-day ones", async () => {
    const doc: TripDoc = {
      ...docOf([threeStopDay(), { ...threeStopDay(), date: "2026-07-08", stops: [tripStop("fx-06", 30)] }]),
      homeBase: BASE,
    };
    const problem = await problemFor(doc);
    expect(problem.base).toBeDefined();
    const base = problem.base!;
    const idxOf = problem.travel.index;

    // day 0's own stops: real legs, positive minutes, both directions
    for (const key of problem.days[0].nodeKeys) {
      const i = idxOf[key];
      expect(base.outLegsByDay[0][i]).not.toBeNull();
      expect(base.backLegsByDay[0][i]).not.toBeNull();
      expect(base.outByDay[0][i]).toBeGreaterThan(0);
      expect(base.backByDay[0][i]).toBeGreaterThan(0);
    }
    // day 1's stop on day 0's rows: estimate only (null leg), still positive
    const crossKey = problem.days[1].nodeKeys[0];
    expect(base.outLegsByDay[0][idxOf[crossKey]]).toBeNull();
    expect(base.outByDay[0][idxOf[crossKey]]).toBeGreaterThan(0);
  });

  it("a based day gets baseLegs, a lead-shifted first arrival, and depot travel in the totals", async () => {
    const noBaseDoc = docOf([threeStopDay()]);
    const basedDoc: TripDoc = { ...docOf([threeStopDay()]), homeBase: BASE };

    const noBase = solveWithAlns(await problemFor(noBaseDoc), OPTS);
    const based = solveWithAlns(await problemFor(basedDoc), OPTS);

    const plain = okPlan(noBase.days[0]);
    const withBase = okPlan(based.days[0]);

    expect(plain.baseLegs).toBeUndefined();
    expect(withBase.baseLegs).toBeDefined();

    const lead = withBase.baseLegs!.lead;
    const back = withBase.baseLegs!.back;
    expect(lead.fromId).toBe(HOME_BASE_KEY);
    expect(back.toId).toBe(HOME_BASE_KEY);
    expect(lead.effectiveMin).toBeGreaterThan(0);
    expect(back.effectiveMin).toBeGreaterThan(0);

    // The first stop cannot start before day-open + lead-out, and it never
    // shows the lead as a wait (leave-late semantics).
    const first = withBase.entries[0];
    expect(first.startMin).toBeGreaterThanOrEqual(540 + lead.effectiveMin);
    expect(first.waitMin).toBe(0);
    expect(lead.departMin).toBe(first.arriveMin - lead.effectiveMin);

    // Depot legs count as travel — in the plan totals AND the objective.
    expect(withBase.totalTravelMin).toBeGreaterThan(plain.totalTravelMin);
    expect(based.objectiveBreakdown.travelMin).toBeGreaterThan(noBase.objectiveBreakdown.travelMin);

    // The return eats the slack: slack = dayEnd - lastDepart - back.
    const last = withBase.entries[withBase.entries.length - 1];
    expect(withBase.daySlackMin).toBeCloseTo(1200 - last.departMin - back.effectiveMin, 6);
    expect(back.arriveMin).toBeCloseTo(last.departMin + back.effectiveMin, 6);
  });

  it("the exhaustive floor prices the base too — optimal label kept, baseLegs attached", async () => {
    const doc: TripDoc = { ...docOf([threeStopDay()]), homeBase: BASE };
    const problem = await problemFor(doc);
    // still the old constraint class: the base rides the run mechanism
    expect(isLaunchMode(problem)).toBe(true);
    expect(isOldClassDay(problem, 0, true)).toBe(true);

    const solution = solveWithAlns(problem, OPTS);
    const plan = okPlan(solution.days[0]);
    expect(plan.quality).toBe("optimal");
    expect(plan.baseLegs).toBeDefined();
    expect(plan.entries[0].arriveMin).toBeCloseTo(540 + plan.baseLegs!.lead.effectiveMin, 6);
  });

  it("a return that cannot make the day window becomes a day-window conflict naming the base", async () => {
    // One 60-min stop; the VISIT fits the window (else the plain per-visit
    // overrun check fires instead and the depot form dedupes away — audit
    // finding 6's mirror guard), but the ride home cannot: with the far hotel
    // lead = back ≈ 24 effective minutes, so 564–624 fits 540–640 and the
    // 648 return misses it by ~8.
    const doc: TripDoc = {
      ...docOf([
        {
          date: "2026-07-07",
          dayStartMin: 540,
          dayEndMin: 640,
          stops: [tripStop("fx-01", 60)],
        },
      ]),
      homeBase: { ...BASE, location: { lat: 51.49, lng: -2.55 } }, // far hotel
    };
    const solution = solveWithAlns(await problemFor(doc), OPTS);
    const returnConflict = solution.conflicts.find(
      (c) => c.code === "day-window" && c.message.includes("returning to The Old Inn")
    );
    expect(returnConflict).toBeDefined();
    expect(returnConflict!.violatedByMin).toBeGreaterThan(0);
  });

  it("rescheduleDayWithBase shifts the day open and attaches depot legs; no base = plain rescheduleDay", async () => {
    const basedDoc: TripDoc = { ...docOf([threeStopDay()]), homeBase: BASE };
    const [matrix] = await matricesFor(basedDoc);
    const settings = settingsOf(basedDoc);
    const day = legacyDay(basedDoc, 0);
    const order = day.stops.map((s) => s.id);

    const plan = okPlan(rescheduleDayWithBase(basedDoc, day, order, matrix, settings, "manual"));
    expect(plan.baseLegs).toBeDefined();
    const lead = plan.baseLegs!.lead.effectiveMin;
    expect(lead).toBeGreaterThan(0);
    expect(plan.entries[0].arriveMin).toBeCloseTo(540 + lead, 6);
    expect(plan.quality).toBe("manual");

    const noBaseDoc = docOf([threeStopDay()]);
    const [plainMatrix] = await matricesFor(noBaseDoc);
    const plain = okPlan(
      rescheduleDayWithBase(noBaseDoc, legacyDay(noBaseDoc, 0), order, plainMatrix, settings, "manual")
    );
    expect(plain.baseLegs).toBeUndefined();
    expect(plain.entries[0].arriveMin).toBe(540);
  });

  it("compaction: a hard-breached day reads earliest-first, not right-shifted into idle waits", async () => {
    // Two clashing bookings force an unavoidable anchor-start breach; the
    // displayed times must compact toward day-open instead of paying hours of
    // idle wait to shave breach minutes (the 'waits 3h 59min' artifact).
    const doc = docOf([
      {
        date: "2026-07-07",
        dayStartMin: 540,
        dayEndMin: 1320,
        stops: [
          tripStop("fx-01", 60, 540),
          tripStop("fx-02", 60, 545),
          tripStop("fx-04", 60),
          tripStop("fx-06", 60),
        ],
      },
    ]);
    const solution = solveWithAlns(await problemFor(doc), OPTS);
    expect(solution.conflicts.some((c) => c.code === "anchor-start")).toBe(true);
    const plan = okPlan(solution.days[0]);
    // Earliest-greedy walk: the first entry sits at (or on) the day's open —
    // never hours later.
    expect(plan.entries[0].startMin).toBeLessThanOrEqual(545);
  });
});
