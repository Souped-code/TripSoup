// E5a — THE objective. Promoted (copied) from `spike/evaluator.ts`, which stays
// frozen as the historical artifact the E1 verdict was made on.
//
// This is the engine's internal ground truth AND its test oracle: the search in
// ./search optimises an approximation of this (it prices infeasibility so it can
// rank two bad answers, which this file refuses to do), and every engine test
// that asks "is this plan actually good" asks this file.
//
// Term for term, the spike's objective is preserved:
//
//     score = 1.0*travelMin + 0.3*waitMin + 0.5*compressionMin
//           + dropPenalties(200 should / 60 could)
//           + softPenalties                      <- NEW at E5
//
// ---------------------------------------------------------------------------
// THE THREE SEMANTICS THAT COST THE SPIKE THE MOST (do not "simplify" these)
// ---------------------------------------------------------------------------
//  1. WAIT IS STRUCTURAL: `max(0, start - prevDepart - travel)`, computed from
//     starts, departures and the travel model — NEVER from a solver's
//     self-reported `arriveMin`. A solver that reports arrive == start would
//     otherwise zero its own wait penalty on a technicality.
//  2. HOURS: the visit `[startMin, departMin]` must fit ENTIRELY inside ONE open
//     interval — never across two intervals of a split shift — and
//     `lastEntryMin` caps the START, not the departure.
//  3. PACE `maxActiveMin` IS THE DAY SPAN (last departure − first arrival), not
//     the sum of visit durations.
//
// ---------------------------------------------------------------------------
// TWO DELIBERATE CHANGES FROM THE SPIKE EVALUATOR
// ---------------------------------------------------------------------------
//  A. `score` stays FINITE when infeasible (the spike returned Infinity).
//     The spike compared two contenders and could refuse to score a broken
//     answer; the production engine must ALWAYS return a plan, so an infeasible
//     answer still needs a number to break down, report and diff proposals
//     against. `feasible` is the flag that used to be encoded as Infinity.
//  B. SOFT constraints are priced. The spike's world was all-hard. Here a soft
//     constraint costs its `weight` ONCE PER VIOLATED INSTANCE — flat, not per
//     minute. Flat because the weights were calibrated as flat prices against
//     the drop penalties ("a long day is priced just under losing a `could`
//     stop"), and a per-minute reading of 50 would make a 20-minute overrun
//     cost more than dropping the stop that caused it. The SEARCH adds a tiny
//     per-minute tiebreak on top of this so "less violated" still wins between
//     two equally-violating candidates; that tiebreak is search-internal and
//     deliberately absent here, exactly as the spike's breach pricing was.

import { formatDuration } from "../util/duration";
import type {
  ConstraintRef,
  EngineDay,
  EngineNode,
  EngineProblem,
  EngineSchedule,
  EngineVisit,
  ObjectiveBreakdown,
} from "./types";

export const WEIGHT_TRAVEL = 1.0;
export const WEIGHT_WAIT = 0.3;
export const WEIGHT_COMPRESSION = 0.5;

// ---------------------------------------------------------------------------
// Detail-string formatting. `detail` is USER-FACING copy — E6 renders it
// verbatim as the trade-off card headline, planEngine persists it into journal
// margin notes ("Pace check — …"), and the prose adapters quote it — so the
// schedule math's fractional minutes, `[a, b]` interval notation and 0-based
// day indexes must never leak through here (live-paste finding, 2026-08-14).
// Overruns CEIL so the headline agrees with the card's "off by N min" line,
// which ceils `violatedByMin`. Clock times wrap past midnight like
// hoursAdvisory's fmtHM.
// ---------------------------------------------------------------------------
const mins = (m: number): string => formatDuration(m);
const hhmm = (min: number): string => {
  const wrapped = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
};
const dayName = (dayIndex: number): string => `day ${dayIndex + 1}`;
const WEEKDAY_PLURAL = [
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
  "Sundays",
] as const;

