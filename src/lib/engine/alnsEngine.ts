// E5a — the in-process ALNS adapter: the `SolverEngine` the spike won the right
// to be.
//
// It composes, in order:
//   ./solve       hybrid routing — exhaustive floor for old-class days, ALNS for
//                 everything richer, merged into one schedule
//   ./evaluate    the objective, applied to that schedule (the engine scores
//                 itself with the SAME function the tests score it with)
//   ./conflicts   every hard breach and every dropped stop, named
//   ./proposals   priced ways out of each conflict
//   ./assemble    DayPlan[], the LOCKED wire shape
//
// Determinism: the answer is a pure function of (problem, seed, iterCap), and of
// (problem, seed, timeBudgetMs) on any machine fast enough to exhaust the
// budget-derived cap. Nothing else — no clock reading reaches the output, and
// `Math.random` is never called anywhere under this module.

import { evaluate } from "./evaluate";
import { deriveConflicts, marginNotesForDay } from "./conflicts";
import { deriveProposals } from "./proposals";
import { assembleDay, dayViewOf } from "./assemble";
import { scheduleProblem } from "./solve";
import type { EngineProblem, EngineSolution, SolveOptions, SolverEngine } from "./types";

export const ENGINE_NAME = "alns-ts";
export const ENGINE_VERSION = "1.0.0";

export function solveWithAlns(problem: EngineProblem, opts: SolveOptions): EngineSolution {
  const onProgress = opts.onProgress;
  onProgress?.({ pct: 0, bestScore: 0, phase: "construct" });

  const { schedule, floorDays } = scheduleProblem(problem, opts);
  const evaluation = evaluate(problem, schedule);
  const conflicts = deriveConflicts(problem, evaluation, schedule);

  onProgress?.({ pct: 97, bestScore: evaluation.score, phase: "proposals" });
  const proposals = deriveProposals(problem, conflicts, opts);

  const days = problem.days.map((day, dayIndex) => {
    const { order, times } = dayViewOf(schedule.visits, dayIndex);
    return assembleDay(
      problem,
      dayIndex,
      order,
      floorDays[dayIndex] ? "optimal" : "heuristic",
      times,
      marginNotesForDay(conflicts, dayIndex)
    );
  });

  const assignment: Record<string, number> = {};
  for (const node of problem.nodes) assignment[node.key] = -1;
  for (const v of schedule.visits) assignment[v.key] = v.dayIndex;

  onProgress?.({ pct: 100, bestScore: evaluation.score, phase: "done" });

  return {
    days,
    assignment,
    objectiveBreakdown: evaluation.breakdown,
    conflicts,
    proposals,
    softViolations: evaluation.violations
      .filter((v) => !v.hard)
      .map((v) => ({
        code: v.code,
        detail: v.detail,
        stopIds: v.stopKeys,
        ...(v.dayIndex !== undefined ? { dayIndex: v.dayIndex } : {}),
        weight: v.weight,
      })),
  };
}

export const alnsEngine: SolverEngine = {
  name: ENGINE_NAME,
  version: ENGINE_VERSION,
  solve: solveWithAlns,
};
