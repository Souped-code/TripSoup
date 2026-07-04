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
  PrecedencePair,
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

// True iff every precedence pair (beforeId visited before afterId) holds in this
// order. Pairs whose ids are absent are ignored (defensive; callers pre-filter).
function orderSatisfiesPrecedence(orderIds: string[], pairs: PrecedencePair[]): boolean {
  if (pairs.length === 0) return true;
  const pos = new Map<string, number>();
  orderIds.forEach((id, i) => pos.set(id, i));
  for (const p of pairs) {
    const b = pos.get(p.beforeId);
    const a = pos.get(p.afterId);
    if (b === undefined || a === undefined) continue;
    if (b > a) return false;
  }
  return true;
}

// Cycle detection over the precedence graph (beforeId -> afterId). Returns the
// back-edge that closes a cycle (the "closing pair") or null if acyclic. Nodes
// and adjacency are visited in sorted id order so the reported pair is stable.
function findPrecedenceCycle(ids: string[], pairs: PrecedencePair[]): PrecedencePair | null {
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const p of pairs) adj.get(p.beforeId)?.push(p.afterId);
  for (const list of adj.values()) list.sort();
  const sortedIds = [...ids].sort();

  const state = new Map<string, 0 | 1 | 2>(); // 0 unseen, 1 on-stack, 2 done
  for (const id of sortedIds) state.set(id, 0);
  let closing: PrecedencePair | null = null;

  const dfs = (u: string): boolean => {
    state.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      if (state.get(v) === 1) {
        closing = { beforeId: u, afterId: v };
        return true;
      }
      if (state.get(v) === 0 && dfs(v)) return true;
    }
    state.set(u, 2);
    return false;
  };

  for (const id of sortedIds) {
    if (state.get(id) === 0 && dfs(id)) return closing;
  }
  return null;
}

// The lexicographically-smallest precedence pair that this order violates.
function firstViolatedPair(orderIds: string[], pairs: PrecedencePair[]): PrecedencePair {
  const pos = new Map<string, number>();
  orderIds.forEach((id, i) => pos.set(id, i));
  const violated = pairs.filter((p) => {
    const b = pos.get(p.beforeId);
    const a = pos.get(p.afterId);
    return b !== undefined && a !== undefined && b > a;
  });
  violated.sort((x, y) =>
    x.beforeId !== y.beforeId
      ? x.beforeId < y.beforeId
        ? -1
        : 1
      : x.afterId < y.afterId
        ? -1
        : x.afterId > y.afterId
          ? 1
          : 0
  );
  return violated[0] ?? pairs[0];
}

