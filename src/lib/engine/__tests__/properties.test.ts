// E5a properties — the semantics the spike learned the expensive way, asserted
// over generated input rather than over one hand-picked day.
//
//  1. WAIT IS STRUCTURAL. The E1 evaluator's original `start - arrive`
//     definition let a solver report `arrive == start` and zero its own wait
//     penalty on a technicality. Both halves are pinned here: the plan's
//     reported waits ARE the structural quantity, and the objective cannot be
//     moved by a solver's self-reported arrival at all.
//  2. INPUT-ORDER INVARIANCE on old-class days without anchors — the old
//     solver's contract, preserved. (With anchors the doc's list order is
//     load-bearing by design: it is what splits the day into segments.)
//  3. PROGRESS is monotonic and ends at 100.

import fc from "fast-check";
import { compileFromDoc } from "../../constraints/compile";
import { evaluate } from "../evaluate";
import { buildProblem } from "../problem";
import { scheduleProblem } from "../solve";
import { solveWithAlns } from "../alnsEngine";
import type { EngineSchedule, SolveOptions } from "../types";
import type { TripDay, TripStop } from "../../store/types";
import {
  NO_HOURS_IDS,
  docOf,
  everyDay,
  matricesFor,
  problemFor,
  tripStop,
  tripStopWithHours,
  withHours,
} from "../__fixtures__/tripFixtures";

const OPTS: SolveOptions = { seed: 2026, timeBudgetMs: 1000, iterCap: 600 };

// Days with anchors and tight hours, so waits are actually produced.
const dayArb = () =>
  fc
    .record({
      count: fc.integer({ min: 2, max: 5 }),
      ids: fc.shuffledSubarray(NO_HOURS_IDS, { minLength: 5, maxLength: 5 }),
      durations: fc.array(fc.integer({ min: 20, max: 60 }), { minLength: 5, maxLength: 5 }),
      dayStart: fc.integer({ min: 8 * 60, max: 9 * 60 }),
      daySpan: fc.integer({ min: 480, max: 720 }),
      anchorAt: fc.integer({ min: -1, max: 4 }),
      anchorOffset: fc.integer({ min: 120, max: 360 }),
      hoursAt: fc.integer({ min: -1, max: 4 }),
      hoursOpen: fc.integer({ min: 0, max: 120 }),
      hoursSpan: fc.integer({ min: 90, max: 240 }),
    })
    .map((r) => {
      const dayStartMin = r.dayStart;
      const dayEndMin = dayStartMin + r.daySpan;
      const anchorIndex = r.anchorAt < r.count ? r.anchorAt : -1;
      const stops: TripStop[] = [];
      for (let k = 0; k < r.count; k++) {
        const base = tripStop(
          r.ids[k],
          r.durations[k],
          k === anchorIndex
            ? Math.min(dayStartMin + r.anchorOffset, dayEndMin - r.durations[k])
            : undefined
        );
        stops.push(
          k === r.hoursAt && k !== anchorIndex
            ? withHours(
                base,
                everyDay(dayStartMin + r.hoursOpen, dayStartMin + r.hoursOpen + r.hoursSpan)
              )
            : base
        );
      }
      const day: TripDay = { date: "2026-07-07", dayStartMin, dayEndMin, stops };
      return docOf([day]);
    });

