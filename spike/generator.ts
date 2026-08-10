// E1 spike — seeded, feasible-by-construction problem generator. The planted
// solution IS the ground truth a solver is graded against, so the one thing
// this file may never do is emit a planted solution that fails its own
// evaluate() call. Everything else (geometry, constraint placement) is
// deliberately "good enough for a spike", not production-grade.
//
// ALL randomness flows through a single createRng(seed) instance, in a fixed
// call order, so generate() is a pure function of `spec` — required for the
// selfcheck's determinism assertion and for cached benchmark artifacts to be
// reproducible from a stored seed.
//
// JUDGMENT CALL — priority is assigned AFTER scheduling, not before (spec's
// step 2 lists priority before step 3's layout). PACE_BUDGETS.maxEffortPoints
// is small (8/12/16) relative to the tested stop counts (12/25/40) — at
// stops=40, pace can admit roughly maxEffortPoints/1.95 ≈ 4-8 stops per day
// regardless of duration, so days=1 cells CANNOT schedule every stop no
// matter how clever the packing is. If priority were assigned first, a
// "must" stop could land in the unschedulable tail and force a genuine
// dropped-must violation with no way out. Deciding the SCHEDULE first (via
// capacity-aware greedy placement) and biasing "must" toward the scheduled
// set afterward makes infeasibility structurally impossible instead of
// merely unlikely. Stops that don't fit anywhere become planted.dropped
// (should/could only) — a large, high-scoring but feasible plan, which is
// exactly what "feasible-by-construction" requires.

import { createRng, type Rng } from "../src/lib/util/rng";
import { evaluate } from "./evaluator";
import {
  EFFORT_POINTS,
  PACE_BUDGETS,
  travelMin as computeTravelMin,
  type Effort,
  type Pace,
  type Priority,
  type SpikeDay,
  type SpikeProblem,
  type SpikeRelation,
  type SpikeSolution,
  type SpikeStop,
  type SpikeVisit,
  type WeeklyHours,
  type Window,
} from "./ir";

export type Density = "sparse" | "medium" | "dense";

export type GenerateSpec = {
  seed: number;
  stops: number;
  days: number;
  density: Density;
  conflicts?: number;
};

// Synthetic constants — not spec-mandated randomness, just fixed knobs.
const SPEED_KM_PER_MIN = 0.5; // ~30km/h blended walk/transit speed
const DAY_START = 540; // 09:00
const DAY_END = 1320; // 22:00
const BOX_KM = 10;
const CLUSTER_SIGMA_KM = 1;
const ADMIT_COUNT_CAP = 25; // runaway guard on pass-1 admission; effort binds first at these budgets

const DENSITY_PACE: Record<Density, Pace> = { sparse: "relaxed", medium: "balanced", dense: "packed" };
const DENSITY_RATE: Record<Density, number> = { sparse: 0.2, medium: 0.5, dense: 0.85 };

