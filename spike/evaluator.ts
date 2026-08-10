// E1 spike — the ONE scorer both solver contenders (TS ALNS, CP-SAT) are
// judged against. This is the benchmark's ground truth: if this file is
// wrong, every downstream comparison is wrong in a way nobody will notice
// until E2. Builds against spike/ir.ts exactly as frozen — do not modify it.
//
// Hard vs soft: every bullet in the E1 spec is a HARD rule. A single
// violation makes the solution infeasible (score = Infinity) — there is no
// partial credit at the constraint level. "Soft" only describes the
// objective we minimize ONCE a solution is already feasible. We still
// enumerate every violation (not just the first) so a report can show a
// solver *how* infeasible its output was, not just that it was.
//
// Weight/penalty constants are named exports (not inlined) so the eventual
// benchmark report can print the objective's own recipe next to the score.

import {
  EFFORT_POINTS,
  PACE_BUDGETS,
  travelMin as computeTravelMin,
  type SpikeDay,
  type SpikeProblem,
  type SpikeSolution,
  type SpikeStop,
  type SpikeVisit,
} from "./ir";

export const WEIGHT_TRAVEL = 1.0;
export const WEIGHT_WAIT = 0.3;
export const WEIGHT_COMPRESSION = 0.5;
export const DROP_PENALTY_SHOULD = 200;
export const DROP_PENALTY_COULD = 60;

export type Violation = {
  code: string;
  detail: string;
  stopId?: string;
  dayIndex?: number;
  byMin?: number;
};

export type Evaluation = {
  feasible: boolean;
  violations: Violation[];
  score: number;
  breakdown: {
    travelMin: number;
    waitMin: number;
    dropPenalty: number;
    compressionPenalty: number;
  };
};