export type EngineViolation = {
  code: string;
  detail: string;
  /** Occurrence keys the violation is about (may be empty for a day-level one). */
  stopKeys: string[];
  dayIndex?: number;
  byMin: number;
  /** false = the constraint was soft and this cost `weight` instead of
   * making the answer infeasible. */
  hard: boolean;
  weight: number;
  ref: ConstraintRef;
  /** hours violations only — see Conflict.closedDay (engine/types.ts). */
  closedDay?: boolean;
};

export type EngineEvaluation = {
  /** No HARD violation. Soft violations do not make an answer infeasible. */
  feasible: boolean;
  violations: EngineViolation[];
  score: number;
  breakdown: ObjectiveBreakdown;
};

export function evaluate(problem: EngineProblem, schedule: EngineSchedule): EngineEvaluation {
  const violations: EngineViolation[] = [];
  const push = (v: EngineViolation): void => {
    violations.push(v);
  };

  const nodeByKey = new Map<string, EngineNode>(problem.nodes.map((n) => [n.key, n]));
  const { travel } = problem;
  const travelMinutes = (dayIndex: number, from: string, to: string): number => {
    const a = travel.index[from];
    const b = travel.index[to];
    const row = travel.minutesByDay[dayIndex];
    if (a === undefined || b === undefined || !row) return 0;
    return row[a * travel.n + b];
  };

  // ---------------------------------------------------------------------
  // Completeness. Every node in exactly one of visits/dropped, no unknowns.
  // ---------------------------------------------------------------------
  const count = new Map<string, number>();
  for (const key of nodeByKey.keys()) count.set(key, 0);

  const unknownRef: ConstraintRef = { path: "", provenance: { source: "derived" } };
  for (const v of schedule.visits) {
    if (!nodeByKey.has(v.key)) {
      push({
        code: "unknown-stop",
        detail: `visit references node "${v.key}" not in the problem`,
        stopKeys: [v.key],
        dayIndex: v.dayIndex,
        byMin: 0,
        hard: true,
        weight: 0,
        ref: unknownRef,
      });
      continue;
    }
    count.set(v.key, (count.get(v.key) ?? 0) + 1);
  }
  for (const key of schedule.dropped) {
    if (!nodeByKey.has(key)) {
      push({
        code: "unknown-stop",
        detail: `dropped references node "${key}" not in the problem`,
        stopKeys: [key],
        byMin: 0,
        hard: true,
        weight: 0,
        ref: unknownRef,
      });
      continue;
    }
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  for (const [key, c] of count) {
    const node = nodeByKey.get(key)!;
    if (c === 0) {
      push({
        code: "missing-stop",
        detail: `node "${key}" appears in neither visits nor dropped`,
        stopKeys: [key],
        byMin: 0,
        hard: true,
        weight: 0,
        ref: node.priority.ref,
      });
    } else if (c > 1) {
      push({
        code: "duplicate-stop",
        detail: `node "${key}" appears ${c} times across visits/dropped (expected exactly 1)`,
        stopKeys: [key],
        byMin: 0,
        hard: true,
        weight: 0,
        ref: node.priority.ref,
      });
    }
  }

  const droppedSet = new Set(schedule.dropped);
  const visitByKey = new Map<string, EngineVisit>();
  for (const v of schedule.visits) if (!visitByKey.has(v.key)) visitByKey.set(v.key, v);

  // A `must` that was left out. Hard priority = a violation; soft = its price.
  for (const key of schedule.dropped) {
    const node = nodeByKey.get(key);
    if (!node || node.priority.value !== "must") continue;
    push({
      code: "dropped-must",
      detail: `must-priority stop "${node.name}" could not be placed`,
      stopKeys: [key],
      byMin: 0,
      hard: node.priority.hard,
      weight: node.priority.weight,
      ref: node.priority.ref,
    });
  }

  // pinnedDay.
  for (const node of problem.nodes) {
    if (!node.pinnedDay) continue;
    const v = visitByKey.get(node.key);
    if (v && v.dayIndex !== node.pinnedDay.value) {
      push({
        code: "pin-violated",
        detail: `"${node.name}" is pinned to ${dayName(node.pinnedDay.value)} but scheduled on ${dayName(v.dayIndex)}`,
        stopKeys: [node.key],
        dayIndex: v.dayIndex,
        byMin: 0,
        hard: node.pinnedDay.hard,
        weight: node.pinnedDay.weight,
        ref: node.pinnedDay.ref,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Per-visit checks that need no day context, plus day grouping.
  // ---------------------------------------------------------------------
  const byDay: EngineVisit[][] = problem.days.map(() => []);
  for (const v of schedule.visits) {
    const node = nodeByKey.get(v.key);
    if (!node) continue;

    const actual = v.departMin - v.startMin;
    const { minMin, maxMin } = node.duration.value;
    if (actual < minMin || actual > maxMin) {
      push({
        code: "duration-range",
        detail: `"${node.name}" gets ${mins(actual)} — it needs ${mins(minMin)}–${mins(maxMin)}`,
        stopKeys: [v.key],
        dayIndex: v.dayIndex,
        byMin: actual < minMin ? minMin - actual : actual - maxMin,
        hard: node.duration.hard,
        weight: node.duration.weight,
        ref: node.duration.ref,
      });
    }

    if (node.window) {
      const w = node.window.value;
      if (v.startMin < w.startMin || v.startMin > w.endMin) {
        push({
          code: node.isAnchor ? "anchor-start" : "window",
          detail:
            w.startMin === w.endMin
              ? `"${node.name}" starts at ${hhmm(v.startMin)} — it's booked for ${hhmm(w.startMin)}`
              : `"${node.name}" starts at ${hhmm(v.startMin)}, outside its ${hhmm(w.startMin)}–${hhmm(w.endMin)} window`,
          stopKeys: [v.key],
          dayIndex: v.dayIndex,
          byMin: v.startMin < w.startMin ? w.startMin - v.startMin : v.startMin - w.endMin,
          hard: node.window.hard,
          weight: node.window.weight,
          ref: node.window.ref,
        });
      }
    }

    if (!Number.isInteger(v.dayIndex) || v.dayIndex < 0 || v.dayIndex >= problem.days.length) {
      push({
        code: "day-window",
        detail: `"${node.name}" has invalid dayIndex ${v.dayIndex} (trip has ${problem.days.length} day(s))`,
        stopKeys: [v.key],
        dayIndex: v.dayIndex,
        byMin: 0,
        hard: true,
        weight: 0,
        ref: problem.days[0]?.window.ref ?? unknownRef,
      });
      continue;
    }
    byDay[v.dayIndex].push(v);
  }

  // ---------------------------------------------------------------------
  // Per-day checks.
  // ---------------------------------------------------------------------
  problem.days.forEach((day: EngineDay, dayIndex: number) => {
    const visits = [...byDay[dayIndex]].sort((a, b) => a.startMin - b.startMin);
    if (visits.length === 0) return;

    const dw = day.window;
    const first = visits[0];
    if (first.arriveMin < dw.value.startMin) {
      push({
        code: "day-window",
        detail: `${dayName(dayIndex)} starts ${mins(dw.value.startMin - first.arriveMin)} before its window opens`,
        stopKeys: [first.key],
        dayIndex,
        byMin: dw.value.startMin - first.arriveMin,
        hard: dw.hard,
        weight: dw.weight,
        ref: dw.ref,
      });
    }
    for (const v of visits) {
      if (v.departMin > dw.value.endMin) {
        const node = nodeByKey.get(v.key)!;
        push({
          code: "day-window",
          detail: `"${node.name}" runs ${mins(v.departMin - dw.value.endMin)} past the end of the day`,
          stopKeys: [v.key],
          dayIndex,
          byMin: v.departMin - dw.value.endMin,
          hard: dw.hard,
          weight: dw.weight,
          ref: dw.ref,
        });
      }
    }

    // Ordering sanity + travel feasibility over consecutive pairs.
    for (let i = 0; i < visits.length; i++) {
      const v = visits[i];
      const node = nodeByKey.get(v.key)!;
      if (v.startMin < v.arriveMin) {
        push({
          code: "overlap",
          detail: `"${node.name}" starts before it arrives`,
          stopKeys: [v.key],
          dayIndex,
          byMin: v.arriveMin - v.startMin,
          hard: true,
          weight: 0,
          ref: dw.ref,
        });
      }
      if (i === 0) continue;
      const prev = visits[i - 1];
      const need = travelMinutes(dayIndex, prev.key, v.key);
      if (v.startMin < prev.departMin + need) {
        push({
          code: "travel-underrun",
          detail: `"${node.name}" starts ${mins(prev.departMin + need - v.startMin)} before the previous stop's travel allows`,
          stopKeys: [v.key],
          dayIndex,
          byMin: prev.departMin + need - v.startMin,
          hard: true,
          weight: 0,
          ref: dw.ref,
        });
      }
    }

    // Hours + blocks.
    for (const v of visits) {
      const node = nodeByKey.get(v.key)!;
      if (node.hours) {
        const open = node.hours.value.openByDay[dayIndex];
        if (open !== null && open !== undefined) {
          const lastEntry = node.hours.value.lastEntryMin;
          const lastEntryOk = lastEntry === undefined || v.startMin <= lastEntry;
          const fits =
            lastEntryOk &&
            open.some((iv) => v.startMin >= iv.startMin && v.departMin <= iv.endMin);
          if (!fits) {
            push({
              code: "hours",
              ...(open.length === 0 ? { closedDay: true } : {}),
              detail:
                open.length === 0
                  ? day.weekday === null
                    ? `"${node.name}" is closed that day`
                    : `"${node.name}" is closed on ${WEEKDAY_PLURAL[day.weekday]}`
                  : `"${node.name}" is scheduled outside its opening hours`,
              stopKeys: [v.key],
              dayIndex,
              byMin: hoursShortfall(v, open, lastEntry),
              hard: node.hours.hard,
              weight: node.hours.weight,
              ref: node.hours.ref,
            });
          }
        }
      }

      for (const block of day.blocks) {
        if (v.startMin >= block.value.startMin && v.startMin < block.value.endMin) {
          push({
            code: "meal-block",
            detail: `"${node.name}" starts during a held ${hhmm(block.value.startMin)}–${hhmm(block.value.endMin)} block`,
            stopKeys: [v.key],
            dayIndex,
            byMin: block.value.endMin - v.startMin,
            hard: block.hard,
            weight: block.weight,
            ref: block.ref,
          });
        }
      }
    }

    // Pace.
    const pace = day.pace;
    const span = visits[visits.length - 1].departMin - visits[0].arriveMin;
    if (span > pace.value.maxActiveMin) {
      push({
        code: "pace-active",
        detail: `${dayName(dayIndex)} runs ${mins(span)}, over the ${mins(pace.value.maxActiveMin)} pace budget`,
        stopKeys: [],
        dayIndex,
        byMin: span - pace.value.maxActiveMin,
        hard: pace.hard,
        weight: pace.weight,
        ref: pace.ref,
      });
    }
    const effort = visits.reduce((sum, v) => sum + (nodeByKey.get(v.key)?.effortPoints ?? 0), 0);
    if (effort > pace.value.maxEffortPoints) {
      push({
        code: "pace-effort",
        detail: `${dayName(dayIndex)} is ${effort} effort points, over the ${pace.value.maxEffortPoints}-point budget`,
        stopKeys: [],
        dayIndex,
        byMin: 0,
        hard: pace.hard,
        weight: pace.weight,
        ref: pace.ref,
      });
    }
    // minGap is only a rule when the pace constraint is HARD — see PaceBudget.
    if (pace.hard && pace.value.minGapMin > 0) {
      for (let i = 1; i < visits.length; i++) {
        const prev = visits[i - 1];
        const v = visits[i];
        const need = travelMinutes(dayIndex, prev.key, v.key) + pace.value.minGapMin;
        const gap = v.startMin - prev.departMin;
        if (gap < need) {
          push({
            code: "pace-gap",
            detail: `only ${mins(gap)} between two stops, under the ${mins(pace.value.minGapMin)} breathing room`,
            stopKeys: [v.key],
            dayIndex,
            byMin: need - gap,
            hard: true,
            weight: 0,
            ref: pace.ref,
          });
        }
      }
    }
  });

  // ---------------------------------------------------------------------
  // Relations. Vacuously satisfied whenever an endpoint is dropped.
  // ---------------------------------------------------------------------
  for (const rel of problem.relations) {
    if (droppedSet.has(rel.aKey) || droppedSet.has(rel.bKey)) continue;
    const a = visitByKey.get(rel.aKey);
    const b = visitByKey.get(rel.bKey);
    if (!a || !b) continue;
    const broken =
      rel.kind === "precedence"
        ? !(a.dayIndex < b.dayIndex || (a.dayIndex === b.dayIndex && a.startMin < b.startMin))
        : rel.kind === "sameDay"
          ? a.dayIndex !== b.dayIndex
          : a.dayIndex === b.dayIndex;
    if (!broken) continue;
    const nameA = nodeByKey.get(rel.aKey)?.name ?? rel.aKey;
    const nameB = nodeByKey.get(rel.bKey)?.name ?? rel.bKey;
    push({
      code: rel.kind === "precedence" ? "precedence" : rel.kind === "sameDay" ? "same-day" : "not-same-day",
      detail:
        rel.kind === "precedence"
          ? `"${nameA}" was meant to come before "${nameB}"`
          : rel.kind === "sameDay"
            ? `"${nameA}" and "${nameB}" were meant to share a day`
            : `"${nameA}" and "${nameB}" were meant to be on different days`,
      stopKeys: [rel.aKey, rel.bKey],
      dayIndex: a.dayIndex,
      byMin: 0,
      hard: rel.hard,
      weight: rel.weight,
      ref: rel.ref,
    });
  }

  // ---------------------------------------------------------------------
  // Objective.
  // ---------------------------------------------------------------------
  let travelMin = 0;
  let waitMin = 0;
  let compressionMin = 0;
  problem.days.forEach((_day, dayIndex) => {
    const visits = [...byDay[dayIndex]].sort((a, b) => a.startMin - b.startMin);
    for (let i = 0; i < visits.length; i++) {
      const v = visits[i];
      const node = nodeByKey.get(v.key);
      if (node) {
        compressionMin += Math.max(0, node.duration.value.typicalMin - (v.departMin - v.startMin));
      }
      if (i === 0) continue; // first visit of a day: no predecessor, no idle gap
      const prev = visits[i - 1];
      const t = travelMinutes(dayIndex, prev.key, v.key);
      travelMin += t;
      // STRUCTURAL wait — see semantic 1 at the top of this file.
      waitMin += Math.max(0, v.startMin - prev.departMin - t);
    }
  });

  let dropPenalty = 0;
  for (const key of schedule.dropped) {
    const node = nodeByKey.get(key);
    if (node) dropPenalty += node.dropPenalty;
  }

  let softViolations = 0;
  for (const v of violations) if (!v.hard) softViolations += v.weight;

  const compressionPenalty = WEIGHT_COMPRESSION * compressionMin;
  const score =
    WEIGHT_TRAVEL * travelMin +
    WEIGHT_WAIT * waitMin +
    dropPenalty +
    compressionPenalty +
    softViolations;

  return {
    feasible: violations.every((v) => !v.hard),
    violations,
    score,
    breakdown: { travelMin, waitMin, dropPenalty, compressionPenalty, softViolations },
  };
}

/** How badly an hours breach missed, in minutes: the smallest shift of the visit
 * that would land it inside some open interval (0 when closed all day — there is
 * no shift that helps, and the conflict says so with its code). */
function hoursShortfall(
  v: EngineVisit,
  open: readonly { startMin: number; endMin: number }[],
  lastEntryMin: number | undefined
): number {
  if (open.length === 0) return 0;
  const length = v.departMin - v.startMin;
  let best = Infinity;
  for (const iv of open) {
    const latestStart = Math.min(iv.endMin - length, lastEntryMin ?? Infinity);
    if (latestStart < iv.startMin) continue; // the visit cannot fit this interval at all
    const shift =
      v.startMin < iv.startMin
        ? iv.startMin - v.startMin
        : v.startMin > latestStart
          ? v.startMin - latestStart
          : 0;
    if (shift < best) best = shift;
  }
  return Number.isFinite(best) ? best : 0;
}
