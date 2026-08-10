// E5a — the hybrid: route each day to the exhaustive floor or to the ALNS, then
// merge into ONE schedule.
//
// Extracted from the engine adapter so the proposal coster (./proposals) can
// re-schedule a patched problem through the SAME code path with a tiny
// iteration cap — a proposal priced by a different scheduler than the one that
// produced the plan would be a proposal priced by a different engine.

import { isLaunchMode, isOldClassDay, solveOldClassDay, type FloorResult } from "./exhaustive";
import { searchAlns } from "./search";
import type { EngineProblem, EngineSchedule, EngineVisit, SolveOptions } from "./types";

export type ScheduleResult = {
  schedule: EngineSchedule;
  /** Per day: did the exhaustive floor own it? Drives `DayPlan.quality`
   * ("optimal" vs "heuristic") — the label is a claim about the ORDERING and
   * must stay honest. */
  floorDays: boolean[];
  floor: Map<number, FloorResult>;
};

export function scheduleProblem(problem: EngineProblem, opts: SolveOptions): ScheduleResult {
  const launchMode = isLaunchMode(problem);
  const floorDays = problem.days.map((_, d) => isOldClassDay(problem, d, launchMode));

  const floor = new Map<number, FloorResult>();
  const visits: EngineVisit[] = [];
  for (let d = 0; d < problem.days.length; d++) {
    if (!floorDays[d]) continue;
    const result = solveOldClassDay(problem, d);
    floor.set(d, result);
    visits.push(...legacyWalk(problem, d, result.order));
  }

  const floorKeys = new Set<string>();
  for (const [, r] of floor) for (const k of r.order) floorKeys.add(k);

  const activeKeys = new Set(
    problem.nodes.filter((n) => !floorKeys.has(n.key)).map((n) => n.key)
  );

  let dropped: string[] = [];
  if (activeKeys.size > 0) {
    const searched = searchAlns(problem, {
      ...opts,
      activeKeys,
      progressFrom: 0,
      progressTo: 95,
    });
    visits.push(...searched.visits);
    dropped = [...searched.dropped];
  }

  visits.sort((a, b) => a.dayIndex - b.dayIndex || a.startMin - b.startMin || (a.key < b.key ? -1 : 1));
  return { schedule: { visits, dropped }, floorDays, floor };
}

/**
 * The old engine's fixed-order schedule walk (`rescheduleDay`), as times.
 * Duration is `typicalMin` — an old-class day's range is degenerate, so that IS
 * the doc's `durationMin`. A start never precedes its arrival even when a booked
 * time has already been missed (the miss becomes a conflict, not a negative
 * wait).
 */
export function legacyWalk(
  problem: EngineProblem,
  dayIndex: number,
  order: readonly string[]
): EngineVisit[] {
  const day = problem.days[dayIndex];
  const byKey = new Map(problem.nodes.map((n) => [n.key, n]));
  const { travel } = problem;
  const row = travel.minutesByDay[dayIndex];

  const out: EngineVisit[] = [];
  let clock = day.window.value.startMin;
  let prevKey: string | null = null;
  for (const key of order) {
    const node = byKey.get(key);
    if (!node) continue;
    const arriveMin =
      prevKey === null ? clock : clock + row[travel.index[prevKey] * travel.n + travel.index[key]];
    const startMin = node.isAnchor
      ? Math.max(node.window!.value.startMin, arriveMin)
      : arriveMin;
    const departMin = startMin + node.duration.value.typicalMin;
    out.push({ key, dayIndex, arriveMin, startMin, departMin });
    clock = departMin;
    prevKey = key;
  }
  return out;
}
