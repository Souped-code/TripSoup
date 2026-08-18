// E5a — the ALNS search, ported from `spike/alns.ts` (the benchmark winner,
// Held-Karp-verified, byte-deterministic per problem/seed/budget).
//
// The machinery is the spike's, unchanged in kind: greedy cheapest-insertion
// construction, five destroy operators (random / worst / Shaw / segment / day
// teardown), two repair operators (greedy, regret-2), adaptive roulette weights
// on Ropke-Pisinger scores, simulated-annealing acceptance with geometric
// cooling and stagnation reheat, intra-day 2-opt polish, and a deterministic
// iteration cap. Every tunable below carries the spike's value.
//
// ---------------------------------------------------------------------------
// WHAT CHANGED FOR PRODUCTION (and why)
// ---------------------------------------------------------------------------
//  1. TRAVEL IS A MATRIX LOOKUP, PER DAY, ASYMMETRIC. The spike's planar
//     `hypot(dx, dy) / speed` is gone: times come from the AUTO effective
//     matrix (§2 decide-then-offer is decided upstream and the engine never
//     re-decides a mode). Nothing in the search assumes symmetry or the
//     triangle inequality any more.
//  2. SHAW RELATEDNESS USES HAVERSINE DISTANCE between stop coordinates rather
//     than travel time. Relatedness only has to say "these two are neighbours";
//     doing it geographically keeps the operator meaningful across days, where
//     a per-day matrix has no entry at all.
//  3. PACE IS HARDNESS-AWARE. The spike's pace was hard. `compileFromDoc`
//     emits pace as a SOFT, DERIVED default — a preference we invented because
//     nobody said anything — so its `minGapMin` is applied to the schedule only
//     when the pace constraint is HARD. Forcing a 10-minute gap between every
//     pair of stops on the strength of a default we made up would silently
//     repace every existing trip. When soft, a span/effort overrun is priced.
//  4. SOFT CONSTRAINTS ARE PRICED. Soft windows/hours/relations/pace cost their
//     weight (plus a tiny per-minute tiebreak so "less violated" wins between
//     two equally-violating candidates — search-internal, exactly as the
//     spike's breach pricing was; ./evaluate stays flat).
//     LIMITATION, deliberate and documented: the slot machinery is built from
//     HARD windows/hours only. A soft window is priced but does not steer the
//     earliest-start choice. Nothing emits soft windows before E7, and making
//     them steer means a second slot layer that is not worth its complexity
//     until something actually produces one.
//  5. `must` IS HARD-PRIORITY-AWARE. A `must` whose priority constraint is soft
//     is droppable at its weight; a hard one is force-placed at its least-bad
//     position and reported as a conflict, never cut.

import { createRng, type Rng } from "../util/rng";
import { haversineMeters } from "../maps/walkEstimator";
import { WEIGHT_COMPRESSION, WEIGHT_TRAVEL, WEIGHT_WAIT } from "./evaluate";
import type { EngineProblem, EngineSchedule, EngineVisit, SolveOptions } from "./types";

// ---------------------------------------------------------------------------
// Objective weights beyond the evaluator's (search-internal; see the header)
// ---------------------------------------------------------------------------

/** A dropped hard-`must` is not a priced trade, it is an infeasible answer. The
 *  value stays finite only so the search can rank two bad answers. */
const DROP_PENALTY_MUST = 5_000_000;
/** One hard-constraint breach. Dominates any achievable amount of travel/wait. */
const BREACH_EACH = 1_000_000;
/** Per minute of breach, so "less infeasible" is preferred. */
const BREACH_PER_MIN = 1_000;
/** Charged when a stop with a *soft* pin lands off its pinned day. */
const SOFT_PIN_PENALTY = 100;
/** Notional breach size when a stop has no open slot at all on a day. */
const NO_SLOT_BREACH_MIN = 480;
/** Effort points over a HARD pace cap, converted to breach-minutes. */
const EFFORT_BREACH_MIN_PER_POINT = 60;
/** Tiebreak on top of a flat soft penalty so a smaller violation wins. */
const SOFT_TIEBREAK_PER_MIN = 0.01;

const PRUNE_COEFF = Math.max(0, WEIGHT_TRAVEL - 2 * WEIGHT_WAIT);

// ---------------------------------------------------------------------------
// ALNS tunables — the spike's values, unchanged
// ---------------------------------------------------------------------------

const REMOVE_FRAC_MIN = 0.1;
const REMOVE_FRAC_MAX = 0.3;
const SEGMENT_LEN = 100;
const REACTION = 0.35;
const SIGMA_NEW_BEST = 33;
const SIGMA_BETTER = 13;
const SIGMA_ACCEPTED_WORSE = 9;
const T0_WORSE_FRAC = 0.02;
const T0_ACCEPT_PROB = 0.3;
const T_END_RATIO = 0.002;
const STAGNATION_FRAC = 0.06;
const REHEAT_FRAC = 0.5;
const SELECT_EXP = 4;
const NOISE_FRAC = 0.15;
const TIME_CHECK_EVERY = 128;
const PROGRESS_MS = 250;

/** ITER_CAP = clamp(round(RATE * budgetMs / (n + 10)), MIN, MAX) — see the
 * spike's header for the calibration. The answer is byte-identical for a given
 * (problem, seed, budget) on any machine fast enough to exhaust the cap;
 * `opts.iterCap` removes the machine from the equation entirely. */
const ITER_CAP_RATE = 430;
const ITER_CAP_MIN = 20_000;
const ITER_CAP_MAX = 500_000;

const PRIORITY_RANK: Record<string, number> = { must: 0, should: 1, could: 2 };

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export type SearchOptions = SolveOptions & {
  /** Node keys the search owns. Anything outside this set is invisible to it —
   * that is how the hybrid exhaustive floor hands it only the days it should
   * touch. Defaults to every node. */
  activeKeys?: ReadonlySet<string>;
  /** Progress fraction of the overall solve that this search represents, used
   * only to scale emitted pct. */
  progressFrom?: number;
  progressTo?: number;
};

/**
 * Search. Returns the best schedule found for the active nodes; days with no
 * active node come back empty (the caller fills them from the floor).
 */