describe("E5a property: wait is structural", () => {
  it("reported waits equal the structural definition, over generated days", async () => {
    let checked = 0;
    let sawWait = 0;
    await fc.assert(
      fc.asyncProperty(dayArb(), async (doc) => {
        const problem = buildProblem(doc, compileFromDoc(doc), await matricesFor(doc));
        const plan = solveWithAlns(problem, OPTS).days[0];
        if (plan.status !== "ok") return true;
        checked++;
        for (let i = 0; i < plan.entries.length; i++) {
          const e = plan.entries[i];
          expect(e.waitMin).toBe(e.startMin - e.arriveMin);
          expect(e.waitMin).toBeGreaterThanOrEqual(0);
          if (e.waitMin > 0) sawWait++;
          if (i === 0) {
            expect(e.arriveMin).toBe(doc.days[0].dayStartMin);
          } else {
            const leg = plan.legs[i - 1];
            expect(leg.fromId).toBe(plan.entries[i - 1].stopId);
            expect(leg.toId).toBe(e.stopId);
            // Structural: previous DEPARTURE plus the travel the matrix says.
            expect(e.arriveMin).toBeCloseTo(
              plan.entries[i - 1].departMin + leg.effectiveMin,
              9
            );
          }
        }
        return true;
      }),
      { numRuns: 60, seed: 7788 }
    );
    expect(checked).toBeGreaterThan(20);
    expect(sawWait).toBeGreaterThan(0); // the property would be empty without waits
  }, 300_000);

  it("a solver's self-reported arrival cannot move the objective", async () => {
    let checked = 0;
    await fc.assert(
      fc.asyncProperty(dayArb(), async (doc) => {
        const problem = buildProblem(doc, compileFromDoc(doc), await matricesFor(doc));
        const { schedule } = scheduleProblem(problem, OPTS);
        const honest = evaluate(problem, schedule);

        // The cheat the E1 build caught: report arriving exactly when you start,
        // so `start - arrive` is zero everywhere.
        const cheating: EngineSchedule = {
          visits: schedule.visits.map((v) => ({ ...v, arriveMin: v.startMin })),
          dropped: schedule.dropped,
        };
        const cheated = evaluate(problem, cheating);
        expect(cheated.breakdown).toEqual(honest.breakdown);
        expect(cheated.score).toBe(honest.score);

        // ...and the opposite cheat: claim to have arrived absurdly early. The
        // OBJECTIVE's travel/wait/compression terms are still untouched. (The
        // day SPAN and the day-window bound do read `arriveMin` — deliberately,
        // spike learning 3 — so a nonsense arrival can still make a day look
        // over-long. That is precisely why the priced wait term must not depend
        // on it as well.)
        const early: EngineSchedule = {
          visits: schedule.visits.map((v) => ({ ...v, arriveMin: v.startMin - 500 })),
          dropped: schedule.dropped,
        };
        const late: EngineSchedule = {
          visits: schedule.visits.map((v) => ({ ...v, arriveMin: v.startMin + 500 })),
          dropped: schedule.dropped,
        };
        for (const cheat of [early, late]) {
          const b = evaluate(problem, cheat).breakdown;
          expect(b.waitMin).toBe(honest.breakdown.waitMin);
          expect(b.travelMin).toBe(honest.breakdown.travelMin);
          expect(b.compressionPenalty).toBe(honest.breakdown.compressionPenalty);
          expect(b.dropPenalty).toBe(honest.breakdown.dropPenalty);
        }
        checked++;
        return true;
      }),
      { numRuns: 40, seed: 7789 }
    );
    expect(checked).toBeGreaterThan(20);
  }, 300_000);
});

describe("E5a property: input-order invariance on old-class days", () => {
  it("shuffling a doc's stop list does not change an anchor-free day's plan", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          ids: fc.shuffledSubarray(NO_HOURS_IDS, { minLength: 5, maxLength: 5 }),
          durations: fc.array(fc.integer({ min: 20, max: 60 }), { minLength: 5, maxLength: 5 }),
          perm: fc.shuffledSubarray([0, 1, 2, 3, 4], { minLength: 5, maxLength: 5 }),
        }),
        async (r) => {
          const make = (order: number[]) =>
            docOf([
              {
                date: "2026-07-07",
                dayStartMin: 9 * 60,
                dayEndMin: 21 * 60,
                stops: order.map((k) => tripStop(r.ids[k], r.durations[k])),
              },
            ]);
          const a = solveWithAlns(await problemFor(make([0, 1, 2, 3, 4])), OPTS).days[0];
          const b = solveWithAlns(await problemFor(make(r.perm)), OPTS).days[0];
          expect(b).toEqual(a);
          return true;
        }
      ),
      { numRuns: 30, seed: 7790 }
    );
  }, 300_000);
});

describe("E5a: progress", () => {
  it("is monotonic, starts at 0 and ends at 100", async () => {
    const doc = docOf([
      {
        date: "2026-07-07",
        dayStartMin: 9 * 60,
        dayEndMin: 20 * 60,
        stops: [
          tripStopWithHours("fx-03", 60),
          tripStop("fx-01", 30),
          tripStop("fx-14", 45),
          withHours(tripStop("fx-12", 45), everyDay(9 * 60, 11 * 60)),
          tripStop("fx-20", 30),
        ],
      },
    ]);
    const seen: Array<{ pct: number; bestScore: number; phase: string }> = [];
    solveWithAlns(await problemFor(doc), {
      seed: 5,
      timeBudgetMs: 1000,
      iterCap: 2000,
      onProgress: (p) => seen.push(p),
    });

    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[0].pct).toBe(0);
    expect(seen[seen.length - 1].pct).toBe(100);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].pct).toBeGreaterThanOrEqual(seen[i - 1].pct);
      expect(seen[i].pct).toBeLessThanOrEqual(100);
    }
    expect(seen.map((p) => p.phase)).toContain("construct");
    expect(seen[seen.length - 1].phase).toBe("done");
  }, 120_000);
});
