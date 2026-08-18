// E5a — THE HYBRID EXHAUSTIVE FLOOR.
//
// The roadmap's promise: "<=9-stop days keep the exhaustive path inside the
// adapter (hybrid) so the brute-force differential vs old optimum is
// guaranteed". This file is that path, and it is a deliberate REPRODUCTION of
// `src/lib/solver/solver.ts` + `src/lib/schedule/schedule.ts`'s planDay, not an
// approximation of them:
//
//   * the day is split into runs of flexible stops at its anchors, IN LIST
//     ORDER, exactly as splitRuns does;
//   * each run is enumerated exhaustively over its stops sorted by stop id, in
//     the same lexicographic order the old `permutations` generator yields;
//   * the objective is TOTAL TRAVEL ONLY (no wait, no compression, no pace) and
//     improvements must be STRICT, so ties resolve to the lexicographically
//     smallest order — the old solver's determinism contract, preserved;
//   * feasibility is "the run reaches its end boundary by endByMin", where the
//     boundary is the next anchor's start or the day's end.
//
// A day only reaches this path when its constraints are EXACTLY the old
// solver's class (see `isOldClassDay`). Anything richer — real windows, opening
// hours, meal blocks, a hard pace, duration ranges, droppable stops, relaxed
// day pins — goes through the ALNS instead, because on those days the old
// solver's answer is not the optimum of the problem we are actually solving.
//
// The one thing this path does NOT reproduce is the old solver's `infeasible`
// return: the engine always returns a plan. When no ordering meets the
// boundary, the least-violating one is returned and the breach becomes a
// conflict (./conflicts) — never a silent cut, never a dead end.

import type { EngineNode, EngineProblem } from "./types";

/** True when every stop of the trip is HARD-pinned to a day — launch mode. The
 * floor is only sound here: the moment a pin goes soft the day-assignment
 * problem is live, and a per-day exhaustive answer is no longer an answer to
 * the question being asked. */
export function isLaunchMode(problem: EngineProblem): boolean {
  return problem.nodes.every((n) => n.pinnedDay !== undefined && n.pinnedDay.hard);
}

/**
 * Is day `d` in the OLD SOLVER'S CONSTRAINT CLASS — i.e. is "minimise total
 * travel over orderings, subject to the day window and immovable point anchors"
 * the whole truth about this day?
 *
 * Every clause below is a thing the old solver could not express, and therefore
 * a thing whose presence makes the old optimum the wrong answer:
 */
export function isOldClassDay(problem: EngineProblem, d: number, launchMode: boolean): boolean {
  if (!launchMode) return false;
  const day = problem.days[d];
  if (!day) return false;
  if (!day.window.hard) return false; // a soft day window is a trade, not a bound
  if (day.blocks.length > 0) return false; // meal/quiet blocks: no old equivalent
  if (day.pace.hard) return false; // a hard pace adds span/effort/gap rules

  const byKey = new Map(problem.nodes.map((n) => [n.key, n]));
  // The exhaustive width is per anchor-delimited RUN, not per day — the old
  // solver enumerated each segment independently, so a 5+5 day around one
  // anchor was fully optimal for it (E5a audit, finding 2: gating on the day
  // total routed such days to ALNS, churning their plans on the engine swap).
  // Mirror solveOldClassDay's splitRuns walk in list order.
  let runLen = 0;
  let maxRunLen = 0;
  for (const key of day.nodeKeys) {
    const node = byKey.get(key);
    if (!node) return false;
    if (node.hours && node.hours.value.openByDay[d] !== null) return false; // hours bind here
    if (!node.duration.hard) return false;
    const dur = node.duration.value;
    if (dur.minMin !== dur.typicalMin || dur.typicalMin !== dur.maxMin) return false; // a range is trimmable
    if (node.priority.value !== "must" || !node.priority.hard) return false; // droppable = new
    if (node.window) {
      if (!node.isAnchor) return false; // a real window is not a point anchor
      runLen = 0; // an anchor closes the current run
    } else {
      runLen++;
      if (runLen > maxRunLen) maxRunLen = runLen;
    }
  }
  // The old solver's own exhaustive width, applied where it applied it: to the
  // longest run. Beyond it, it was a labelled heuristic (or a rejection), so
  // there is no optimum to be differential to.
  if (maxRunLen > problem.settings.maxExhaustive) return false;

  const dayOf = new Map(problem.nodes.map((n) => [n.key, n.pinnedDay?.value ?? -1]));
  for (const rel of problem.relations) {
    const touches = dayOf.get(rel.aKey) === d || dayOf.get(rel.bKey) === d;
    if (!touches) continue;
    // precedence is the only relation the old model had; sameDay/notSameDay
    // would silently not be enforced by this path.
    if (rel.kind !== "precedence") return false;
  }
  return true;
}

