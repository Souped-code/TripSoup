// Schedule builder + feasibility surface — §2 (LOCKED), P3.
// Pure. Splits a day into segments at its anchors (list order), optimizes each,
// and assembles arrive/depart times, travel legs with durations, and slack per
// gap. A user's per-leg mode toggle re-times downstream without re-ordering:
// applyLegModes + rescheduleDay walk the SAME order with the flipped matrix.

import type { Settings } from "../maps/types";
import { effectiveMinutes } from "../solver/effectiveMatrix";
import { optimize } from "../solver/solver";
import type { EffectiveMatrix, PrecedencePair } from "../solver/types";
import type { Day, DayPlan, DayStop, PlanEntry, PlanLeg } from "./types";

const cmpPair = (x: PrecedencePair, y: PrecedencePair): number =>
  x.beforeId !== y.beforeId
    ? x.beforeId < y.beforeId
      ? -1
      : 1
    : x.afterId < y.afterId
      ? -1
      : x.afterId > y.afterId
        ? 1
        : 0;

export function planDay(day: Day, matrix: EffectiveMatrix, settings: Settings): DayPlan {
  const invalid = validateDay(day);
  if (invalid) return invalid;

  const byId = new Map(day.stops.map((s) => [s.id, s]));
  const nameOf = (id: string): string => byId.get(id)?.name ?? id;
  const anchors = day.stops.filter((s) => s.anchor);
  const runs = splitRuns(day.stops);

  // Which solver segment each flexible stop belongs to (anchors are in none).
  const runOf = new Map<string, number>();
  runs.forEach((run, ri) => run.forEach((s) => runOf.set(s.id, ri)));

  // Route each precedence pair: within-segment (to the solver), cross-segment
  // same-day (post-assembly check), or cross-day / unknown (margin note).
  const withinByRun = new Map<number, PrecedencePair[]>();
  const crossSegment: PrecedencePair[] = [];
  const marginNotes: string[] = [];
  for (const p of day.precedence ?? []) {
    const onDayB = byId.has(p.beforeId);
    const onDayA = byId.has(p.afterId);
    if (!onDayB || !onDayA) {
      const missing = !onDayB ? p.beforeId : p.afterId;
      marginNotes.push(
        `You wanted ${nameOf(p.beforeId)} before ${nameOf(p.afterId)} — ${nameOf(missing)} is on another day.`
      );
      continue;
    }
    const rb = runOf.get(p.beforeId);
    const ra = runOf.get(p.afterId);
    if (rb !== undefined && ra !== undefined && rb === ra) {
      const arr = withinByRun.get(rb) ?? [];
      arr.push({ beforeId: p.beforeId, afterId: p.afterId });
      withinByRun.set(rb, arr);
    } else {
      crossSegment.push({ beforeId: p.beforeId, afterId: p.afterId });
    }
  }

  // Optimize each run of flexible stops between anchors (in list order).
  const fullOrder: string[] = [];
  let quality: "optimal" | "heuristic" = "optimal";

  for (let i = 0; i < runs.length; i++) {
    const prevAnchor: DayStop | null = i === 0 ? null : anchors[i - 1];
    const nextAnchor: DayStop | null = i < anchors.length ? anchors[i] : null;
    const result = optimize(
      {
        startAtMin: prevAnchor
          ? prevAnchor.anchor!.startMin + prevAnchor.durationMin
          : day.dayStartMin,
        startStopId: prevAnchor ? prevAnchor.id : null,
        endByMin: nextAnchor ? nextAnchor.anchor!.startMin : day.dayEndMin,
        endStopId: nextAnchor ? nextAnchor.id : null,
        stops: runs[i].map((s) => ({ id: s.id, durationMin: s.durationMin })),
      },
      matrix,
      settings,
      withinByRun.get(i) ?? []
    );
    if (result.status !== "ok") return result;
    if (result.quality === "heuristic") quality = "heuristic"; // label propagates
    fullOrder.push(...result.order);
    if (nextAnchor) fullOrder.push(nextAnchor.id);
  }

  const walked = rescheduleDay(day, fullOrder, matrix, settings);
  if (walked.status !== "ok") return walked;

  // Cross-segment precedence: the solver couldn't enforce it (the pair straddles
  // an anchor), so validate the assembled full-day order and report if violated.
  const pos = new Map(fullOrder.map((id, i) => [id, i]));
  for (const p of [...crossSegment].sort(cmpPair)) {
    if ((pos.get(p.beforeId) ?? 0) > (pos.get(p.afterId) ?? 0)) {
      return {
        status: "infeasible",
        constraint: `precedence:${p.beforeId}->${p.afterId}`,
        violatedByMin: 0,
        message: `You wanted ${nameOf(p.beforeId)} before ${nameOf(p.afterId)}, but the day's anchors force ${nameOf(p.afterId)} first — usually the fix is moving the stop or the anchor.`,
      };
    }
  }

  return marginNotes.length > 0
    ? { ...walked, quality, marginNotes }
    : { ...walked, quality };
}