function precedenceInfeasible(pair: PrecedencePair, message: string): SolveResult {
  return {
    status: "infeasible",
    constraint: `precedence:${pair.beforeId}->${pair.afterId}`,
    violatedByMin: 0,
    message,
  };
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
  settings: Settings,
  precedence: PrecedencePair[] = []
): SolveResult {
  const n = segment.stops.length;

  if (n > settings.maxHeuristic) {
    return {
      status: "rejected",
      message: `Segment has ${n} flexible stops (max ${settings.maxHeuristic}). Split the segment or add an anchor.`,
    };
  }

  // Only keep precedence pairs internal to this segment; the day layer routes
  // cross-segment / cross-day pairs elsewhere.
  const stopIds = new Set(segment.stops.map((s) => s.id));
  const pairs = precedence.filter((p) => stopIds.has(p.beforeId) && stopIds.has(p.afterId));

  // A cycle is unorderable regardless of times — name the closing pair.
  if (pairs.length > 0) {
    const cycle = findPrecedenceCycle([...stopIds], pairs);
    if (cycle) {
      return precedenceInfeasible(
        cycle,
        `You asked for ${cycle.beforeId} before ${cycle.afterId}, but the precedence rules loop back on themselves — that ordering can't exist.`
      );
    }
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
    ? solveExhaustive(segment, matrix, settings, pairs)
    : solveHeuristic(segment, matrix, settings, pairs);
}

function solveExhaustive(
  segment: Segment,
  matrix: EffectiveMatrix,
  settings: Settings,
  pairs: PrecedencePair[]
): SolveResult {
  // best = optimum among precedence-satisfying orders (the answer we return).
  // bestAny = optimum ignoring precedence, kept only to diagnose infeasibility.
  let best: { order: SolverStop[]; ev: Evaluation } | null = null;
  let bestAny: { order: SolverStop[]; ev: Evaluation } | null = null;
  let minViolation = Infinity;

  for (const order of permutations(sortedStops(segment.stops))) {
    const ev = evaluateOrder(order, segment, matrix, settings);
    const satisfies = orderSatisfiesPrecedence(
      order.map((s) => s.id),
      pairs
    );
    if (ev.feasible) {
      if (bestAny === null || ev.totalTravelMin < bestAny.ev.totalTravelMin) {
        bestAny = { order, ev };
      }
      if (satisfies && (best === null || ev.totalTravelMin < best.ev.totalTravelMin)) {
        best = { order, ev };
      }
    } else if (satisfies) {
      minViolation = Math.min(minViolation, ev.endViolationMin);
    }
  }

  if (best !== null) {
    return {
      status: "ok",
      order: best.order.map((s) => s.id),
      schedule: best.ev.schedule,
      quality: "optimal",
      totalTravelMin: best.ev.totalTravelMin,
    };
  }

  // No precedence-satisfying feasible order. If some order IS feasible once
  // precedence is dropped, then precedence is the cause — name the pair the
  // natural optimum breaks. Otherwise it is a plain time-window failure.
  if (pairs.length > 0 && bestAny !== null) {
    const pair = firstViolatedPair(
      bestAny.order.map((s) => s.id),
      pairs
    );
    return precedenceInfeasible(
      pair,
      `You asked for ${pair.beforeId} before ${pair.afterId}, but ${pair.afterId}'s timing makes that ordering impossible here.`
    );
  }
  return infeasibleResult(segment, minViolation);
}

function solveHeuristic(
  segment: Segment,
  matrix: EffectiveMatrix,
  settings: Settings,
  pairs: PrecedencePair[]
): SolveResult {
  const stops = sortedStops(segment.stops);
  const eff = (a: string, b: string) => effectiveMinutes(matrix[a][b], settings);

  // Precedence predecessors within this segment. A stop is placement-eligible
  // only once all its predecessors are already placed (topological greedy NN).
  const preds = new Map<string, Set<string>>();
  for (const s of stops) preds.set(s.id, new Set());
  for (const p of pairs) preds.get(p.afterId)?.add(p.beforeId);
  const eligible = (id: string, placed: Set<string>): boolean => {
    for (const b of preds.get(id) ?? []) if (!placed.has(b)) return false;
    return true;
  };

  // Nearest-neighbour seed. With a start anchor, chain from it; without one the
  // first stop is free (no inbound leg), so try each candidate first stop and
  // keep the best chain. Ties resolve to earlier (lexicographic) candidates.
  // With precedence, only placement-eligible stops are considered at each step.
  const chainFrom = (first: SolverStop | null): SolverStop[] => {
    const remaining = stops.filter((s) => s !== first);
    const chain = first ? [first] : [];
    const placed = new Set(chain.map((s) => s.id));
    let cursor = first ? first.id : segment.startStopId;
    while (remaining.length > 0) {
      let pick = -1;
      for (let i = 0; i < remaining.length; i++) {
        if (!eligible(remaining[i].id, placed)) continue;
        if (pick === -1) {
          pick = i;
          continue;
        }
        if (cursor !== null && eff(cursor, remaining[i].id) < eff(cursor, remaining[pick].id)) {
          pick = i;
        }
      }
      if (pick === -1) pick = 0; // unreachable when acyclic; keeps progress
      const next = remaining.splice(pick, 1)[0];
      chain.push(next);
      placed.add(next.id);
      cursor = next.id;
    }
    return chain;
  };

  let order: SolverStop[];
  if (segment.startStopId !== null) {
    order = chainFrom(null);
  } else {
    // Seeds must themselves be precedence-eligible (no predecessors).
    const seeds = stops.filter((s) => (preds.get(s.id) ?? new Set()).size === 0);
    order = chainFrom(seeds[0] ?? null);
    let orderScore = evaluateOrder(order, segment, matrix, settings).totalTravelMin;
    for (const first of seeds) {
      const candidate = chainFrom(first);
      const score = evaluateOrder(candidate, segment, matrix, settings).totalTravelMin;
      if (score < orderScore) {
        order = candidate;
        orderScore = score;
      }
    }
  }

  // 2-opt refinement: reverse [i..j] while it strictly improves total travel
  // AND keeps every precedence pair satisfied.
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
        if (
          !orderSatisfiesPrecedence(
            candidate.map((s) => s.id),
            pairs
          )
        ) {
          continue;
        }
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
