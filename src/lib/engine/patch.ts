// E5a — applying a proposal's patch.
//
// THREE appliers, because a proposal has to land in three different places and
// pretending otherwise is how a patch misapplies:
//
//   applyDocPatch      — the TripDoc. What E6 PUTs through savePlanned.
//   applyConstraintPatch — the compiled ConstraintSet. For the one op today's
//                        doc has nowhere to store (pace); everything else
//                        re-derives itself from the patched doc on recompile.
//   applyPatchToProblem — the EngineProblem, in place of a rebuild. Used ONLY
//                        to price a candidate patch (./proposals): it reuses
//                        the travel model rather than re-running matrix
//                        construction, which is what keeps proposal costing
//                        bounded.
//
// All three are PURE. `applyDocPatch` never throws on a stale patch (a stop
// that has since moved, a day index that no longer exists) — it degrades to a
// no-op on the part that no longer exists, exactly like `mergePatches`, so E6
// can validate-then-refresh instead of corrupting a doc.

import type { ConstraintSet } from "../constraints/types";
import type { TripDoc, TripDay, TripStop } from "../store/types";
import { PACE_BUDGETS } from "./problem";
import type { DocPatch, EngineDay, EngineNode, EngineProblem, Enforced, PaceBudget } from "./types";

// ---------------------------------------------------------------------------
// TripDoc
// ---------------------------------------------------------------------------

export function applyDocPatch(doc: TripDoc, patch: DocPatch): TripDoc {
  switch (patch.op) {
    case "removeStop": {
      const day = doc.days[patch.dayIndex];
      if (!day || !day.stops.some((s) => s.id === patch.stopId)) return doc;
      return {
        ...doc,
        days: doc.days.map((d, i) =>
          i === patch.dayIndex ? withoutStop(d, patch.stopId) : d
        ),
        legOverrides: doc.legOverrides.filter(
          (o) =>
            !(
              o.dayIndex === patch.dayIndex &&
              (o.fromId === patch.stopId || o.toId === patch.stopId)
            )
        ),
      };
    }

    case "setAnchor": {
      const day = doc.days[patch.dayIndex];
      if (!day) return doc;
      return {
        ...doc,
        days: doc.days.map((d, i) =>
          i !== patch.dayIndex
            ? d
            : {
                ...d,
                stops: d.stops.map((s) =>
                  s.id !== patch.stopId
                    ? s
                    : patch.startMin === null
                      ? stripAnchor(s)
                      : { ...s, anchor: { startMin: patch.startMin } }
                ),
              }
        ),
      };
    }

    case "setDayWindow": {
      const day = doc.days[patch.dayIndex];
      if (!day) return doc;
      return {
        ...doc,
        days: doc.days.map((d, i) =>
          i !== patch.dayIndex
            ? d
            : {
                ...d,
                dayStartMin: patch.startMin ?? d.dayStartMin,
                dayEndMin: patch.endMin ?? d.dayEndMin,
              }
        ),
      };
    }

    case "setDuration": {
      const day = doc.days[patch.dayIndex];
      if (!day) return doc;
      return {
        ...doc,
        days: doc.days.map((d, i) =>
          i !== patch.dayIndex
            ? d
            : {
                ...d,
                stops: d.stops.map((s) =>
                  s.id === patch.stopId ? { ...s, durationMin: patch.durationMin } : s
                ),
              }
        ),
      };
    }

    case "moveStop": {
      const from = doc.days[patch.fromDayIndex];
      const to = doc.days[patch.toDayIndex];
      if (!from || !to || patch.fromDayIndex === patch.toDayIndex) return doc;
      const stop = from.stops.find((s) => s.id === patch.stopId);
      if (!stop) return doc;
      return {
        ...doc,
        days: doc.days.map((d, i) => {
          if (i === patch.fromDayIndex) return withoutStop(d, patch.stopId);
          if (i === patch.toDayIndex) return withoutManualOrder({ ...d, stops: [...d.stops, stop] });
          return d;
        }),
        legOverrides: doc.legOverrides.filter(
          (o) =>
            !(
              o.dayIndex === patch.fromDayIndex &&
              (o.fromId === patch.stopId || o.toId === patch.stopId)
            )
        ),
      };
    }

    case "setPacePreset":
      return doc; // constraint-level; see applyConstraintPatch
  }
}

function withoutStop(day: TripDay, stopId: string): TripDay {
  return withoutManualOrder({ ...day, stops: day.stops.filter((s) => s.id !== stopId) });
}

/** A pinned order that no longer covers the day's stops is ignored downstream
 * anyway (`validManualOrder`); dropping it here keeps the doc honest. */
function withoutManualOrder(day: TripDay): TripDay {
  if (day.manualOrder === undefined) return day;
  const { manualOrder: _drop, ...rest } = day;
  return rest;
}

function stripAnchor(stop: TripStop): TripStop {
  const { anchor: _drop, ...rest } = stop;
  return rest;
}

// ---------------------------------------------------------------------------
// ConstraintSet
// ---------------------------------------------------------------------------