export function evaluate(problem: SpikeProblem, solution: SpikeSolution): Evaluation {
  const violations: Violation[] = [];
  const push = (v: Violation): void => {
    violations.push(v);
  };

  const stopById = new Map<string, SpikeStop>(problem.stops.map((s) => [s.id, s]));

  // ---------------------------------------------------------------------
  // Completeness: every problem stop in exactly one of visits/dropped, no
  // unknown ids. Unknown ids get their own violation per occurrence (each
  // occurrence is independently bogus); known ids get counted so we can
  // report missing/duplicate against the problem's real stop set.
  // ---------------------------------------------------------------------
  const knownCount = new Map<string, number>();
  for (const id of stopById.keys()) knownCount.set(id, 0);

  for (const v of solution.visits) {
    if (!stopById.has(v.stopId)) {
      push({
        code: "unknown-stop",
        detail: `visit references stopId "${v.stopId}" not in problem.stops`,
        stopId: v.stopId,
        dayIndex: v.dayIndex,
      });
      continue;
    }
    knownCount.set(v.stopId, (knownCount.get(v.stopId) ?? 0) + 1);
  }
  for (const id of solution.dropped) {
    if (!stopById.has(id)) {
      push({
        code: "unknown-stop",
        detail: `dropped references stopId "${id}" not in problem.stops`,
        stopId: id,
      });
      continue;
    }
    knownCount.set(id, (knownCount.get(id) ?? 0) + 1);
  }
  for (const [id, count] of knownCount) {
    if (count === 0) {
      push({ code: "missing-stop", detail: `stop "${id}" appears in neither visits nor dropped`, stopId: id });
    } else if (count > 1) {
      push({
        code: "duplicate-stop",
        detail: `stop "${id}" appears ${count} times across visits/dropped (expected exactly 1)`,
        stopId: id,
      });
    }
  }

  // "must" priority may never be dropped.
  for (const id of solution.dropped) {
    const stop = stopById.get(id);
    if (stop && stop.priority === "must") {
      push({ code: "dropped-must", detail: `must-priority stop "${id}" was dropped`, stopId: id });
    }
  }

  // First-occurrence map of scheduled visits, used by pinnedDay/relations
  // below. Duplicate occurrences are already flagged above; for "is this
  // stop scheduled, and where" we just need one answer per stop.
  const visitByStop = new Map<string, SpikeVisit>();
  for (const v of solution.visits) {
    if (!visitByStop.has(v.stopId)) visitByStop.set(v.stopId, v);
  }
  const droppedSet = new Set(solution.dropped);

  // pinnedDay: hard in the spike — a scheduled visit must land on the pinned
  // day. A dropped pinned stop is covered (if at all) by dropped-must above;
  // pinning itself says nothing about whether the stop must be scheduled.
  for (const stop of problem.stops) {
    if (!stop.pinnedDay) continue;
    const v = visitByStop.get(stop.id);
    if (v && v.dayIndex !== stop.pinnedDay.index) {
      push({
        code: "pin-violated",
        detail: `stop "${stop.id}" pinned to day ${stop.pinnedDay.index} but scheduled on day ${v.dayIndex}`,
        stopId: stop.id,
        dayIndex: v.dayIndex,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Per-visit checks that don't need day context: duration range and the
  // stop's own (day-concrete) window. Invalid dayIndex is flagged here too
  // (as "day-window") and such visits are excluded from the per-day grouping
  // below so we never index problem.days out of bounds.
  // ---------------------------------------------------------------------
  const byDay: SpikeVisit[][] = problem.days.map(() => []);
  for (const v of solution.visits) {
    const stop = stopById.get(v.stopId);
    if (!stop) continue; // already flagged as unknown-stop

    const actualDuration = v.departMin - v.startMin;
    if (actualDuration < stop.duration.minMin || actualDuration > stop.duration.maxMin) {
      const byMin =
        actualDuration < stop.duration.minMin
          ? stop.duration.minMin - actualDuration
          : actualDuration - stop.duration.maxMin;
      push({
        code: "duration-range",
        detail: `stop "${v.stopId}" duration ${actualDuration}min outside [${stop.duration.minMin}, ${stop.duration.maxMin}]`,
        stopId: v.stopId,
        dayIndex: v.dayIndex,
        byMin,
      });
    }

    if (stop.window) {
      if (v.startMin < stop.window.startMin || v.startMin > stop.window.endMin) {
        const byMin =
          v.startMin < stop.window.startMin
            ? stop.window.startMin - v.startMin
            : v.startMin - stop.window.endMin;
        push({
          code: "window",
          detail: `stop "${v.stopId}" starts at ${v.startMin} outside window [${stop.window.startMin}, ${stop.window.endMin}]`,
          stopId: v.stopId,
          dayIndex: v.dayIndex,
          byMin,
        });
      }
    }

    if (!Number.isInteger(v.dayIndex) || v.dayIndex < 0 || v.dayIndex >= problem.days.length) {
      push({
        code: "day-window",
        detail: `stop "${v.stopId}" has invalid dayIndex ${v.dayIndex} (problem has ${problem.days.length} day(s))`,
        stopId: v.stopId,
        dayIndex: v.dayIndex,
      });
      continue; // can't group into byDay
    }
    byDay[v.dayIndex].push(v);
  }

  const pace = PACE_BUDGETS[problem.pace];

  // ---------------------------------------------------------------------
  // Per-day checks: bounds, ordering, travel, hours, meal blocks, pace.
  // ---------------------------------------------------------------------
  problem.days.forEach((day: SpikeDay, dayIndex: number) => {
    const visits = [...byDay[dayIndex]].sort((a, b) => a.startMin - b.startMin);
    if (visits.length === 0) return;

    // Day bounds.
    const first = visits[0];
    if (first.arriveMin < day.window.startMin) {
      push({
        code: "day-window",
        detail: `day ${dayIndex} first arrival ${first.arriveMin} before day start ${day.window.startMin}`,
        stopId: first.stopId,
        dayIndex,
        byMin: day.window.startMin - first.arriveMin,
      });
    }
    for (const v of visits) {
      if (v.departMin > day.window.endMin) {
        push({
          code: "day-window",
          detail: `stop "${v.stopId}" departs ${v.departMin} after day end ${day.window.endMin}`,
          stopId: v.stopId,
          dayIndex,
          byMin: v.departMin - day.window.endMin,
        });
      }
    }

    // Ordering sanity + travel, walking consecutive pairs.
    for (let i = 0; i < visits.length; i++) {
      const v = visits[i];
      if (v.startMin < v.arriveMin) {
        push({
          code: "overlap",
          detail: `stop "${v.stopId}" starts (${v.startMin}) before it arrives (${v.arriveMin})`,
          stopId: v.stopId,
          dayIndex,
          byMin: v.arriveMin - v.startMin,
        });
      }
      if (i === 0) continue;
      const prev = visits[i - 1];
      if (v.arriveMin < prev.departMin) {
        push({
          code: "overlap",
          detail: `stop "${v.stopId}" arrives (${v.arriveMin}) before previous stop "${prev.stopId}" departs (${prev.departMin})`,
          stopId: v.stopId,
          dayIndex,
          byMin: prev.departMin - v.arriveMin,
        });
      }
      const prevStop = stopById.get(prev.stopId);
      const stop = stopById.get(v.stopId);
      if (prevStop && stop) {
        const need = computeTravelMin(prevStop, stop, problem.speedKmPerMin);
        if (v.arriveMin < prev.departMin + need) {
          push({
            code: "travel-underrun",
            detail: `stop "${v.stopId}" arrives ${v.arriveMin} but needs ${need}min travel from "${prev.stopId}" (departs ${prev.departMin})`,
            stopId: v.stopId,
            dayIndex,
            byMin: prev.departMin + need - v.arriveMin,
          });
        }
      }
    }

    // Hours (weekly, intersected against this day's weekday) + meal blocks.
    for (const v of visits) {
      const stop = stopById.get(v.stopId);
      if (!stop) continue;

      if (stop.hours) {
        const intervals = stop.hours.byWeekday[day.weekday] ?? [];
        const lastEntryOk = stop.hours.lastEntryMin === undefined || v.startMin <= stop.hours.lastEntryMin;
        const fits =
          lastEntryOk && intervals.some((iv) => v.startMin >= iv.startMin && v.departMin <= iv.endMin);
        if (!fits) {
          push({
            code: "hours",
            detail:
              intervals.length === 0
                ? `stop "${v.stopId}" is closed on weekday ${day.weekday}`
                : `stop "${v.stopId}" visit [${v.startMin}, ${v.departMin}] does not fit any open interval on weekday ${day.weekday}`,
            stopId: v.stopId,
            dayIndex,
          });
        }
      }

      for (const mb of day.mealBlocks ?? []) {
        if (v.startMin >= mb.startMin && v.startMin < mb.endMin) {
          push({
            code: "meal-block",
            detail: `stop "${v.stopId}" starts at ${v.startMin} inside meal block [${mb.startMin}, ${mb.endMin})`,
            stopId: v.stopId,
            dayIndex,
          });
        }
      }
    }

    // Pace budgets.
    const activeMin = visits[visits.length - 1].departMin - visits[0].arriveMin;
    if (activeMin > pace.maxActiveMin) {
      push({
        code: "pace-active",
        detail: `day ${dayIndex} active time ${activeMin}min exceeds ${problem.pace} budget ${pace.maxActiveMin}min`,
        dayIndex,
        byMin: activeMin - pace.maxActiveMin,
      });
    }
    const effortPoints = visits.reduce((sum, v) => {
      const stop = stopById.get(v.stopId);
      return sum + (stop ? EFFORT_POINTS[stop.effort] : 0);
    }, 0);
    if (effortPoints > pace.maxEffortPoints) {
      push({
        code: "pace-effort",
        detail: `day ${dayIndex} effort ${effortPoints}pts exceeds ${problem.pace} budget ${pace.maxEffortPoints}pts`,
        dayIndex,
      });
    }
    for (let i = 1; i < visits.length; i++) {
      const prev = visits[i - 1];
      const v = visits[i];
      const prevStop = stopById.get(prev.stopId);
      const stop = stopById.get(v.stopId);
      if (!prevStop || !stop) continue;
      const need = computeTravelMin(prevStop, stop, problem.speedKmPerMin) + pace.minGapMin;
      const gap = v.startMin - prev.departMin;
      if (gap < need) {
        push({
          code: "pace-gap",
          detail: `gap ${gap}min between "${prev.stopId}" and "${v.stopId}" under ${problem.pace} minimum (travel + minGapMin = ${need}min)`,
          stopId: v.stopId,
          dayIndex,
          byMin: need - gap,
        });
      }
    }
  });

  // ---------------------------------------------------------------------
  // Relations. A relation is vacuously satisfied whenever either endpoint
  // is dropped — there is nothing left to order/co-locate.
  // ---------------------------------------------------------------------
  for (const rel of problem.relations) {
    if (rel.kind === "precedence") {
      const before = visitByStop.get(rel.beforeId);
      const after = visitByStop.get(rel.afterId);
      if (droppedSet.has(rel.beforeId) || droppedSet.has(rel.afterId)) continue;
      if (!before || !after) continue; // unscheduled+not dropped is already flagged as missing-stop
      const beforeIsEarlier =
        before.dayIndex < after.dayIndex ||
        (before.dayIndex === after.dayIndex && before.startMin < after.startMin);
      if (!beforeIsEarlier) {
        push({
          code: "precedence",
          detail: `"${rel.beforeId}" must precede "${rel.afterId}" but does not`,
          stopId: rel.afterId,
        });
      }
    } else if (rel.kind === "sameDay") {
      if (droppedSet.has(rel.aId) || droppedSet.has(rel.bId)) continue;
      const a = visitByStop.get(rel.aId);
      const b = visitByStop.get(rel.bId);
      if (!a || !b) continue;
      if (a.dayIndex !== b.dayIndex) {
        push({
          code: "same-day",
          detail: `"${rel.aId}" (day ${a.dayIndex}) and "${rel.bId}" (day ${b.dayIndex}) must share a day`,
          stopId: rel.bId,
        });
      }
    } else {
      // notSameDay
      if (droppedSet.has(rel.aId) || droppedSet.has(rel.bId)) continue;
      const a = visitByStop.get(rel.aId);
      const b = visitByStop.get(rel.bId);
      if (!a || !b) continue;
      if (a.dayIndex === b.dayIndex) {
        push({
          code: "not-same-day",
          detail: `"${rel.aId}" and "${rel.bId}" must NOT share a day but both are on day ${a.dayIndex}`,
          stopId: rel.bId,
          dayIndex: a.dayIndex,
        });
      }
    }
  }

  // ---------------------------------------------------------------------
  // Soft objective. Computed unconditionally (useful for diagnostics even
  // on an infeasible solution) but score is forced to Infinity below unless
  // every hard rule above held.
  // ---------------------------------------------------------------------
  let travelMinTotal = 0;
  let waitMinTotal = 0;
  let compressionMinTotal = 0;
  for (const day of byDay) {
    const visits = [...day].sort((a, b) => a.startMin - b.startMin);
    for (let i = 0; i < visits.length; i++) {
      const v = visits[i];
      const stop = stopById.get(v.stopId);
      if (stop) {
        const actualDuration = v.departMin - v.startMin;
        compressionMinTotal += Math.max(0, stop.duration.typicalMin - actualDuration);
      }
      if (i === 0) continue; // first visit of a day: no predecessor, no idle gap
      const prev = visits[i - 1];
      const prevStop = stopById.get(prev.stopId);
      if (stop && prevStop) {
        const travel = computeTravelMin(prevStop, stop, problem.speedKmPerMin);
        travelMinTotal += travel;
        // Wait is STRUCTURAL: the idle gap between consecutive visits that
        // remains after travel — computed from starts/departs, never from the
        // solver's self-reported arriveMin. The original `start - arrive`
        // definition let a solver report arrive == start and zero its wait
        // penalty on a technicality (flagged by the ALNS build, 2026-08-10);
        // both contenders are now scored on the same physical quantity.
        // Mandatory pace minGap counts as wait for both solvers equally.
        waitMinTotal += Math.max(0, v.startMin - prev.departMin - travel);
      }
    }
  }

  let dropPenalty = 0;
  for (const id of solution.dropped) {
    const stop = stopById.get(id);
    if (!stop) continue;
    if (stop.priority === "should") dropPenalty += DROP_PENALTY_SHOULD;
    else if (stop.priority === "could") dropPenalty += DROP_PENALTY_COULD;
  }

  const compressionPenalty = WEIGHT_COMPRESSION * compressionMinTotal;
  const feasible = violations.length === 0;
  const score = feasible
    ? WEIGHT_TRAVEL * travelMinTotal + WEIGHT_WAIT * waitMinTotal + dropPenalty + compressionPenalty
    : Infinity;

  return {
    feasible,
    violations,
    score,
    breakdown: {
      travelMin: travelMinTotal,
      waitMin: waitMinTotal,
      dropPenalty,
      compressionPenalty,
    },
  };
}
