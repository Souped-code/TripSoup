// E5a — schedule -> DayPlan. The wire shape (../schedule/types) is LOCKED and
// this is where the engine meets it.
//
// The assembly semantics are `rescheduleDay`'s, replicated rather than called:
// a fixed order walked left to right, legs read out of the effective matrix with
// BOTH times retained (§2 decide-then-offer — the UI's per-leg toggle re-times
// this same order afterwards, and never re-orders it), `arriveMin` structural,
// `waitMin = startMin - arriveMin`, `daySlackMin` the day window left after the
// last departure.
//
// ONE deliberate difference from `rescheduleDay`, and it is the whole point of
// E5: where the old code RETURNED `{status:"infeasible"}` and threw the plan
// away, this returns the plan anyway. A missed anchor becomes
// `startMin = max(anchorTime, arriveMin)` (never a negative wait) and a
// conflict; a day that overruns its window comes back with a negative
// `daySlackMin` and a conflict. Never a silent cut, never a dead end.

import type { DayPlan, PlanEntry, PlanLeg } from "../schedule/types";
import type { EngineNode, EngineProblem, EngineVisit } from "./types";

export type DayTimes = ReadonlyMap<string, { startMin: number; departMin: number }>;

/**
 * Assemble one day.
 *
 * `times` absent = LEGACY WALK: start at the day window's open, arrive =
 * previous departure + travel, a stop starts when you get there (or at its
 * booked time), duration = typical. This is the path old-class days take, and it
 * is what makes the brute-force differential exact.
 *
 * `times` present = the search's own schedule (which may wait, compress, stretch
 * or right-shift); arrivals are recomputed structurally from the order and the
 * matrix so a solver can never report its way out of a wait penalty.
 */
export function assembleDay(
  problem: EngineProblem,
  dayIndex: number,
  order: readonly string[],
  quality: "optimal" | "heuristic" | "manual",
  times?: DayTimes,
  marginNotes?: readonly string[]
): DayPlan {
  const day = problem.days[dayIndex];
  const byKey = new Map(problem.nodes.map((n) => [n.key, n]));

  if (order.length === 0) {
    return {
      status: "ok",
      order: [],
      entries: [],
      legs: [],
      quality,
      totalTravelMin: 0,
      daySlackMin: day.window.value.endMin - day.window.value.startMin,
      ...(marginNotes && marginNotes.length > 0 ? { marginNotes: [...marginNotes] } : {}),
    };
  }

  const { travel } = problem;
  const legsRow = travel.legsByDay[dayIndex];
  const minutesRow = travel.minutesByDay[dayIndex];

  const entries: PlanEntry[] = [];
  const legs: PlanLeg[] = [];
  let clock = day.window.value.startMin;
  let totalTravelMin = 0;
  let prevKey: string | null = null;

  for (const key of order) {
    const node = byKey.get(key);
    if (!node) throw new Error(`assembleDay: unknown node key ${key}`);

    let arriveMin = clock;
    if (prevKey !== null) {
      const a = travel.index[prevKey];
      const b = travel.index[key];
      const leg = legsRow[a * travel.n + b];
      if (!leg) {
        // Only cross-day pairs lack a leg, and a returned plan can never contain
        // one. Throwing beats inventing a mode the matrix never offered.
        throw new Error(`assembleDay: no effective leg for ${prevKey} -> ${key} on day ${dayIndex}`);
      }
      const effectiveMin = minutesRow[a * travel.n + b];
      arriveMin = clock + effectiveMin;
      totalTravelMin += effectiveMin;
      legs.push({
        fromId: byKey.get(prevKey)!.stopId,
        toId: node.stopId,
        mode: leg.mode,
        walkMin: leg.walkMin,
        driveMin: leg.driveMin,
        effectiveMin,
        chosenBy: leg.chosenBy,
        departMin: clock,
        arriveMin,
      });
    }

    const { startMin, departMin } = resolveTimes(node, arriveMin, times);
    entries.push({
      stopId: node.stopId,
      kind: node.isAnchor ? "anchor" : "flexible",
      arriveMin,
      startMin,
      departMin,
      waitMin: startMin - arriveMin,
    });
    clock = departMin;
    prevKey = key;
  }

  return {
    status: "ok",
    order: order.map((k) => byKey.get(k)!.stopId),
    entries,
    legs,
    quality,
    totalTravelMin,
    daySlackMin: day.window.value.endMin - clock,
    ...(marginNotes && marginNotes.length > 0 ? { marginNotes: [...marginNotes] } : {}),
  };
}

function resolveTimes(
  node: EngineNode,
  arriveMin: number,
  times: DayTimes | undefined
): { startMin: number; departMin: number } {
  if (times) {
    const t = times.get(node.key);
    if (t) {
      // The search's times, with arrival made structural: a start can never
      // precede the arrival the matrix implies.
      const startMin = Math.max(t.startMin, arriveMin);
      return { startMin, departMin: Math.max(t.departMin, startMin) };
    }
  }
  // Legacy walk.
  const startMin = node.isAnchor ? Math.max(node.window!.value.startMin, arriveMin) : arriveMin;
  return { startMin, departMin: startMin + node.duration.value.typicalMin };
}

/** The visits of one day, ordered, as the (order, times) pair `assembleDay`
 * wants. */
export function dayViewOf(
  visits: readonly EngineVisit[],
  dayIndex: number
): { order: string[]; times: Map<string, { startMin: number; departMin: number }> } {
  const mine = visits
    .filter((v) => v.dayIndex === dayIndex)
    .slice()
    .sort((a, b) => a.startMin - b.startMin || (a.key < b.key ? -1 : 1));
  const times = new Map<string, { startMin: number; departMin: number }>();
  for (const v of mine) times.set(v.key, { startMin: v.startMin, departMin: v.departMin });
  return { order: mine.map((v) => v.key), times };
}