export type FloorResult = {
  /** Node keys in visit order, anchors included. */
  order: string[];
  /** Precedence pairs (relation ids) the assembled order breaks. The old solver
   * called a cross-segment break `infeasible`; here it is a conflict. */
  brokenPrecedence: string[];
  /** True when some run could not meet its boundary — the returned order is the
   * least-violating one, and assembly will surface the breach. */
  boundaryMissed: boolean;
};

/**
 * Order one old-class day. Pure, deterministic, no rng.
 */
export function solveOldClassDay(problem: EngineProblem, d: number): FloorResult {
  const day = problem.days[d];
  const byKey = new Map(problem.nodes.map((n) => [n.key, n]));
  const dayNodes = day.nodeKeys.map((k) => byKey.get(k)!).filter(Boolean);
  const { travel } = problem;
  const row = travel.minutesByDay[d];
  const idx = travel.index;
  // E6d — the home base rides the run mechanism's EXISTING endpoint slots
  // (exactly how anchors already bound a run): a sentinel key resolves to the
  // depot rows, the first run starts from it and the last run must return to
  // it before the day ends. Without a base, the sentinel never appears and
  // this function is byte-identical to its pre-depot self.
  const base = problem.base;
  const BASE_KEY = " __base__"; // leading space: no place id (or id@dN key) starts with one
  const t = (a: string, b: string): number => {
    if (base) {
      if (a === BASE_KEY) return base.outByDay[d][idx[b]];
      if (b === BASE_KEY) return base.backByDay[d][idx[a]];
    }
    return row[idx[a] * travel.n + idx[b]];
  };

  if (dayNodes.length === 0) return { order: [], brokenPrecedence: [], boundaryMissed: false };

  const anchors = dayNodes.filter((n) => n.isAnchor);
  // splitRuns: maximal runs of flexible stops between anchors, in list order.
  const runs: EngineNode[][] = [[]];
  for (const node of dayNodes) {
    if (node.isAnchor) runs.push([]);
    else runs[runs.length - 1].push(node);
  }

  const runOf = new Map<string, number>();
  runs.forEach((run, ri) => run.forEach((n) => runOf.set(n.key, ri)));

  // Route each precedence pair the way planDay does: within-run pairs constrain
  // the enumeration; the rest are validated against the assembled order.
  const onDay = new Set(dayNodes.map((n) => n.key));
  const withinRun = new Map<number, Array<{ before: string; after: string }>>();
  const crossRun: Array<{ id: string; before: string; after: string }> = [];
  for (const rel of problem.relations) {
    if (rel.kind !== "precedence") continue;
    if (!onDay.has(rel.aKey) || !onDay.has(rel.bKey)) continue;
    const ra = runOf.get(rel.aKey);
    const rb = runOf.get(rel.bKey);
    if (ra !== undefined && rb !== undefined && ra === rb) {
      const list = withinRun.get(ra) ?? [];
      list.push({ before: rel.aKey, after: rel.bKey });
      withinRun.set(ra, list);
    } else {
      crossRun.push({ id: rel.id, before: rel.aKey, after: rel.bKey });
    }
  }

  const order: string[] = [];
  let boundaryMissed = false;

  for (let i = 0; i < runs.length; i++) {
    const prevAnchor = i === 0 ? null : anchors[i - 1];
    const nextAnchor = i < anchors.length ? anchors[i] : null;
    const startAtMin = prevAnchor
      ? prevAnchor.window!.value.startMin + prevAnchor.duration.value.typicalMin
      : day.window.value.startMin;
    const endByMin = nextAnchor ? nextAnchor.window!.value.startMin : day.window.value.endMin;

    const best = bestRunOrder(
      runs[i],
      startAtMin,
      prevAnchor ? prevAnchor.key : base ? BASE_KEY : null,
      endByMin,
      nextAnchor ? nextAnchor.key : base ? BASE_KEY : null,
      withinRun.get(i) ?? [],
      t
    );
    if (best.violationMin > 0) boundaryMissed = true;
    order.push(...best.order);
    if (nextAnchor) order.push(nextAnchor.key);
  }

  const pos = new Map(order.map((k, i) => [k, i]));
  const brokenPrecedence = crossRun
    .filter((p) => (pos.get(p.before) ?? 0) > (pos.get(p.after) ?? 0))
    .map((p) => p.id)
    .sort();

  return { order, brokenPrecedence, boundaryMissed };
}

type RunSolution = { order: string[]; travelMin: number; violationMin: number };

