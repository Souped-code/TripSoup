// Solver core — §2 (LOCKED). Pure, no I/O.
// optimize(segment, matrix, settings) -> { order, schedule, quality } | infeasible | rejected
//
// - <= maxExhaustive (9) flexible stops: exhaustive permutation search, optimal.
// - <= maxHeuristic (15): nearest-neighbour seed + 2-opt, labelled "heuristic".
// - more: rejected with an actionable error.
// - Deterministic: candidates are processed in lexicographic stop-id order and
//   improvements must be strict, so ties resolve to the lexicographically
//   smallest order. Input array order never affects the result.

import type { Settings } from "../maps/types";
import { effectiveMinutes } from "./effectiveMatrix";
import type {
  EffectiveMatrix,
  ScheduleEntry,
  Segment,
  SolveResult,
  SolverStop,
} from "./types";

type Evaluation = {
  feasible: boolean;
  totalTravelMin: number;
  endViolationMin: number; // > 0 when the end boundary is missed
  schedule: ScheduleEntry[];
};

function evaluateOrder(
  order: SolverStop[],
  segment: Segment,
  matrix: EffectiveMatrix,
  settings: Settings
): Evaluation {
  const leg = (fromId: string, toId: string): number => {
    const l = matrix[fromId]?.[toId];
    if (!l) throw new Error(`effective matrix missing pair ${fromId} -> ${toId}`);
    return effectiveMinutes(l, settings);
  };

  let clock = segment.startAtMin;
  let travel = 0;
  let prevId = segment.startStopId;
  const schedule: ScheduleEntry[] = [];

  for (const stop of order) {
    if (prevId !== null) {
      const t = leg(prevId, stop.id);
      clock += t;
      travel += t;
    }
    const arriveMin = clock;
    const departMin = arriveMin + stop.durationMin;
    schedule.push({ stopId: stop.id, arriveMin, departMin });
    clock = departMin;
    prevId = stop.id;
  }

  if (segment.endStopId !== null && prevId !== null) {
    const t = leg(prevId, segment.endStopId);
    clock += t;
    travel += t;
  }

  const endViolationMin = Math.max(0, clock - segment.endByMin);
  return { feasible: endViolationMin === 0, totalTravelMin: travel, endViolationMin, schedule };
}

// Lexicographic permutation enumeration (sorted ids first) so the first-found
// optimum among ties is the lexicographically smallest order.
function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

function sortedStops(stops: SolverStop[]): SolverStop[] {
  return [...stops].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function infeasibleResult(segment: Segment, bestViolation: number): SolveResult {
  const constraint =
    segment.endStopId !== null
      ? `anchor-start:${segment.endStopId}`
      : "day-window";
  const what =
    segment.endStopId !== null
      ? `the ${segment.endStopId} anchor's start time`
      : "the end of the day window";
  return {
    status: "infeasible",
    constraint,
    violatedByMin: bestViolation,
    message: `No ordering fits: the best one misses ${what} by ${Math.ceil(bestViolation)} min. Drop a stop, shorten a visit, or move the boundary.`,
  };
}

export function optimize(
  segment: Segment,
  matrix: EffectiveMatrix,
  settings: Settings
): SolveResult {
  const n = segment.stops.length;

  if (n > settings.maxHeuristic) {
    return {
      status: "rejected",
      message: `Segment has ${n} flexible stops (max ${settings.maxHeuristic}). Split the segment or add an anchor.`,
    };
  }

  if (n === 0) {
    const evalEmpty = evaluateOrder([], segment, matrix, settings);
    return evalEmpty.feasible
      ? {
          status: "ok",
          order: [],
          schedule: [],
          quality: "optimal",
          totalTravelMin: evalEmpty.totalTravelMin,
        }
      : infeasibleResult(segment, evalEmpty.endViolationMin);
  }

  return n <= settings.maxExhaustive
    ? solveExhaustive(segment, matrix, settings)
    : solveHeuristic(segment, matrix, settings);
}

function solveExhaustive(
  segment: Segment,
  matrix: EffectiveMatrix,
  settings: Settings
): SolveResult {
  let best: { order: SolverStop[]; ev: Evaluation } | null = null;
  let minViolation = Infinity;

  for (const order of permutations(sortedStops(segment.stops))) {
    const ev = evaluateOrder(order, segment, matrix, settings);
    if (ev.feasible) {
      if (best === null || ev.totalTravelMin < best.ev.totalTravelMin) {
        best = { order, ev };
      }
    } else {
      minViolation = Math.min(minViolation, ev.endViolationMin);
    }
  }

  if (best === null) return infeasibleResult(segment, minViolation);
  return {
    status: "ok",
    order: best.order.map((s) => s.id),
    schedule: best.ev.schedule,
    quality: "optimal",
    totalTravelMin: best.ev.totalTravelMin,
  };
}

function solveHeuristic(
  segment: Segment,
  matrix: EffectiveMatrix,
  settings: Settings
): SolveResult {
  const stops = sortedStops(segment.stops);
  const eff = (a: string, b: string) => effectiveMinutes(matrix[a][b], settings);

  // Nearest-neighbour seed. With a start anchor, chain from it; without one the
  // first stop is free (no inbound leg), so try each candidate first stop and
  // keep the best chain. Ties resolve to earlier (lexicographic) candidates.
  const chainFrom = (first: SolverStop | null): SolverStop[] => {
    const remaining = stops.filter((s) => s !== first);
    const chain = first ? [first] : [];
    let cursor = first ? first.id : segment.startStopId;
    while (remaining.length > 0) {
      let pick = 0;
      if (cursor !== null) {
        for (let i = 1; i < remaining.length; i++) {
          if (eff(cursor, remaining[i].id) < eff(cursor, remaining[pick].id)) pick = i;
        }
      }
      const next = remaining.splice(pick, 1)[0];
      chain.push(next);
      cursor = next.id;
    }
    return chain;
  };

  let order: SolverStop[];
  if (segment.startStopId !== null) {
    order = chainFrom(null);
  } else {
    order = stops.slice();
    let orderScore = Infinity;
    for (const first of stops) {
      const candidate = chainFrom(first);
      const score = evaluateOrder(candidate, segment, matrix, settings).totalTravelMin;
      if (score < orderScore) {
        order = candidate;
        orderScore = score;
      }
    }
  }

  // 2-opt refinement: reverse [i..j] while it strictly improves total travel.
  let improved = true;
  let bestEv = evaluateOrder(order, segment, matrix, settings);
  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const candidate = [
          ...order.slice(0, i),
          ...order.slice(i, j + 1).reverse(),
          ...order.slice(j + 1),
        ];
        const ev = evaluateOrder(candidate, segment, matrix, settings);
        if (ev.totalTravelMin < bestEv.totalTravelMin) {
          order = candidate;
          bestEv = ev;
          improved = true;
        }
      }
    }
  }

  if (!bestEv.feasible) return infeasibleResult(segment, bestEv.endViolationMin);
  return {
    status: "ok",
    order: order.map((s) => s.id),
    schedule: bestEv.schedule,
    quality: "heuristic",
    totalTravelMin: bestEv.totalTravelMin,
  };
}