export function applyConstraintPatch(set: ConstraintSet, patch: DocPatch): ConstraintSet {
  if (patch.op !== "setPacePreset") return set;
  return {
    ...set,
    trip: {
      ...set.trip,
      pacePreset: {
        value: patch.preset,
        // The human accepted the trade-off, so this is now their statement.
        provenance: { source: "user" },
        hardness: set.trip.pacePreset.hardness,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// EngineProblem (costing only)
// ---------------------------------------------------------------------------

export function applyPatchToProblem(problem: EngineProblem, patch: DocPatch): EngineProblem {
  switch (patch.op) {
    case "removeStop": {
      const key = keyOnDay(problem, patch.dayIndex, patch.stopId);
      if (key === null) return problem;
      return {
        ...problem,
        nodes: problem.nodes.filter((n) => n.key !== key),
        days: problem.days.map((d) =>
          d.index === patch.dayIndex
            ? { ...d, nodeKeys: d.nodeKeys.filter((k) => k !== key) }
            : d
        ),
        relations: problem.relations.filter((r) => r.aKey !== key && r.bKey !== key),
      };
    }

    case "setAnchor": {
      const key = keyOnDay(problem, patch.dayIndex, patch.stopId);
      if (key === null) return problem;
      return {
        ...problem,
        nodes: problem.nodes.map((n) => {
          if (n.key !== key) return n;
          if (patch.startMin === null) {
            const { window: _w, ...rest } = n;
            return { ...rest, isAnchor: false } as EngineNode;
          }
          const window: Enforced<{ startMin: number; endMin: number }> = {
            value: { startMin: patch.startMin, endMin: patch.startMin },
            hard: true,
            weight: 0,
            ref: n.window?.ref ?? { path: `stops.${key}.window`, provenance: { source: "user" } },
          };
          return { ...n, window, isAnchor: true };
        }),
      };
    }

    case "setDayWindow":
      return {
        ...problem,
        days: problem.days.map((d) =>
          d.index !== patch.dayIndex
            ? d
            : {
                ...d,
                window: {
                  ...d.window,
                  value: {
                    startMin: patch.startMin ?? d.window.value.startMin,
                    endMin: patch.endMin ?? d.window.value.endMin,
                  },
                },
              }
        ),
      };

    case "setDuration": {
      const key = keyOnDay(problem, patch.dayIndex, patch.stopId);
      if (key === null) return problem;
      return {
        ...problem,
        nodes: problem.nodes.map((n) =>
          n.key !== key
            ? n
            : {
                ...n,
                duration: {
                  ...n.duration,
                  value: {
                    minMin: patch.durationMin,
                    typicalMin: patch.durationMin,
                    maxMin: patch.durationMin,
                  },
                },
              }
        ),
      };
    }

    case "moveStop": {
      const key = keyOnDay(problem, patch.fromDayIndex, patch.stopId);
      if (key === null || patch.fromDayIndex === patch.toDayIndex) return problem;
      if (!problem.days[patch.toDayIndex]) return problem;
      return {
        ...problem,
        nodes: problem.nodes.map((n) =>
          n.key !== key || !n.pinnedDay
            ? n
            : { ...n, pinnedDay: { ...n.pinnedDay, value: patch.toDayIndex } }
        ),
        days: problem.days.map((d) => {
          if (d.index === patch.fromDayIndex)
            return { ...d, nodeKeys: d.nodeKeys.filter((k) => k !== key) };
          if (d.index === patch.toDayIndex) return { ...d, nodeKeys: [...d.nodeKeys, key] };
          return d;
        }),
      };
    }

    case "setPacePreset": {
      const budget = PACE_BUDGETS[patch.preset] ?? PACE_BUDGETS.balanced;
      return {
        ...problem,
        pacePreset: { ...problem.pacePreset, value: patch.preset },
        days: problem.days.map((d) =>
          d.pace.ref.path === "trip.pacePreset" ? { ...d, pace: withBudget(d.pace, budget) } : d
        ),
      };
    }
  }
}

function withBudget(pace: Enforced<PaceBudget>, budget: PaceBudget): Enforced<PaceBudget> {
  return { ...pace, value: budget };
}

/** The occurrence key of `stopId` as it appears on `dayIndex`, or null. */
export function keyOnDay(
  problem: EngineProblem,
  dayIndex: number,
  stopId: string
): string | null {
  const day: EngineDay | undefined = problem.days[dayIndex];
  if (!day) return null;
  const byKey = new Map(problem.nodes.map((n) => [n.key, n]));
  for (const key of day.nodeKeys) {
    if (byKey.get(key)?.stopId === stopId) return key;
  }
  return null;
}

/** Doc + constraint applier in one call — the shape E6's "accept" flow wants,
 * and the shape the engine's own round-trip test exercises. */
export function applyPatch(
  doc: TripDoc,
  set: ConstraintSet,
  patch: DocPatch
): { doc: TripDoc; setPatch: (recompiled: ConstraintSet) => ConstraintSet } {
  return {
    doc: applyDocPatch(doc, patch),
    setPatch: (recompiled: ConstraintSet) => applyConstraintPatch(recompiled, patch),
  };
}