export function generate(spec: GenerateSpec): { problem: SpikeProblem; planted: SpikeSolution } {
  const rng = createRng(spec.seed);

  // -----------------------------------------------------------------------
  // Phase A — geometry + physical attributes. No priority yet (see header).
  // -----------------------------------------------------------------------
  const numClusters = 2 + rng.int(3); // 2..4
  const centers = Array.from({ length: numClusters }, () => ({
    x: rng.next() * BOX_KM,
    y: rng.next() * BOX_KM,
  }));

  const stops: SpikeStop[] = [];
  for (let i = 0; i < spec.stops; i++) {
    const center = centers[i % numClusters]; // round-robin cluster assignment
    const x = center.x + gaussian(rng) * CLUSTER_SIGMA_KM;
    const y = center.y + gaussian(rng) * CLUSTER_SIGMA_KM;
    const effort = weightedPick<Effort>(rng, [
      ["low", 0.3],
      ["medium", 0.45],
      ["high", 0.25],
    ]);
    const typicalMin = 30 + rng.int(91); // 30..120
    stops.push({
      id: `stop-${i}`,
      x,
      y,
      duration: {
        minMin: Math.round(typicalMin * 0.7),
        typicalMin,
        maxMin: Math.round(typicalMin * 1.3),
      },
      effort,
      priority: "could", // placeholder — real value assigned in Phase C
    });
  }
  const stopIndexById = new Map(stops.map((s, i) => [s.id, i]));

  const pace = DENSITY_PACE[spec.density];
  const budgets = PACE_BUDGETS[pace];
  const startWeekday = rng.int(7);
  const days: SpikeDay[] = Array.from({ length: spec.days }, (_, d) => ({
    weekday: (startWeekday + d) % 7,
    window: { startMin: DAY_START, endMin: DAY_END },
  }));

  // -----------------------------------------------------------------------
  // Phase B — cluster-major queue, capacity-aware day placement. Pass 1
  // admits by cumulative effort budget alone (cheap, order-independent);
  // pass 2 builds the real NN route + sequential timing and trims from the
  // tail on overflow, requeuing the trimmed stop for the next day. Whatever
  // survives in the queue after the last day is a forced drop.
  // -----------------------------------------------------------------------
  const clusterOrder: number[] = [];
  for (let c = 0; c < numClusters; c++) {
    for (let i = 0; i < spec.stops; i++) {
      if (i % numClusters === c) clusterOrder.push(i);
    }
  }
  const queue = [...clusterOrder];
  const plantedVisits: SpikeVisit[] = [];

  for (let d = 0; d < spec.days; d++) {
    const admitted: number[] = [];
    let effortSum = 0;
    while (queue.length > 0) {
      const idx = queue[0];
      const pts = EFFORT_POINTS[stops[idx].effort];
      if (effortSum + pts > budgets.maxEffortPoints) break;
      if (admitted.length >= ADMIT_COUNT_CAP) break;
      admitted.push(idx);
      effortSum += pts;
      queue.shift();
    }

    let dayIdxs = admitted;
    while (dayIdxs.length > 0) {
      const ordered = nearestNeighborOrder(dayIdxs, stops);
      const visits = scheduleDay(ordered, d, days[d], budgets.minGapMin, stops);
      const activeMin = visits[visits.length - 1].departMin - visits[0].arriveMin;
      const overflow =
        activeMin > budgets.maxActiveMin || visits.some((v) => v.departMin > days[d].window.endMin);
      if (!overflow) {
        plantedVisits.push(...visits);
        break;
      }
      // Overflow: requeue the last-routed stop for a later day and retry.
      const removedId = ordered[ordered.length - 1];
      queue.unshift(removedId);
      dayIdxs = dayIdxs.filter((i) => i !== removedId);
    }
  }
  const forcedDropIdxs = [...queue]; // never fit anywhere within the pace budget

  // -----------------------------------------------------------------------
  // Phase C — priority, decided from the schedule outcome (see header).
  // -----------------------------------------------------------------------
  const scheduledIdxSet = new Set(plantedVisits.map((v) => stopIndexById.get(v.stopId)!));
  for (let i = 0; i < stops.length; i++) {
    stops[i].priority = scheduledIdxSet.has(i)
      ? weightedPick<Priority>(rng, [
          ["must", 0.25],
          ["should", 0.45],
          ["could", 0.3],
        ])
      : weightedPick<Priority>(rng, [
          ["should", 0.6], // 0.45 / (0.45+0.30), renormalized without "must"
          ["could", 0.4],
        ]);
  }
  const scheduledIdxs = [...scheduledIdxSet]; // Set preserves insertion order — deterministic
  const visitByIdx = new Map(plantedVisits.map((v) => [stopIndexById.get(v.stopId)!, v]));

  // -----------------------------------------------------------------------
  // Phase D — constraints derived from the planted truth (with jitter), so
  // they hold BY CONSTRUCTION. Only scheduled stops get window/hours/pin —
  // there is no "planted start time" to derive them from for a dropped stop.
  // -----------------------------------------------------------------------
  const rate = DENSITY_RATE[spec.density];
  const constrainedCount = Math.min(scheduledIdxs.length, Math.round(rate * spec.stops));
  const constrained = rng.shuffle(scheduledIdxs).slice(0, constrainedCount);

  for (const idx of constrained) {
    const v = visitByIdx.get(idx)!;
    const day = days[v.dayIndex];
    const jitterLow = 30 + rng.int(61); // 30..90
    const jitterHigh = 30 + rng.int(61);
    stops[idx].window = {
      startMin: Math.max(day.window.startMin, v.startMin - jitterLow),
      endMin: Math.min(day.window.endMin, v.startMin + jitterHigh),
    };
  }

  for (const idx of constrained) {
    if (rng.next() >= 0.5) continue; // ~half of the constrained stops get hours
    const v = visitByIdx.get(idx)!;
    const day = days[v.dayIndex];
    const openPadStart = 30 + rng.int(61);
    const openPadEnd = 30 + rng.int(61);
    const byWeekday: Window[][] = Array.from({ length: 7 }, () => [{ startMin: 600, endMin: 1260 }]);
    byWeekday[day.weekday] = [
      { startMin: Math.max(0, v.startMin - openPadStart), endMin: Math.min(1440, v.departMin + openPadEnd) },
    ];
    if (rng.next() < 0.2) {
      // Close exactly one OTHER weekday — never the planted one.
      const otherWeekday = (day.weekday + 1 + rng.int(6)) % 7;
      byWeekday[otherWeekday] = [];
    }
    const hours: WeeklyHours = { byWeekday };
    if (rng.next() < 0.25) {
      hours.lastEntryMin = v.startMin + rng.int(31); // always >= planted startMin
    }
    stops[idx].hours = hours;
  }

  const relations: SpikeRelation[] = [];
  if (spec.density === "dense") {
    const globalOrder = [...plantedVisits].sort((a, b) => a.dayIndex - b.dayIndex || a.startMin - b.startMin);

    // 2 precedence chains, each following actual planted trip order.
    for (let c = 0; c < 2; c++) {
      const length = 2 + rng.int(3); // 2..4
      if (globalOrder.length < length) continue;
      const start = rng.int(globalOrder.length - length + 1);
      for (let i = start; i < start + length - 1; i++) {
        relations.push({
          kind: "precedence",
          beforeId: globalOrder[i].stopId,
          afterId: globalOrder[i + 1].stopId,
        });
      }
    }

    // 2 meal blocks per day, placed outside every planted startMin that day.
    for (let d = 0; d < spec.days; d++) {
      const dayVisits = plantedVisits.filter((v) => v.dayIndex === d);
      if (dayVisits.length === 0) continue;
      const blocks: Window[] = [];
      const first = pickMealBlock(rng, days[d], dayVisits, undefined);
      if (first) blocks.push(first);
      const second = pickMealBlock(rng, days[d], dayVisits, first ?? undefined);
      if (second) blocks.push(second);
      if (blocks.length > 0) days[d].mealBlocks = blocks;
    }

    // A few sameDay pairs from stops actually co-scheduled on the same day.
    const multiVisitDays = days
      .map((_, d) => d)
      .filter((d) => plantedVisits.filter((v) => v.dayIndex === d).length >= 2);
    const chosenDays = rng.shuffle(multiVisitDays).slice(0, Math.min(3, multiVisitDays.length));
    for (const d of chosenDays) {
      const pair = rng.shuffle(plantedVisits.filter((v) => v.dayIndex === d)).slice(0, 2);
      relations.push({ kind: "sameDay", aId: pair[0].stopId, bId: pair[1].stopId });
    }

    // pinnedDay on ~30% of scheduled stops, to their own actual planted day.
    for (const idx of scheduledIdxs) {
      if (rng.next() < 0.3) {
        const v = visitByIdx.get(idx)!;
        stops[idx].pinnedDay = { index: v.dayIndex, hardness: "hard" };
      }
    }
  }

  const problem: SpikeProblem = {
    seed: spec.seed,
    days,
    stops,
    relations,
    pace,
    speedKmPerMin: SPEED_KM_PER_MIN,
  };
  const planted: SpikeSolution = {
    visits: plantedVisits,
    dropped: forcedDropIdxs.map((i) => stops[i].id),
  };

  // -----------------------------------------------------------------------
  // Phase E — deliberate conflicts. Skips the feasibility assert below:
  // conflicts are specifically meant to break the planted solution so a
  // solver has something real to detect and fix.
  // -----------------------------------------------------------------------
  if (spec.conflicts && spec.conflicts > 0) {
    injectConflicts(rng, problem, planted, spec.conflicts);
    return { problem, planted };
  }

  const check = evaluate(problem, planted);
  if (!check.feasible) {
    throw new Error(
      `generator bug: planted solution infeasible for seed=${spec.seed} stops=${spec.stops} days=${spec.days} density=${spec.density}: ${JSON.stringify(check.violations)}`
    );
  }
  return { problem, planted };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Box-Muller — used only for the ~1km scatter of stops around cluster
// centres. rng.next() is in [0,1); nudge off 0 to avoid log(0) = -Infinity.
function gaussian(rng: Rng): number {
  const u1 = Math.max(rng.next(), 1e-9);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function weightedPick<T extends string>(rng: Rng, options: Array<[T, number]>): T {
  const r = rng.next();
  let acc = 0;
  for (const [value, weight] of options) {
    acc += weight;
    if (r < acc) return value;
  }
  return options[options.length - 1][0]; // float rounding fallback
}

// Greedy nearest-neighbour tour over stop indices, starting at indices[0].
function nearestNeighborOrder(indices: number[], stops: SpikeStop[]): number[] {
  if (indices.length <= 1) return [...indices];
  const remaining = indices.slice(1);
  const order = [indices[0]];
  let current = indices[0];
  while (remaining.length > 0) {
    let bestPos = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = Math.hypot(stops[current].x - stops[remaining[i]].x, stops[current].y - stops[remaining[i]].y);
      if (d < bestDist) {
        bestDist = d;
        bestPos = i;
      }
    }
    current = remaining.splice(bestPos, 1)[0];
    order.push(current);
  }
  return order;
}

// Sequential timing for one day's route: first visit starts at day open, and
// every later visit's gap is exactly travel + minGapMin — the tightest
// schedule that still satisfies travel-underrun/pace-gap by construction.
function scheduleDay(
  orderedIdxs: number[],
  dayIndex: number,
  day: SpikeDay,
  minGapMin: number,
  stops: SpikeStop[]
): SpikeVisit[] {
  const visits: SpikeVisit[] = [];
  let prevDepart: number | null = null;
  let prevIdx: number | null = null;
  for (const idx of orderedIdxs) {
    const stop = stops[idx];
    let arriveMin: number;
    let startMin: number;
    if (prevIdx === null) {
      arriveMin = day.window.startMin;
      startMin = arriveMin;
    } else {
      const travel = computeTravelMin(stops[prevIdx], stop, SPEED_KM_PER_MIN);
      arriveMin = prevDepart! + travel;
      startMin = arriveMin + minGapMin;
    }
    const departMin = startMin + stop.duration.typicalMin;
    visits.push({ stopId: stop.id, dayIndex, arriveMin, startMin, departMin });
    prevDepart = departMin;
    prevIdx = idx;
  }
  return visits;
}

// Random-search a 60min block inside the day that clashes with no planted
// startMin and (optionally) doesn't overlap a sibling block already placed.
function pickMealBlock(
  rng: Rng,
  day: SpikeDay,
  dayVisits: SpikeVisit[],
  avoid: Window | undefined
): Window | null {
  const BLOCK_LEN = 60;
  const span = day.window.endMin - day.window.startMin - BLOCK_LEN;
  if (span <= 0) return null;
  for (let attempt = 0; attempt < 50; attempt++) {
    const startMin = day.window.startMin + rng.int(span + 1);
    const endMin = startMin + BLOCK_LEN;
    const clashesVisit = dayVisits.some((v) => v.startMin >= startMin && v.startMin < endMin);
    const clashesOther = avoid ? !(endMin <= avoid.startMin || startMin >= avoid.endMin) : false;
    if (!clashesVisit && !clashesOther) return { startMin, endMin };
  }
  return null; // gave up — rare; the day just gets fewer meal blocks
}

// Mutates problem.stops/relations in place to plant `count` deliberate
// conflicts on top of an otherwise-feasible instance. Cycles window-shrink /
// reversed-precedence / pin-mismatch, falling back to window-shrink (always
// available given >=1 scheduled stop) when a kind's preconditions aren't met.
function injectConflicts(rng: Rng, problem: SpikeProblem, planted: SpikeSolution, count: number): void {
  const visitByStop = new Map(planted.visits.map((v) => [v.stopId, v]));
  const scheduledStops = problem.stops.filter((s) => visitByStop.has(s.id));
  if (scheduledStops.length === 0) return; // nothing to conflict against

  const globalOrder = [...planted.visits].sort((a, b) => a.dayIndex - b.dayIndex || a.startMin - b.startMin);

  for (let k = 0; k < count; k++) {
    const kind = k % 3;
    let applied = false;

    if (kind === 1 && globalOrder.length >= 2) {
      const i = rng.int(globalOrder.length - 1);
      const a = globalOrder[i]; // truly earlier in planted order
      const b = globalOrder[i + 1]; // truly later
      problem.relations.push({ kind: "precedence", beforeId: b.stopId, afterId: a.stopId }); // reversed
      applied = true;
    } else if (kind === 2 && problem.days.length >= 2) {
      const target = rng.pick(scheduledStops);
      const v = visitByStop.get(target.id)!;
      const otherDay = (v.dayIndex + 1 + rng.int(problem.days.length - 1)) % problem.days.length;
      target.pinnedDay = { index: otherDay, hardness: "hard" };
      applied = true;
    }

    if (!applied) {
      // window-shrink: always available with >=1 scheduled stop.
      const target = rng.pick(scheduledStops);
      const v = visitByStop.get(target.id)!;
      const day = problem.days[v.dayIndex];
      const roomAfter = day.window.endMin - v.startMin;
      target.window =
        roomAfter >= 65
          ? { startMin: v.startMin + 5, endMin: v.startMin + 65 }
          : { startMin: Math.max(day.window.startMin, v.startMin - 65), endMin: v.startMin - 5 };
    }
  }
}