/** Exhaustive search over one run. Mirrors solveExhaustive: minimise total
 * travel among precedence-satisfying feasible orders, strict improvement, first
 * found wins ties (and enumeration is lexicographic, so that is the
 * lexicographically smallest order). */
function bestRunOrder(
  run: readonly EngineNode[],
  startAtMin: number,
  startKey: string | null,
  endByMin: number,
  endKey: string | null,
  pairs: ReadonlyArray<{ before: string; after: string }>,
  t: (a: string, b: string) => number
): RunSolution {
  if (run.length === 0) {
    const travelMin = startKey !== null && endKey !== null ? t(startKey, endKey) : 0;
    const clock = startAtMin + travelMin;
    return { order: [], travelMin, violationMin: Math.max(0, clock - endByMin) };
  }

  // Sorted by STOP ID (the old solver's key), key as the tiebreak so the order
  // is total even in the presence of cross-day repeat occurrences.
  const sorted = [...run].sort((a, b) =>
    a.stopId < b.stopId ? -1 : a.stopId > b.stopId ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  );
  const n = sorted.length;
  const before = new Int32Array(pairs.length);
  const after = new Int32Array(pairs.length);
  const indexIn = new Map(sorted.map((s, i) => [s.key, i]));
  let pairCount = 0;
  for (const p of pairs) {
    const b = indexIn.get(p.before);
    const a = indexIn.get(p.after);
    if (b === undefined || a === undefined) continue;
    before[pairCount] = b;
    after[pairCount] = a;
    pairCount++;
  }

  const posOf = new Int32Array(n);
  let best: RunSolution | null = null;
  // Fallback for the case the old solver called infeasible: the least-violating
  // order, preferring precedence-satisfying ones, then least travel.
  let fallback: (RunSolution & { satisfies: boolean }) | null = null;

  forEachPermutation(n, (perm) => {
    let clock = startAtMin;
    let travelMin = 0;
    let prev = startKey;
    for (let i = 0; i < n; i++) {
      const node = sorted[perm[i]];
      if (prev !== null) {
        const leg = t(prev, node.key);
        clock += leg;
        travelMin += leg;
      }
      clock += node.duration.value.typicalMin;
      prev = node.key;
    }
    if (endKey !== null && prev !== null) {
      const leg = t(prev, endKey);
      clock += leg;
      travelMin += leg;
    }
    const violationMin = Math.max(0, clock - endByMin);

    let satisfies = true;
    if (pairCount > 0) {
      for (let i = 0; i < n; i++) posOf[perm[i]] = i;
      for (let k = 0; k < pairCount; k++) {
        if (posOf[before[k]] > posOf[after[k]]) {
          satisfies = false;
          break;
        }
      }
    }

    if (violationMin === 0 && satisfies) {
      if (best === null || travelMin < best.travelMin) {
        best = { order: materialise(sorted, perm), travelMin, violationMin: 0 };
      }
      return;
    }
    if (best !== null) return; // a feasible answer already exists; no fallback needed
    const candidate = { order: [] as string[], travelMin, violationMin, satisfies };
    if (
      fallback === null ||
      (satisfies && !fallback.satisfies) ||
      (satisfies === fallback.satisfies &&
        (violationMin < fallback.violationMin ||
          (violationMin === fallback.violationMin && travelMin < fallback.travelMin)))
    ) {
      candidate.order = materialise(sorted, perm);
      fallback = candidate;
    }
  });

  if (best !== null) return best;
  if (fallback !== null) {
    const f: RunSolution & { satisfies: boolean } = fallback;
    return { order: f.order, travelMin: f.travelMin, violationMin: f.violationMin };
  }
  return { order: sorted.map((s) => s.key), travelMin: 0, violationMin: 0 };
}

function materialise(sorted: readonly EngineNode[], perm: Int32Array): string[] {
  const out: string[] = new Array(perm.length);
  for (let i = 0; i < perm.length; i++) out[i] = sorted[perm[i]].key;
  return out;
}

/** Lexicographic permutations of 0..n-1, in EXACTLY the order the old solver's
 * `permutations(sortedStops(...))` generator yields them — which is what makes
 * "first found wins ties" mean the same thing in both engines. Allocation-free
 * (the callback must not retain `perm`). */
function forEachPermutation(n: number, visit: (perm: Int32Array) => void): void {
  const perm = new Int32Array(n);
  const used = new Uint8Array(n);
  const rec = (depth: number): void => {
    if (depth === n) {
      visit(perm);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = 1;
      perm[depth] = i;
      rec(depth + 1);
      used[i] = 0;
    }
  };
  rec(0);
}