export function searchAlns(problem: EngineProblem, opts: SearchOptions): EngineSchedule {
  const startedAt = Date.now();
  const rng: Rng = createRng(opts.seed);
  const onProgress = opts.onProgress;
  const pFrom = opts.progressFrom ?? 0;
  const pTo = opts.progressTo ?? 100;
  // Non-finite budget = "no wall-clock cut", NOT zero — coercing Infinity to 0
  // silently ran construction-only (E5a audit, finding 1). And when an explicit
  // iterCap is provided, the wall clock is IGNORED entirely: iterCap exists so
  // the same (problem, seed, iterCap) yields the same answer on any machine,
  // and a clock break re-introduces exactly the machine-dependence it removes.
  // Abort via opts.signal still applies in both modes.
  const timeBudgetMs = Number.isFinite(opts.timeBudgetMs) ? Math.max(0, opts.timeBudgetMs) : Infinity;
  const useWallClock = opts.iterCap === undefined && Number.isFinite(timeBudgetMs);
  // The hard safety net applies regardless of iterCap (see SolveOptions).
  const hardStopMs =
    opts.hardStopMs !== undefined && Number.isFinite(opts.hardStopMs)
      ? Math.max(0, opts.hardStopMs)
      : Infinity;

  const active = opts.activeKeys;
  const stops = problem.nodes.filter((n) => !active || active.has(n.key));
  const days = problem.days;
  const N = stops.length;
  const D = days.length;

  if (N === 0 || D === 0) {
    return { visits: [], dropped: stops.map((s) => s.key) };
  }

  const ITER_CAP =
    opts.iterCap !== undefined && Number.isFinite(opts.iterCap)
      ? Math.max(1, Math.round(opts.iterCap))
      : clamp(Math.round((ITER_CAP_RATE * timeBudgetMs) / (N + 10)), ITER_CAP_MIN, ITER_CAP_MAX);

  // -------------------------------------------------------------------------
  // Preprocessing — flat typed arrays; the forward pass must not allocate.
  // -------------------------------------------------------------------------

  const keyOf: string[] = new Array(N);
  const DUR_MIN = new Float64Array(N);
  const DUR_TYP = new Float64Array(N);
  const DUR_MAX = new Float64Array(N);
  const EFFORT = new Float64Array(N);
  const PRIO = new Int32Array(N);
  const DROP_COST = new Float64Array(N);
  const PIN_DAY = new Int32Array(N).fill(-1);
  const PIN_HARD = new Uint8Array(N);
  const PIN_WEIGHT = new Float64Array(N);
  /** Soft window/hours weight charged when the placed visit misses them. */
  const SOFT_WINDOW_W = new Float64Array(N);
  const SOFT_HOURS_W = new Float64Array(N);

  for (let i = 0; i < N; i++) {
    const s = stops[i];
    keyOf[i] = s.key;
    const d = s.duration.value;
    DUR_TYP[i] = d.typicalMin;
    DUR_MAX[i] = Math.max(d.typicalMin, d.maxMin);
    DUR_MIN[i] = clamp(d.minMin, 0, d.typicalMin);
    EFFORT[i] = s.effortPoints;
    PRIO[i] = PRIORITY_RANK[s.priority.value] ?? 2;
    DROP_COST[i] =
      s.priority.value === "must" && s.priority.hard ? DROP_PENALTY_MUST : s.dropPenalty;
    if (s.pinnedDay) {
      PIN_DAY[i] = s.pinnedDay.value;
      PIN_HARD[i] = s.pinnedDay.hard ? 1 : 0;
      PIN_WEIGHT[i] = s.pinnedDay.hard ? 0 : s.pinnedDay.weight || SOFT_PIN_PENALTY;
    }
    if (s.window && !s.window.hard) SOFT_WINDOW_W[i] = s.window.weight;
    if (s.hours && !s.hours.hard) SOFT_HOURS_W[i] = s.hours.weight;
  }

  // Travel: one dense local matrix per day, projected out of the problem's.
  const gIndex = problem.travel.index;
  const gn = problem.travel.n;
  const g = new Int32Array(N);
  for (let i = 0; i < N; i++) g[i] = gIndex[stops[i].key];
  const TRAVEL: Float64Array[] = new Array(D);
  let travelSum = 0;
  let travelPairs = 0;
  for (let d = 0; d < D; d++) {
    const row = problem.travel.minutesByDay[d];
    const local = new Float64Array(N * N);
    for (let a = 0; a < N; a++) {
      for (let b = 0; b < N; b++) {
        if (a === b) continue;
        const t = row ? row[g[a] * gn + g[b]] : 0;
        local[a * N + b] = t;
        travelSum += t;
        travelPairs++;
      }
    }
    TRAVEL[d] = local;
  }
  const MEAN_TRAVEL = travelPairs > 0 ? travelSum / travelPairs : 0;

  // E6d — depot rows, projected to the local index exactly like TRAVEL.
  // null = no home base = byte-identical pre-depot behaviour on every path.
  let BOUT: Float64Array[] | null = null;
  let BBACK: Float64Array[] | null = null;
  if (problem.base) {
    BOUT = new Array(D);
    BBACK = new Array(D);
    for (let d = 0; d < D; d++) {
      const go = problem.base.outByDay[d];
      const gb = problem.base.backByDay[d];
      const lo = new Float64Array(N);
      const lb = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        lo[i] = go[g[i]];
        lb[i] = gb[g[i]];
      }
      BOUT[d] = lo;
      BBACK[d] = lb;
    }
  }

  // Geographic distance, for Shaw relatedness only (production change 2).
  const DIST = new Float64Array(N * N);
  let MAX_DIST = 1;
  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b < N; b++) {
      const m = haversineMeters(stops[a].location, stops[b].location);
      DIST[a * N + b] = m;
      DIST[b * N + a] = m;
      if (m > MAX_DIST) MAX_DIST = m;
    }
  }

  // Per-day parameters.
  const DAY_START = new Float64Array(D);
  const DAY_END = new Float64Array(D);
  const MAX_SPAN = new Float64Array(D);
  const MAX_EFFORT = new Float64Array(D);
  const MIN_GAP = new Float64Array(D);
  const PACE_HARD = new Uint8Array(D);
  const PACE_W = new Float64Array(D);
  const BLOCK_START: Float64Array[] = new Array(D);
  const BLOCK_END: Float64Array[] = new Array(D);
  let MAX_DAY_LEN = 1;
  for (let d = 0; d < D; d++) {
    const day = days[d];
    DAY_START[d] = day.window.value.startMin;
    DAY_END[d] = day.window.value.endMin;
    MAX_SPAN[d] = day.pace.value.maxActiveMin;
    MAX_EFFORT[d] = day.pace.value.maxEffortPoints;
    PACE_HARD[d] = day.pace.hard ? 1 : 0;
    PACE_W[d] = day.pace.weight;
    MIN_GAP[d] = day.pace.hard ? day.pace.value.minGapMin : 0;
    const blocks = day.blocks
      .map((b) => b.value)
      .slice()
      .sort((p, q) => p.startMin - q.startMin);
    BLOCK_START[d] = Float64Array.from(blocks.map((b) => b.startMin));
    BLOCK_END[d] = Float64Array.from(blocks.map((b) => b.endMin));
    MAX_DAY_LEN = Math.max(MAX_DAY_LEN, DAY_END[d] - DAY_START[d]);
  }

  // Feasible start slots per (stop, day): day window ∩ HARD stop window ∩ HARD
  // hours. minStart / maxStart (lastEntry-capped) / maxDepart.
  const slotOff = new Int32Array(N * D + 1);
  const slotMinL: number[] = [];
  const slotMaxSL: number[] = [];
  const slotMaxDL: number[] = [];
  for (let i = 0; i < N; i++) {
    const st = stops[i];
    const hardWindow = st.window && st.window.hard ? st.window.value : undefined;
    const hardHours = st.hours && st.hours.hard ? st.hours.value : undefined;
    for (let d = 0; d < D; d++) {
      slotOff[i * D + d] = slotMinL.length;
      const open = hardHours ? hardHours.openByDay[d] : null;
      const intervals: Array<{ lo: number; hi: number }> =
        open === null || open === undefined
          ? [{ lo: -Infinity, hi: Infinity }]
          : open.map((w) => ({ lo: w.startMin, hi: w.endMin }));
      const lastEntry = hardHours?.lastEntryMin;
      const built: Array<{ a: number; b: number; c: number }> = [];
      for (const iv of intervals) {
        let lo = Math.max(DAY_START[d], iv.lo);
        let hiStart = Math.min(DAY_END[d], iv.hi);
        const hiDepart = Math.min(DAY_END[d], iv.hi);
        if (lastEntry !== undefined) hiStart = Math.min(hiStart, lastEntry);
        if (hardWindow) {
          lo = Math.max(lo, hardWindow.startMin);
          hiStart = Math.min(hiStart, hardWindow.endMin);
        }
        if (lo > hiStart) continue;
        if (lo + DUR_MIN[i] > hiDepart) continue;
        built.push({ a: lo, b: hiStart, c: hiDepart });
      }
      built.sort((p, q) => p.a - q.a || p.b - q.b);
      for (const s of built) {
        slotMinL.push(s.a);
        slotMaxSL.push(s.b);
        slotMaxDL.push(s.c);
      }
    }
  }
  slotOff[N * D] = slotMinL.length;
  const SLOT_MIN = Float64Array.from(slotMinL);
  const SLOT_MAXS = Float64Array.from(slotMaxSL);
  const SLOT_MAXD = Float64Array.from(slotMaxDL);

  // Soft window/hours, checked after a start is chosen (see the header's
  // limitation note).
  const softWindowLo = new Float64Array(N);
  const softWindowHi = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = stops[i].window;
    softWindowLo[i] = w && !w.hard ? w.value.startMin : -Infinity;
    softWindowHi[i] = w && !w.hard ? w.value.endMin : Infinity;
  }

  const dayCandidates: Int32Array[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const list: number[] = [];
    for (let d = 0; d < D; d++) {
      if (PIN_DAY[i] >= 0 && PIN_HARD[i] === 1 && PIN_DAY[i] !== d) continue;
      if (slotOff[i * D + d] === slotOff[i * D + d + 1]) continue;
      list.push(d);
    }
    dayCandidates[i] = Int32Array.from(list);
  }

  // Relations, indexed per stop.
  const indexOf = new Map<string, number>();
  for (let i = 0; i < N; i++) indexOf.set(keyOf[i], i);
  const succ: number[][] = Array.from({ length: N }, () => []);
  const pred: number[][] = Array.from({ length: N }, () => []);
  const sameDay: number[][] = Array.from({ length: N }, () => []);
  const notSameDay: number[][] = Array.from({ length: N }, () => []);
  const relPairs: Array<{ kind: 0 | 1 | 2; a: number; b: number; hard: boolean; weight: number }> =
    [];
  for (const r of problem.relations) {
    const a = indexOf.get(r.aKey);
    const b = indexOf.get(r.bKey);
    if (a === undefined || b === undefined || a === b) continue;
    if (r.kind === "precedence") {
      if (r.hard) {
        succ[a].push(b);
        pred[b].push(a);
      }
      relPairs.push({ kind: 0, a, b, hard: r.hard, weight: r.weight });
    } else if (r.kind === "sameDay") {
      if (r.hard) {
        sameDay[a].push(b);
        sameDay[b].push(a);
      }
      relPairs.push({ kind: 1, a, b, hard: r.hard, weight: r.weight });
    } else {
      if (r.hard) {
        notSameDay[a].push(b);
        notSameDay[b].push(a);
      }
      relPairs.push({ kind: 2, a, b, hard: r.hard, weight: r.weight });
    }
  }
  const HAS_REL = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (succ[i].length || pred[i].length || sameDay[i].length || notSameDay[i].length)
      HAS_REL[i] = 1;
  }

  // Topological depth over hard precedence, used only to order construction.
  const topo = new Int32Array(N);
  {
    const indeg = new Int32Array(N);
    for (let i = 0; i < N; i++) for (const j of succ[i]) indeg[j]++;
    const queue: number[] = [];
    for (let i = 0; i < N; i++) if (indeg[i] === 0) queue.push(i);
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi];
      for (const v of succ[u]) {
        if (topo[v] < topo[u] + 1) topo[v] = topo[u] + 1;
        if (--indeg[v] === 0) queue.push(v);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Day schedule builder — THE hot path. Allocation-free; results land in EV.
  // -------------------------------------------------------------------------

  const EV = {
    ok: true,
    travel: 0,
    wait: 0,
    compress: 0,
    breachMin: 0,
    breachCnt: 0,
    soft: 0,
    effort: 0,
    span: 0,
  };
  const schedArrive = new Float64Array(N);
  const schedStart = new Float64Array(N);
  const schedDepart = new Float64Array(N);

  const psStop = new Int32Array(N + 1);
  const psStart = new Float64Array(N + 1);
  const psDur = new Float64Array(N + 1);
  const psTravelIn = new Float64Array(N + 1);
  const psMaxStart = new Float64Array(N + 1);
  const psMaxDepart = new Float64Array(N + 1);

  /** Earliest time >= t that is not inside a block of day d (blocks forbid a
   *  START, half-open). */
  function pushAfterBlocks(t: number, d: number): number {
    const ms = BLOCK_START[d];
    const me = BLOCK_END[d];
    for (let k = 0; k < ms.length; k++) if (t >= ms[k] && t < me[k]) t = me[k];
    return t;
  }

  function pullBeforeBlocks(t: number, d: number): number {
    const ms = BLOCK_START[d];
    const me = BLOCK_END[d];
    for (let k = ms.length - 1; k >= 0; k--) if (t >= ms[k] && t < me[k]) t = ms[k] - 1;
    return t;
  }

  /**
   * Build one day's schedule from an ordered stop list.
   *
   * Phase 1 (forward): earliest feasible start per stop, compressing toward
   *   minMin only where that converts an infeasible fit into a feasible one.
   * Phase 2 (backward): right-shift the leading stops as late as the rest of the
   *   day allows — shrinks the day span and the wait a late anchor implies.
   * Phase 3 (forward): stretch each non-final visit toward maxMin to absorb the
   *   remaining slack (wait converted into time spent at the attraction).
   * Phase 4: totals, pace, soft penalties.
   */
  function evalDay(
    d: number,
    order: ArrayLike<number>,
    len: number,
    strict: boolean,
    writeSched: boolean
  ): typeof EV {
    if (len === 0) {
      EV.ok = true;
      EV.travel = 0;
      EV.wait = 0;
      EV.compress = 0;
      EV.breachMin = 0;
      EV.breachCnt = 0;
      EV.soft = 0;
      EV.effort = 0;
      EV.span = 0;
      return EV;
    }

    const T = TRAVEL[d];
    const minGap = MIN_GAP[d];
    let breachMin = 0;
    let breachCnt = 0;
    let soft = 0;
    let effort = 0;
    let prev = -1;
    let prevDepart = 0;
    let prevStart = -Infinity;

    for (let i = 0; i < len; i++) {
      const s = order[i] as number;
      let tIn = 0;
      let earliest: number;
      if (prev < 0) {
        // E6d — the day starts at the base: the first stop is reachable no
        // earlier than day-open + lead-out. tIn carries the leg into the
        // travel total; the first stop still accrues NO wait (Phase 4 treats
        // arrive := start — you leave the base when you need to).
        tIn = BOUT === null ? 0 : BOUT[d][s];
        earliest = DAY_START[d] + tIn;
      } else {
        tIn = T[prev * N + s];
        earliest = prevDepart + tIn + minGap;
      }
      if (earliest <= prevStart) earliest = prevStart + 1; // keep starts strictly increasing

      const so = slotOff[s * D + d];
      const se = slotOff[s * D + d + 1];
      let bestStart = -1;
      let bestDur = 0;
      let bestBreach = Infinity;
      let bestMaxStart = 0;
      let bestMaxDepart = 0;
      for (let k = so; k < se; k++) {
        let st = earliest > SLOT_MIN[k] ? earliest : SLOT_MIN[k];
        st = pushAfterBlocks(st, d);
        const late = st > SLOT_MAXS[k] ? st - SLOT_MAXS[k] : 0;
        let dur = DUR_TYP[s];
        const room = SLOT_MAXD[k] - st;
        let over = 0;
        if (dur > room) {
          dur = room;
          if (dur < DUR_MIN[s]) {
            over = DUR_MIN[s] - dur;
            dur = DUR_MIN[s];
          }
        }
        const breach = late + over;
        if (breach <= 0) {
          bestStart = st;
          bestDur = dur;
          bestBreach = 0;
          bestMaxStart = SLOT_MAXS[k];
          bestMaxDepart = SLOT_MAXD[k];
          break;
        }
        if (breach < bestBreach) {
          bestBreach = breach;
          bestStart = st;
          bestDur = dur;
          bestMaxStart = SLOT_MAXS[k];
          bestMaxDepart = SLOT_MAXD[k];
        }
      }

      if (bestStart < 0) {
        if (strict) {
          EV.ok = false;
          return EV;
        }
        bestStart = pushAfterBlocks(earliest, d);
        bestDur = DUR_TYP[s];
        bestBreach = NO_SLOT_BREACH_MIN;
        bestMaxStart = bestStart;
        bestMaxDepart = bestStart + bestDur;
      }
      if (bestBreach > 0) {
        if (strict) {
          EV.ok = false;
          return EV;
        }
        breachMin += bestBreach;
        breachCnt++;
      }

      effort += EFFORT[s];
      if (strict && PACE_HARD[d] === 1 && effort > MAX_EFFORT[d]) {
        EV.ok = false;
        return EV;
      }

      psStop[i] = s;
      psStart[i] = bestStart;
      psDur[i] = bestDur;
      psTravelIn[i] = tIn;
      psMaxStart[i] = bestMaxStart;
      psMaxDepart[i] = bestMaxDepart;

      prev = s;
      prevStart = bestStart;
      prevDepart = bestStart + bestDur;
    }

    // ---- Phase 2: right-shift the prefix ---------------------------------
    for (let i = len - 2; i >= 0; i--) {
      let cap = psMaxStart[i];
      const byDepart = psMaxDepart[i] - psDur[i];
      if (byDepart < cap) cap = byDepart;
      const byNext = psStart[i + 1] - psTravelIn[i + 1] - minGap - psDur[i];
      if (byNext < cap) cap = byNext;
      if (cap >= psStart[i + 1]) cap = psStart[i + 1] - 1;
      if (cap > psStart[i]) {
        const pulled = pullBeforeBlocks(cap, d);
        if (pulled > psStart[i]) psStart[i] = pulled;
      }
    }

    // ---- Phase 3: stretch visits into the remaining slack -----------------
    for (let i = 0; i < len - 1; i++) {
      const s = psStop[i];
      let cap = DUR_MAX[s];
      const byDepart = psMaxDepart[i] - psStart[i];
      if (byDepart < cap) cap = byDepart;
      const byNext = psStart[i + 1] - psTravelIn[i + 1] - minGap - psStart[i];
      if (byNext < cap) cap = byNext;
      if (cap > psDur[i]) psDur[i] = cap;
    }

    // ---- Phase 4: totals --------------------------------------------------
    let travel = 0;
    let wait = 0;
    let compress = 0;
    for (let i = 0; i < len; i++) {
      const s = psStop[i];
      const arrive = i === 0 ? psStart[0] : psStart[i - 1] + psDur[i - 1] + psTravelIn[i];
      travel += psTravelIn[i];
      wait += psStart[i] - arrive;
      if (psDur[i] < DUR_TYP[s]) compress += DUR_TYP[s] - psDur[i];
      // Soft window / soft hours: priced, not binding (see the header).
      if (SOFT_WINDOW_W[s] > 0) {
        const lo = softWindowLo[s];
        const hi = softWindowHi[s];
        const off = psStart[i] < lo ? lo - psStart[i] : psStart[i] > hi ? psStart[i] - hi : 0;
        if (off > 0) soft += SOFT_WINDOW_W[s] + SOFT_TIEBREAK_PER_MIN * off;
      }
      if (SOFT_HOURS_W[s] > 0) {
        const open = stops[s].hours!.value.openByDay[d];
        if (open) {
          const depart = psStart[i] + psDur[i];
          const lastEntry = stops[s].hours!.value.lastEntryMin;
          const fits =
            (lastEntry === undefined || psStart[i] <= lastEntry) &&
            open.some((w) => psStart[i] >= w.startMin && depart <= w.endMin);
          if (!fits) soft += SOFT_HOURS_W[s];
        }
      }
      if (writeSched) {
        schedArrive[s] = arrive;
        schedStart[s] = psStart[i];
        schedDepart[s] = psStart[i] + psDur[i];
      }
    }
    // E6d — the return leg: real travel, and it must land inside the day
    // window (the same unconditional day-window convention the slots use).
    // Span stays visits-only — the commute home is not "active" pace time.
    if (BBACK !== null) {
      const back = BBACK[d][psStop[len - 1]];
      travel += back;
      const over = psStart[len - 1] + psDur[len - 1] + back - DAY_END[d];
      if (over > 0) {
        if (strict) {
          EV.ok = false;
          return EV;
        }
        breachMin += over;
        breachCnt++;
      }
    }

    const span = psStart[len - 1] + psDur[len - 1] - psStart[0];

    if (span > MAX_SPAN[d]) {
      if (PACE_HARD[d] === 1) {
        if (strict) {
          EV.ok = false;
          return EV;
        }
        breachCnt++;
        breachMin += span - MAX_SPAN[d];
      } else {
        soft += PACE_W[d] + SOFT_TIEBREAK_PER_MIN * (span - MAX_SPAN[d]);
      }
    }
    if (effort > MAX_EFFORT[d]) {
      if (PACE_HARD[d] === 1) {
        if (strict) {
          EV.ok = false;
          return EV;
        }
        breachCnt++;
        breachMin += (effort - MAX_EFFORT[d]) * EFFORT_BREACH_MIN_PER_POINT;
      } else {
        soft += PACE_W[d];
      }
    }

    EV.ok = true;
    EV.travel = travel;
    EV.wait = wait;
    EV.compress = compress;
    EV.breachMin = breachMin;
    EV.breachCnt = breachCnt;
    EV.soft = soft;
    EV.effort = effort;
    EV.span = span;
    return EV;
  }

  // -------------------------------------------------------------------------
  // Solution representation
  // -------------------------------------------------------------------------

  type Sol = {
    order: number[][];
    dayOf: Int32Array;
    pos: Int32Array;
    travel: Float64Array;
    wait: Float64Array;
    compress: Float64Array;
    breachMin: Float64Array;
    breachCnt: Float64Array;
    soft: Float64Array;
    effort: Float64Array;
    cost: number;
    base: number;
  };

  function newSol(): Sol {
    return {
      order: Array.from({ length: D }, () => [] as number[]),
      dayOf: new Int32Array(N).fill(-1),
      pos: new Int32Array(N).fill(-1),
      travel: new Float64Array(D),
      wait: new Float64Array(D),
      compress: new Float64Array(D),
      breachMin: new Float64Array(D),
      breachCnt: new Float64Array(D),
      soft: new Float64Array(D),
      effort: new Float64Array(D),
      cost: 0,
      base: 0,
    };
  }

  function copyInto(dst: Sol, src: Sol): void {
    for (let d = 0; d < D; d++) {
      const a = dst.order[d];
      const b = src.order[d];
      a.length = b.length;
      for (let i = 0; i < b.length; i++) a[i] = b[i];
    }
    dst.dayOf.set(src.dayOf);
    dst.pos.set(src.pos);
    dst.travel.set(src.travel);
    dst.wait.set(src.wait);
    dst.compress.set(src.compress);
    dst.breachMin.set(src.breachMin);
    dst.breachCnt.set(src.breachCnt);
    dst.soft.set(src.soft);
    dst.effort.set(src.effort);
    dst.cost = src.cost;
    dst.base = src.base;
  }

  function dayCost(sol: Sol, d: number): number {
    return (
      sol.travel[d] * WEIGHT_TRAVEL +
      sol.wait[d] * WEIGHT_WAIT +
      sol.compress[d] * WEIGHT_COMPRESSION +
      sol.soft[d] +
      sol.breachMin[d] * BREACH_PER_MIN +
      sol.breachCnt[d] * BREACH_EACH
    );
  }

  function commitDay(sol: Sol, d: number): void {
    const ord = sol.order[d];
    const len = ord.length;
    for (let i = 0; i < len; i++) {
      sol.dayOf[ord[i]] = d;
      sol.pos[ord[i]] = i;
    }
    evalDay(d, ord, len, false, false);
    sol.travel[d] = EV.travel;
    sol.wait[d] = EV.wait;
    sol.compress[d] = EV.compress;
    sol.breachMin[d] = EV.breachMin;
    sol.breachCnt[d] = EV.breachCnt;
    sol.soft[d] = EV.soft;
    sol.effort[d] = EV.effort;
  }

  /** Relation breaches (hard) and priced relation misses (soft). */
  function relationCosts(sol: Sol): { hard: number; soft: number } {
    let hard = 0;
    let soft = 0;
    for (let k = 0; k < relPairs.length; k++) {
      const r = relPairs[k];
      const da = sol.dayOf[r.a];
      const db = sol.dayOf[r.b];
      if (da < 0 || db < 0) continue; // vacuous when an endpoint is dropped
      let broken: boolean;
      if (r.kind === 0) broken = da > db || (da === db && sol.pos[r.a] >= sol.pos[r.b]);
      else if (r.kind === 1) broken = da !== db;
      else broken = da === db;
      if (!broken) continue;
      if (r.hard) hard++;
      else soft += r.weight;
    }
    return { hard, soft };
  }

  function recomputeCost(sol: Sol): void {
    let base = 0;
    let breach = 0;
    for (let d = 0; d < D; d++) {
      base +=
        sol.travel[d] * WEIGHT_TRAVEL +
        sol.wait[d] * WEIGHT_WAIT +
        sol.compress[d] * WEIGHT_COMPRESSION +
        sol.soft[d];
      breach += sol.breachMin[d] * BREACH_PER_MIN + sol.breachCnt[d] * BREACH_EACH;
    }
    for (let i = 0; i < N; i++) {
      if (sol.dayOf[i] < 0) base += DROP_COST[i];
      else if (PIN_DAY[i] >= 0 && PIN_HARD[i] === 0 && sol.dayOf[i] !== PIN_DAY[i])
        base += PIN_WEIGHT[i];
    }
    const rel = relationCosts(sol);
    base += rel.soft;
    breach += rel.hard * BREACH_EACH;
    sol.base = base;
    sol.cost = base + breach;
  }

  // -------------------------------------------------------------------------
  // Insertion machinery
  // -------------------------------------------------------------------------

  const scratchA: number[] = new Array(N + 1).fill(0);
  const scratchB: number[] = new Array(N + 1).fill(0);

  function spliceInto(dst: number[], order: number[], len: number, p: number, s: number): number {
    for (let i = 0; i < p; i++) dst[i] = order[i];
    dst[p] = s;
    for (let i = p; i < len; i++) dst[i + 1] = order[i];
    return len + 1;
  }

  function spliceOut(dst: number[], order: number[], len: number, p: number): number {
    let k = 0;
    for (let i = 0; i < len; i++) if (i !== p) dst[k++] = order[i];
    return k;
  }

  function travelDelta(order: number[], len: number, p: number, s: number, d: number): number {
    // E6d — end insertions swap the depot leg too; without these terms the
    // prune lower bound could exceed the true delta (BOUT[s] can be smaller
    // than BOUT[old first]) and skip genuinely improving placements.
    const T = TRAVEL[d];
    if (len === 0) return BOUT === null ? 0 : BOUT[d][s] + BBACK![d][s];
    if (p === 0) return (BOUT === null ? 0 : BOUT[d][s] - BOUT[d][order[0]]) + T[s * N + order[0]];
    if (p === len)
      return T[order[len - 1] * N + s] + (BBACK === null ? 0 : BBACK[d][s] - BBACK[d][order[len - 1]]);
    const a = order[p - 1];
    const b = order[p];
    return T[a * N + s] + T[s * N + b] - T[a * N + b];
  }

  function relationsAllow(sol: Sol, s: number, d: number, p: number): boolean {
    if (HAS_REL[s] === 0) return true;
    for (const q of notSameDay[s]) if (sol.dayOf[q] === d) return false;
    for (const q of sameDay[s]) if (sol.dayOf[q] >= 0 && sol.dayOf[q] !== d) return false;
    for (const q of succ[s]) {
      const dq = sol.dayOf[q];
      if (dq < 0) continue;
      if (dq < d) return false;
      if (dq === d && sol.pos[q] < p) return false;
    }
    for (const q of pred[s]) {
      const dq = sol.dayOf[q];
      if (dq < 0) continue;
      if (dq > d) return false;
      if (dq === d && sol.pos[q] >= p) return false;
    }
    return true;
  }

  const scanResult = { d1: -1, p1: -1, c1: Infinity, d2: -1, p2: -1, c2: Infinity };

  function scanInsertions(sol: Sol, s: number, noiseAmp: number): void {
    scanResult.d1 = -1;
    scanResult.p1 = -1;
    scanResult.c1 = Infinity;
    scanResult.d2 = -1;
    scanResult.p2 = -1;
    scanResult.c2 = Infinity;

    const candDays = dayCandidates[s];
    for (let ci = 0; ci < candDays.length; ci++) {
      const d = candDays[ci];
      if (PACE_HARD[d] === 1 && sol.effort[d] + EFFORT[s] > MAX_EFFORT[d]) continue;
      const order = sol.order[d];
      const len = order.length;
      const oldCost = dayCost(sol, d);
      const dirty = sol.breachCnt[d] > 0;
      const noise = noiseAmp > 0 ? (rng.next() * 2 - 1) * noiseAmp : 0;
      const softPin =
        PIN_DAY[s] >= 0 && PIN_HARD[s] === 0 && PIN_DAY[s] !== d ? PIN_WEIGHT[s] : 0;
      for (let p = 0; p <= len; p++) {
        if (!dirty && scanResult.c2 < Infinity) {
          const lb = PRUNE_COEFF * travelDelta(order, len, p, s, d) + softPin + noise;
          if (lb >= scanResult.c2) continue;
        }
        if (!relationsAllow(sol, s, d, p)) continue;
        const nlen = spliceInto(scratchA, order, len, p, s);
        const r = evalDay(d, scratchA, nlen, !dirty, false);
        if (!r.ok) continue;
        if (dirty && (r.breachCnt > sol.breachCnt[d] || r.breachMin > sol.breachMin[d])) continue;
        const nc =
          r.travel * WEIGHT_TRAVEL +
          r.wait * WEIGHT_WAIT +
          r.compress * WEIGHT_COMPRESSION +
          r.soft +
          (dirty ? r.breachMin * BREACH_PER_MIN + r.breachCnt * BREACH_EACH : 0);
        const delta = nc - oldCost + softPin + noise;
        if (delta < scanResult.c1) {
          scanResult.d2 = scanResult.d1;
          scanResult.p2 = scanResult.p1;
          scanResult.c2 = scanResult.c1;
          scanResult.d1 = d;
          scanResult.p1 = p;
          scanResult.c1 = delta;
        } else if (delta < scanResult.c2) {
          scanResult.d2 = d;
          scanResult.p2 = p;
          scanResult.c2 = delta;
        }
      }
    }
  }

  /** Least-bad placement ignoring feasibility — so a hard `must` is never cut. */
  function scanForced(sol: Sol, s: number): void {
    scanResult.d1 = -1;
    scanResult.p1 = -1;
    scanResult.c1 = Infinity;
    const pinned = PIN_DAY[s] >= 0 && PIN_HARD[s] === 1 ? PIN_DAY[s] : -1;
    for (let d = 0; d < D; d++) {
      if (pinned >= 0 && d !== pinned) continue;
      const order = sol.order[d];
      const len = order.length;
      const oldCost = dayCost(sol, d);
      for (let p = 0; p <= len; p++) {
        const relPen = relationsAllow(sol, s, d, p) ? 0 : BREACH_EACH;
        const nlen = spliceInto(scratchA, order, len, p, s);
        const r = evalDay(d, scratchA, nlen, false, false);
        const nc =
          r.travel * WEIGHT_TRAVEL +
          r.wait * WEIGHT_WAIT +
          r.compress * WEIGHT_COMPRESSION +
          r.soft +
          r.breachMin * BREACH_PER_MIN +
          r.breachCnt * BREACH_EACH;
        const delta = nc - oldCost + relPen;
        if (delta < scanResult.c1) {
          scanResult.c1 = delta;
          scanResult.d1 = d;
          scanResult.p1 = p;
        }
      }
    }
  }

  function insertAt(sol: Sol, s: number, d: number, p: number): void {
    sol.order[d].splice(p, 0, s);
    commitDay(sol, d);
  }

  function removeStop(sol: Sol, s: number): number {
    const d = sol.dayOf[s];
    if (d < 0) return -1;
    const order = sol.order[d];
    const p = order.indexOf(s); // not sol.pos: batched removals leave pos stale
    if (p < 0) return -1;
    order.splice(p, 1);
    sol.dayOf[s] = -1;
    sol.pos[s] = -1;
    return d;
  }

  // -------------------------------------------------------------------------
  // Repair operators
  // -------------------------------------------------------------------------

  const touchedFlag = new Uint8Array(D);
  let touchedList: number[] = [];
  function touch(d: number): void {
    if (d >= 0 && touchedFlag[d] === 0) {
      touchedFlag[d] = 1;
      touchedList.push(d);
    }
  }
  function clearTouched(): void {
    for (const d of touchedList) touchedFlag[d] = 0;
    touchedList = [];
  }

  function repairGreedy(sol: Sol, pool: number[], noise: boolean): number[] {
    const failed: number[] = [];
    const noiseAmp = noise ? NOISE_FRAC * MEAN_TRAVEL : 0;
    for (let tier = 0; tier <= 2; tier++) {
      const tierStops = pool.filter((s) => PRIO[s] === tier);
      if (tierStops.length === 0) continue;
      for (const s of rng.shuffle(tierStops)) {
        scanInsertions(sol, s, noiseAmp);
        if (scanResult.d1 < 0 || scanResult.c1 >= DROP_COST[s]) {
          failed.push(s);
          continue;
        }
        insertAt(sol, s, scanResult.d1, scanResult.p1);
        touch(scanResult.d1);
      }
    }
    return failed;
  }

  const regC1 = new Float64Array(N);
  const regC2 = new Float64Array(N);
  const regD1 = new Int32Array(N);
  const regP1 = new Int32Array(N);
  const regD2 = new Int32Array(N);
  const regValid = new Uint8Array(N);

  function repairRegret(sol: Sol, pool: number[], noise: boolean): number[] {
    const failed: number[] = [];
    const noiseAmp = noise ? NOISE_FRAC * MEAN_TRAVEL : 0;
    for (let tier = 0; tier <= 2; tier++) {
      const remaining = rng.shuffle(pool.filter((s) => PRIO[s] === tier));
      for (const s of remaining) regValid[s] = 0;
      let left = remaining.length;
      while (left > 0) {
        let pickIdx = -1;
        let bestRegret = -Infinity;
        let bestCost = Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const s = remaining[i];
          if (s < 0) continue;
          if (regValid[s] === 0) {
            scanInsertions(sol, s, noiseAmp);
            regC1[s] = scanResult.c1;
            regC2[s] = scanResult.c2;
            regD1[s] = scanResult.d1;
            regP1[s] = scanResult.p1;
            regD2[s] = scanResult.d2;
            regValid[s] = 1;
          }
          if (regD1[s] < 0 || regC1[s] >= DROP_COST[s]) continue;
          const regret = regC2[s] === Infinity ? Number.MAX_SAFE_INTEGER : regC2[s] - regC1[s];
          if (regret > bestRegret || (regret === bestRegret && regC1[s] < bestCost)) {
            bestRegret = regret;
            bestCost = regC1[s];
            pickIdx = i;
          }
        }
        if (pickIdx < 0) break;
        const s = remaining[pickIdx];
        const d = regD1[s];
        insertAt(sol, s, d, regP1[s]);
        touch(d);
        remaining[pickIdx] = -1;
        left--;
        for (let i = 0; i < remaining.length; i++) {
          const q = remaining[i];
          if (q < 0 || regValid[q] === 0) continue;
          if (regD1[q] === d || regD2[q] === d) regValid[q] = 0;
        }
      }
      for (const s of remaining) if (s >= 0) failed.push(s);
    }
    return failed;
  }

  /** Never silently cut: an unplaced hard `must` is forced in at its least-bad spot. */
  function forceMusts(sol: Sol, failed: number[]): number[] {
    const stillOut: number[] = [];
    for (const s of failed) {
      if (DROP_COST[s] !== DROP_PENALTY_MUST) {
        stillOut.push(s);
        continue;
      }
      scanForced(sol, s);
      if (scanResult.d1 < 0) {
        stillOut.push(s);
        continue;
      }
      insertAt(sol, s, scanResult.d1, scanResult.p1);
      touch(scanResult.d1);
    }
    return stillOut;
  }

  // -------------------------------------------------------------------------
  // Destroy operators
  // -------------------------------------------------------------------------

  function scheduledStops(sol: Sol): number[] {
    const out: number[] = [];
    for (let i = 0; i < N; i++) if (sol.dayOf[i] >= 0) out.push(i);
    return out;
  }

  function biasedIndex(n: number): number {
    return Math.floor(Math.pow(rng.next(), SELECT_EXP) * n);
  }

  function destroyRandom(sol: Sol, k: number): number[] {
    const pool = rng.shuffle(scheduledStops(sol));
    const removed = pool.slice(0, Math.min(k, pool.length));
    for (const s of removed) touch(removeStop(sol, s));
    return removed;
  }

  function destroyWorst(sol: Sol, k: number): number[] {
    const sched = scheduledStops(sol);
    const gains = new Float64Array(sched.length);
    for (let i = 0; i < sched.length; i++) {
      const s = sched[i];
      const d = sol.dayOf[s];
      const order = sol.order[d];
      const len = spliceOut(scratchB, order, order.length, sol.pos[s]);
      const r = evalDay(d, scratchB, len, false, false);
      const without =
        r.travel * WEIGHT_TRAVEL +
        r.wait * WEIGHT_WAIT +
        r.compress * WEIGHT_COMPRESSION +
        r.soft +
        r.breachMin * BREACH_PER_MIN +
        r.breachCnt * BREACH_EACH;
      gains[i] = dayCost(sol, d) - without;
    }
    const ranked = sched.map((_, i) => i).sort((a, b) => gains[b] - gains[a] || sched[a] - sched[b]);
    const removed: number[] = [];
    while (removed.length < k && ranked.length > 0) {
      const pick = biasedIndex(ranked.length);
      const s = sched[ranked[pick]];
      ranked.splice(pick, 1);
      removed.push(s);
      touch(removeStop(sol, s));
    }
    return removed;
  }

  function destroyShaw(sol: Sol, k: number): number[] {
    const sched = scheduledStops(sol);
    if (sched.length === 0) return [];
    for (let d = 0; d < D; d++) evalDay(d, sol.order[d], sol.order[d].length, false, true);
    const removed: number[] = [];
    const live = sched.slice();
    const seedPos = rng.int(live.length);
    removed.push(live[seedPos]);
    live.splice(seedPos, 1);
    while (removed.length < k && live.length > 0) {
      const ref = removed[rng.int(removed.length)];
      const refStart = schedStart[ref];
      const refDay = sol.dayOf[ref];
      const scored = live
        .map((s) => ({
          s,
          r:
            0.6 * (DIST[ref * N + s] / MAX_DIST) +
            0.25 * (Math.abs(schedStart[s] - refStart) / MAX_DAY_LEN) +
            0.15 * (sol.dayOf[s] === refDay ? 0 : 1),
        }))
        .sort((a, b) => a.r - b.r || a.s - b.s);
      const s = scored[biasedIndex(scored.length)].s;
      live.splice(live.indexOf(s), 1);
      removed.push(s);
    }
    for (const s of removed) touch(removeStop(sol, s));
    return removed;
  }

  function destroySegment(sol: Sol, k: number): number[] {
    const nonEmpty: number[] = [];
    for (let d = 0; d < D; d++) if (sol.order[d].length > 0) nonEmpty.push(d);
    if (nonEmpty.length === 0) return [];
    const d = nonEmpty[rng.int(nonEmpty.length)];
    const order = sol.order[d];
    const runLen = Math.min(k, order.length);
    const startAt = rng.int(order.length - runLen + 1);
    const removed = order.slice(startAt, startAt + runLen);
    for (const s of removed) removeStop(sol, s);
    touch(d);
    return removed;
  }

  function destroyDay(sol: Sol, k: number): number[] {
    const nonEmpty: number[] = [];
    for (let d = 0; d < D; d++) if (sol.order[d].length > 0) nonEmpty.push(d);
    if (nonEmpty.length === 0) return [];
    if (nonEmpty.length === 1) return destroySegment(sol, k); // a full teardown = a restart
    const d = nonEmpty[rng.int(nonEmpty.length)];
    const removed = sol.order[d].slice();
    for (const s of removed) removeStop(sol, s);
    touch(d);
    return removed;
  }

  const destroyOps: Array<{ name: string; fn: (sol: Sol, k: number) => number[] }> = [
    { name: "random", fn: destroyRandom },
    { name: "worst", fn: destroyWorst },
    { name: "shaw", fn: destroyShaw },
    { name: "segment", fn: destroySegment },
    { name: "dayTeardown", fn: destroyDay },
  ];
  const repairOps: Array<{
    name: string;
    fn: (sol: Sol, pool: number[], noise: boolean) => number[];
  }> = [
    { name: "greedy", fn: repairGreedy },
    { name: "regret2", fn: repairRegret },
  ];

  // -------------------------------------------------------------------------
  // Local search
  // -------------------------------------------------------------------------

  function dayHasPrecedence(sol: Sol, d: number): boolean {
    for (const s of sol.order[d]) if (succ[s].length || pred[s].length) return true;
    return false;
  }

  function reverseSegment(a: number[], i: number, j: number): void {
    while (i < j) {
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
      i++;
      j--;
    }
  }

  function dayPrecedenceOk(sol: Sol, d: number, order: number[], len: number): boolean {
    for (let i = 0; i < len; i++) {
      for (const q of succ[order[i]]) {
        if (sol.dayOf[q] !== d) continue;
        for (let j = 0; j < i; j++) if (order[j] === q) return false;
      }
    }
    return true;
  }

  function twoOptDay(sol: Sol, d: number): boolean {
    const order = sol.order[d];
    const len = order.length;
    if (len < 4) return false;
    const checkPrec = dayHasPrecedence(sol, d);
    const reach = len > 16 ? 6 : len;
    let improvedAny = false;
    for (let pass = 0; pass < 2; pass++) {
      let improved = false;
      let cur = dayCost(sol, d);
      for (let i = 0; i < len - 1; i++) {
        for (let j = i + 1; j < len && j - i <= reach; j++) {
          reverseSegment(order, i, j);
          let ok = !checkPrec || dayPrecedenceOk(sol, d, order, len);
          let nc = Infinity;
          if (ok) {
            const r = evalDay(d, order, len, true, false);
            ok = r.ok;
            if (ok)
              nc =
                r.travel * WEIGHT_TRAVEL +
                r.wait * WEIGHT_WAIT +
                r.compress * WEIGHT_COMPRESSION +
                r.soft;
          }
          if (ok && nc < cur - 1e-9) {
            commitDay(sol, d);
            cur = dayCost(sol, d);
            improved = true;
            improvedAny = true;
          } else {
            reverseSegment(order, i, j);
          }
        }
      }
      if (!improved) break;
    }
    if (improvedAny) commitDay(sol, d);
    return improvedAny;
  }

  /** Descend to a local optimum under intra-day 2-opt, Or-opt relocation across
   *  days, and re-admission of a dropped stop. */
  function polishSolution(sol: Sol): void {
    for (let round = 0; round < 8; round++) {
      let improved = false;
      for (let d = 0; d < D; d++) if (twoOptDay(sol, d)) improved = true;

      for (const s of scheduledStops(sol)) {
        const d0 = sol.dayOf[s];
        const p0 = sol.pos[s];
        const before = dayCost(sol, d0);
        removeStop(sol, s);
        commitDay(sol, d0);
        const gain = before - dayCost(sol, d0);
        scanInsertions(sol, s, 0);
        const keepBest = scanResult.d1 >= 0 ? Math.min(scanResult.c1, gain) : gain;
        if (DROP_COST[s] !== DROP_PENALTY_MUST && DROP_COST[s] < keepBest - 1e-9) {
          improved = true; // leave it out
        } else if (scanResult.d1 >= 0 && scanResult.c1 < gain - 1e-9) {
          insertAt(sol, s, scanResult.d1, scanResult.p1);
          improved = true;
        } else {
          insertAt(sol, s, d0, p0); // exact restoration
        }
      }

      const out: number[] = [];
      for (let i = 0; i < N; i++) if (sol.dayOf[i] < 0) out.push(i);
      out.sort((a, b) => PRIO[a] - PRIO[b] || a - b);
      for (const s of out) {
        scanInsertions(sol, s, 0);
        if (scanResult.d1 >= 0 && scanResult.c1 < DROP_COST[s] - 1e-9) {
          insertAt(sol, s, scanResult.d1, scanResult.p1);
          improved = true;
        }
      }

      if (!improved) break;
    }
    recomputeCost(sol);
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  function construct(): Sol {
    const sol = newSol();
    const pinned: number[] = [];
    const free: number[] = [];
    for (let i = 0; i < N; i++) (PIN_DAY[i] >= 0 ? pinned : free).push(i);

    const byPriorityThenTopo = (a: number, b: number): number =>
      PRIO[a] - PRIO[b] || topo[a] - topo[b] || a - b;
    pinned.sort(byPriorityThenTopo);
    free.sort(byPriorityThenTopo);

    const failed: number[] = [];
    for (const s of pinned.concat(free)) {
      scanInsertions(sol, s, 0);
      if (scanResult.d1 < 0 || scanResult.c1 >= DROP_COST[s]) {
        failed.push(s);
        continue;
      }
      insertAt(sol, s, scanResult.d1, scanResult.p1);
    }
    forceMusts(sol, failed);
    for (let d = 0; d < D; d++) commitDay(sol, d);
    recomputeCost(sol);
    polishSolution(sol);
    return sol;
  }

  // -------------------------------------------------------------------------
  // Main ALNS loop
  // -------------------------------------------------------------------------

  let bestScoreForProgress = 0;
  let lastProgressAt = startedAt;
  function emit(frac: number, phase: string): void {
    if (!onProgress) return;
    const pct = pFrom + clamp(frac, 0, 1) * (pTo - pFrom);
    onProgress({ pct, bestScore: bestScoreForProgress, phase });
    lastProgressAt = Date.now();
  }

  emit(0, "construct");
  const cur = construct();
  const best = newSol();
  copyInto(best, cur);
  bestScoreForProgress = best.cost;
  const cand = newSol();

  const refDelta = Math.max(1, 0.5 * MEAN_TRAVEL, T0_WORSE_FRAC * Math.max(1, cur.base));
  const T0 = refDelta / Math.log(1 / T0_ACCEPT_PROB);
  let T = T0;
  const alpha = Math.pow(T_END_RATIO, 1 / Math.max(1, ITER_CAP));
  const STAGNATION_LIMIT = Math.max(400, Math.round(ITER_CAP * STAGNATION_FRAC));
  let sinceBest = 0;

  const dw = new Float64Array(destroyOps.length).fill(1);
  const rw = new Float64Array(repairOps.length).fill(1);
  const dScore = new Float64Array(destroyOps.length);
  const rScore = new Float64Array(repairOps.length);
  const dUse = new Float64Array(destroyOps.length);
  const rUse = new Float64Array(repairOps.length);

  function roulette(w: Float64Array): number {
    let total = 0;
    for (let i = 0; i < w.length; i++) total += w[i];
    let x = rng.next() * total;
    for (let i = 0; i < w.length; i++) {
      x -= w[i];
      if (x <= 0) return i;
    }
    return w.length - 1;
  }

  function updateWeights(): void {
    for (let i = 0; i < dw.length; i++) {
      if (dUse[i] > 0) dw[i] = (1 - REACTION) * dw[i] + REACTION * (dScore[i] / dUse[i]);
      dScore[i] = 0;
      dUse[i] = 0;
      if (dw[i] < 0.05) dw[i] = 0.05;
    }
    for (let i = 0; i < rw.length; i++) {
      if (rUse[i] > 0) rw[i] = (1 - REACTION) * rw[i] + REACTION * (rScore[i] / rUse[i]);
      rScore[i] = 0;
      rUse[i] = 0;
      if (rw[i] < 0.05) rw[i] = 0.05;
    }
  }

  for (let iter = 0; iter < ITER_CAP; iter++) {
    if (iter % TIME_CHECK_EVERY === 0) {
      if (opts.signal?.aborted) break;
      if (useWallClock && Date.now() - startedAt >= timeBudgetMs) break;
      if (Date.now() - startedAt >= hardStopMs) break; // safety net — even with iterCap
    }

    copyInto(cand, cur);
    clearTouched();

    const di = roulette(dw);
    const ri = roulette(rw);

    let scheduledCount = 0;
    for (let i = 0; i < N; i++) if (cand.dayOf[i] >= 0) scheduledCount++;
    const frac = REMOVE_FRAC_MIN + rng.next() * (REMOVE_FRAC_MAX - REMOVE_FRAC_MIN);
    const k = clamp(Math.round(frac * scheduledCount), 1, Math.max(1, scheduledCount));

    destroyOps[di].fn(cand, k);
    for (const d of touchedList) commitDay(cand, d);

    const pool: number[] = [];
    for (let i = 0; i < N; i++) if (cand.dayOf[i] < 0) pool.push(i);

    const useNoise = rng.next() < 0.5;
    const failed = repairOps[ri].fn(cand, pool, useNoise);
    forceMusts(cand, failed);
    for (const d of touchedList) commitDay(cand, d);
    recomputeCost(cand);

    const delta = cand.cost - cur.cost;
    let accept = false;
    if (delta < 0) accept = true;
    else if (T > 1e-9 && rng.next() < Math.exp(-delta / T)) accept = true;

    let sigma = 0;
    if (accept) {
      for (const d of touchedList) twoOptDay(cand, d);
      recomputeCost(cand);
      sigma = cand.cost < cur.cost ? SIGMA_BETTER : SIGMA_ACCEPTED_WORSE;
      copyInto(cur, cand);
      if (cur.cost < best.cost - 1e-9) {
        copyInto(best, cur);
        bestScoreForProgress = best.cost;
        sigma = SIGMA_NEW_BEST;
        sinceBest = -1;
      }
    }
    sinceBest++;
    if (sinceBest >= STAGNATION_LIMIT) {
      copyInto(cur, best);
      T = Math.max(T, T0 * REHEAT_FRAC);
      sinceBest = 0;
    }

    dScore[di] += sigma;
    dUse[di] += 1;
    rScore[ri] += sigma;
    rUse[ri] += 1;
    if ((iter + 1) % SEGMENT_LEN === 0) updateWeights();
    T *= alpha;

    if (iter % 32 === 0 && onProgress && Date.now() - lastProgressAt >= PROGRESS_MS) {
      const byIter = (iter + 1) / ITER_CAP;
      const byTime = timeBudgetMs > 0 ? (Date.now() - startedAt) / timeBudgetMs : 0;
      emit(Math.max(byIter, byTime), "search");
    }
  }

  clearTouched();
  emit(1, "polish");
  polishSolution(best);
  bestScoreForProgress = best.cost;

  // -------------------------------------------------------------------------
  // Materialise
  // -------------------------------------------------------------------------

  const visits: EngineVisit[] = [];
  for (let d = 0; d < D; d++) {
    const order = best.order[d];
    if (order.length === 0) continue;
    evalDay(d, order, order.length, false, true);
    for (const s of order) {
      visits.push({
        key: keyOf[s],
        dayIndex: d,
        arriveMin: schedArrive[s],
        startMin: schedStart[s],
        departMin: schedDepart[s],
      });
    }
  }
  visits.sort((a, b) => a.dayIndex - b.dayIndex || a.startMin - b.startMin);
  const dropped: string[] = [];
  for (let i = 0; i < N; i++) if (best.dayOf[i] < 0) dropped.push(keyOf[i]);

  return { visits, dropped };
}