// Fixed-order schedule walk over the full day order (anchors included).
// Used by planDay for assembly and by the UI's per-leg toggle for re-timing —
// same order, possibly different leg modes, fresh feasibility check.
export function rescheduleDay(
  day: Day,
  fullOrder: string[],
  matrix: EffectiveMatrix,
  settings: Settings,
  // the ordering claim of the plan being re-timed — a toggle must not launder
  // a heuristic order into an "optimal" one (§2: the UI says so), nor a manual
  // order into either (D2.3)
  quality: "optimal" | "heuristic" | "manual" = "optimal"
): DayPlan {
  const invalid = validateDay(day);
  if (invalid) return invalid;
  const byId = new Map(day.stops.map((s) => [s.id, s]));
  if (fullOrder.length !== day.stops.length || fullOrder.some((id) => !byId.has(id))) {
    throw new Error("order must be a permutation of the day's stop ids");
  }

  const entries: PlanEntry[] = [];
  const legs: PlanLeg[] = [];
  let clock = day.dayStartMin;
  let totalTravelMin = 0;
  let prevId: string | null = null;

  for (const id of fullOrder) {
    const stop = byId.get(id)!;
    let arriveMin = clock;
    if (prevId !== null) {
      const leg = matrix[prevId]?.[id];
      if (!leg) throw new Error(`effective matrix missing pair ${prevId} -> ${id}`);
      const effectiveMin = effectiveMinutes(leg, settings);
      arriveMin = clock + effectiveMin;
      totalTravelMin += effectiveMin;
      legs.push({
        fromId: prevId,
        toId: id,
        mode: leg.mode,
        walkMin: leg.walkMin,
        driveMin: leg.driveMin,
        effectiveMin,
        chosenBy: leg.chosenBy,
        departMin: clock,
        arriveMin,
      });
    }

    let startMin = arriveMin;
    if (stop.anchor) {
      if (arriveMin > stop.anchor.startMin) {
        return {
          status: "infeasible",
          constraint: `anchor-start:${id}`,
          violatedByMin: arriveMin - stop.anchor.startMin,
          message: `With these leg modes, ${stop.name} is reached ${Math.ceil(arriveMin - stop.anchor.startMin)} min after its booked time.`,
        };
      }
      startMin = stop.anchor.startMin;
    }
    const departMin = startMin + stop.durationMin;
    entries.push({
      stopId: id,
      kind: stop.anchor ? "anchor" : "flexible",
      arriveMin,
      startMin,
      departMin,
      waitMin: startMin - arriveMin,
    });
    clock = departMin;
    prevId = id;
  }

  if (clock > day.dayEndMin) {
    return {
      status: "infeasible",
      constraint: "day-window",
      violatedByMin: clock - day.dayEndMin,
      message: `The day overruns its end by ${Math.ceil(clock - day.dayEndMin)} min.`,
    };
  }

  return {
    status: "ok",
    order: fullOrder,
    entries,
    legs,
    quality,
    totalTravelMin,
    daySlackMin: day.dayEndMin - clock,
  };
}

// Flip leg modes per user toggles (§2 decide-then-offer). Only eligible legs
// (walkMin retained) can be toggled; asking for an ineligible walk is a user
// input error surfaced loudly. Returns a new matrix; input is not mutated.
export function applyLegModes(
  matrix: EffectiveMatrix,
  overrides: { fromId: string; toId: string; mode: "walk" | "drive" }[]
): EffectiveMatrix {
  const next: EffectiveMatrix = {};
  for (const from of Object.keys(matrix)) {
    next[from] = { ...matrix[from] };
  }
  for (const o of overrides) {
    const leg = next[o.fromId]?.[o.toId];
    if (!leg) throw new Error(`no such leg: ${o.fromId} -> ${o.toId}`);
    if (o.mode === "walk" && leg.walkMin === null) {
      throw new Error(`leg ${o.fromId} -> ${o.toId} is not walk-eligible`);
    }
    next[o.fromId][o.toId] = { ...leg, mode: o.mode, chosenBy: "user" };
  }
  return next;
}

function splitRuns(stops: DayStop[]): DayStop[][] {
  const runs: DayStop[][] = [[]];
  for (const stop of stops) {
    if (stop.anchor) runs.push([]);
    else runs[runs.length - 1].push(stop);
  }
  return runs;
}

function validateDay(day: Day): DayPlan | null {
  const ids = new Set<string>();
  for (const s of day.stops) {
    if (ids.has(s.id)) throw new Error(`duplicate stop id in day: ${s.id}`);
    ids.add(s.id);
  }
  const anchors = day.stops.filter((s) => s.anchor);
  for (const a of anchors) {
    if (a.anchor!.startMin < day.dayStartMin || a.anchor!.startMin > day.dayEndMin) {
      return {
        status: "infeasible",
        constraint: `anchor-outside-day:${a.id}`,
        violatedByMin:
          a.anchor!.startMin < day.dayStartMin
            ? day.dayStartMin - a.anchor!.startMin
            : a.anchor!.startMin - day.dayEndMin,
        message: `${a.name} is booked outside the day window.`,
      };
    }
  }
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i].anchor!.startMin <= anchors[i - 1].anchor!.startMin) {
      return {
        status: "infeasible",
        constraint: `anchor-order:${anchors[i].id}`,
        violatedByMin: anchors[i - 1].anchor!.startMin - anchors[i].anchor!.startMin,
        message: `${anchors[i].name} is booked at or before the preceding anchor ${anchors[i - 1].name} — reorder the stops to match booking times.`,
      };
    }
  }
  return null;
}
