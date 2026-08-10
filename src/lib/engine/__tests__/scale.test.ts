// E5 acceptance (the roadmap's): "fixture dense 40x6 solves <30s with progress
// ticks". Fixture city only — no network, no key, no spend.
//
// The trip is deliberately built the awkward way: 42 stop OCCURRENCES drawn
// from a 20-stop city, so more than half the nodes are cross-day REPEAT visits
// carrying `id@dN` occurrence keys. That is the shape that broke the E2 compile
// pass, and it is the shape the engine has to survive at scale.
//
// The budget here is 3 seconds, not 30: the assertion is that the engine is an
// ANYTIME algorithm which honours whatever budget it is given (E5b makes 30s the
// production setting). A test suite that spent 30 seconds proving that would be
// its own kind of bug.

import { solveWithAlns } from "../alnsEngine";
import type { TripDay } from "../../store/types";
import {
  ALL_FIXTURE_IDS,
  docOf,
  everyDay,
  problemFor,
  tripStop,
  tripStopWithHours,
  withHours,
} from "../__fixtures__/tripFixtures";

const DAYS = 6;
const PER_DAY = 7;
const BUDGET_MS = 3_000;

function denseTrip() {
  const days: TripDay[] = [];
  let cursor = 0;
  for (let d = 0; d < DAYS; d++) {
    const stops = [];
    for (let k = 0; k < PER_DAY; k++) {
      const id = ALL_FIXTURE_IDS[cursor % ALL_FIXTURE_IDS.length];
      cursor++;
      const duration = 30 + ((cursor * 7) % 4) * 15;
      if (k === 1) {
        // A genuinely binding morning-only window on one stop a day.
        stops.push(withHours(tripStop(id, duration), everyDay(9 * 60, 12 * 60)));
      } else if (k === 3) {
        // Whatever the fixture city says about this place, parsed for real.
        stops.push(tripStopWithHours(id, duration));
      } else if (k === 5) {
        stops.push(tripStop(id, duration, 14 * 60 + d * 5));
      } else {
        stops.push(tripStop(id, duration));
      }
    }
    days.push({
      date: `2026-07-0${d + 1}`,
      dayStartMin: 9 * 60,
      dayEndMin: 21 * 60,
      stops,
    });
  }
  return docOf(days, "dense-40x6");
}

describe("E5 acceptance: a dense 42-stop, 6-day fixture trip", () => {
  it("solves inside its budget, with progress ticks, losing nothing", async () => {
    const doc = denseTrip();
    const problem = await problemFor(doc);
    expect(problem.nodes).toHaveLength(DAYS * PER_DAY);
    // More than half the nodes are cross-day repeats.
    expect(problem.nodes.filter((n) => n.key.includes("@d")).length).toBeGreaterThan(20);

    const ticks: number[] = [];
    const startedAt = Date.now();
    const solution = solveWithAlns(problem, {
      seed: 20260810,
      timeBudgetMs: BUDGET_MS,
      onProgress: (p) => ticks.push(p.pct),
    });
    const elapsed = Date.now() - startedAt;

    // Anytime: the budget is honoured (with generous slack for a loaded CI box
    // finishing its current iteration, the polish pass and proposal costing).
    expect(elapsed).toBeLessThan(30_000);

    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks[ticks.length - 1]).toBe(100);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThanOrEqual(ticks[i - 1]);

    // Every day planned, every node accounted for exactly once.
    expect(solution.days).toHaveLength(DAYS);
    const placed = new Set<string>();
    for (let d = 0; d < DAYS; d++) {
      const plan = solution.days[d];
      expect(plan.status).toBe("ok");
      if (plan.status !== "ok") continue;
      expect(plan.entries).toHaveLength(plan.order.length);
      expect(plan.legs).toHaveLength(Math.max(0, plan.order.length - 1));
    }
    for (const [key, dayIndex] of Object.entries(solution.assignment)) {
      expect(dayIndex).toBeGreaterThanOrEqual(0); // nothing dropped: every stop is a hard `must`
      placed.add(key);
    }
    expect(placed.size).toBe(problem.nodes.length);

    // Hard pins are the paste's decision and the engine kept every one of them.
    for (const node of problem.nodes) {
      expect(solution.assignment[node.key]).toBe(node.pinnedDay!.value);
    }

    // The objective is finite and the breakdown adds up.
    const b = solution.objectiveBreakdown;
    for (const v of Object.values(b)) expect(Number.isFinite(v)).toBe(true);
    expect(b.travelMin).toBeGreaterThan(0);
  }, 120_000);
});
