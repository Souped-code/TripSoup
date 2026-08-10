// E5a: "same seed -> same result" is the property that REPLACED recompute
// determinism when E4 started persisting plans. If it does not hold, a stored
// plan and a re-plan of the same doc disagree, `put()`'s solveHash invariant
// starts failing in CI, and a share link stops matching what its owner saw.
//
// The engine's contract, precisely:
//   * (problem, seed, iterCap)      -> byte-identical, always;
//   * (problem, seed, timeBudgetMs) -> byte-identical on any machine fast enough
//     to exhaust the budget-derived iteration cap (the wall clock is a safety
//     net, and a run it cuts short is anytime-best, not reproducible).
// These tests pin `iterCap` for exactly that reason: a determinism test that
// depends on how loaded the CI box is would be a flake generator.

import { solveWithAlns } from "../alnsEngine";
import type { EngineProblem, SolveOptions } from "../types";
import {
  docOf,
  everyDay,
  problemFor,
  tripStop,
  tripStopWithHours,
  withHours,
} from "../__fixtures__/tripFixtures";

/** A trip the exhaustive floor CANNOT own — hours bind on two days, so the ALNS
 * (and therefore the rng) is genuinely in play. */
async function richProblem(): Promise<EngineProblem> {
  const doc = docOf([
    {
      date: "2026-07-07",
      dayStartMin: 9 * 60,
      dayEndMin: 20 * 60,
      stops: [
        tripStop("fx-01", 40),
        withHours(tripStop("fx-12", 45), everyDay(9 * 60, 11 * 60)),
        tripStop("fx-18", 50),
        tripStopWithHours("fx-09", 60),
        tripStop("fx-11", 30),
      ],
    },
    {
      date: "2026-07-08",
      dayStartMin: 9 * 60,
      dayEndMin: 19 * 60,
      stops: [
        tripStopWithHours("fx-16", 60),
        tripStop("fx-05", 45),
        tripStop("fx-07", 30, 15 * 60),
        tripStop("fx-19", 40),
      ],
    },
  ]);
  return problemFor(doc);
}

const RUNS = 20;

describe("E5a determinism", () => {
  it("the same (problem, seed, iterCap) gives byte-identical solutions, 20x", async () => {
    const problem = await richProblem();
    const opts: SolveOptions = { seed: 31337, timeBudgetMs: 60_000, iterCap: 800 };
    const first = JSON.stringify(solveWithAlns(problem, opts));
    for (let i = 1; i < RUNS; i++) {
      expect(JSON.stringify(solveWithAlns(problem, opts))).toBe(first);
    }
    // Guard against a vacuous pass: the run must actually have produced a plan.
    const solution = solveWithAlns(problem, opts);
    expect(solution.days).toHaveLength(2);
    expect(solution.days[0].status).toBe("ok");
    expect(Object.keys(solution.assignment)).toHaveLength(9);
  }, 300_000);

  it("holds for several seeds independently (and different seeds may differ)", async () => {
    const problem = await richProblem();
    const results = new Map<number, string>();
    for (const seed of [1, 2, 7, 4242]) {
      const opts: SolveOptions = { seed, timeBudgetMs: 60_000, iterCap: 500 };
      const a = JSON.stringify(solveWithAlns(problem, opts));
      const b = JSON.stringify(solveWithAlns(problem, opts));
      expect(b).toBe(a);
      results.set(seed, a);
    }
    // Every seed must still produce a complete, well-formed answer — differing
    // between seeds is allowed, losing a stop is not.
    for (const json of results.values()) {
      const solution = JSON.parse(json) as ReturnType<typeof solveWithAlns>;
      expect(Object.keys(solution.assignment)).toHaveLength(9);
    }
  }, 300_000);

  it("the exhaustive floor is rng-free: the seed cannot change an old-class day", async () => {
    const doc = docOf([
      {
        date: "2026-07-07",
        dayStartMin: 9 * 60,
        dayEndMin: 20 * 60,
        stops: [
          tripStop("fx-01", 30),
          tripStop("fx-02", 30),
          tripStop("fx-13", 30),
          tripStop("fx-20", 30),
          tripStop("fx-05", 30),
        ],
      },
    ]);
    const problem = await problemFor(doc);
    const seeds = [0, 1, 99, 123456];
    const answers = seeds.map((seed) =>
      JSON.stringify(solveWithAlns(problem, { seed, timeBudgetMs: 500, iterCap: 200 }).days)
    );
    expect(new Set(answers).size).toBe(1);
  }, 120_000);
});
