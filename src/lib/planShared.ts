// Client-safe pure helpers shared between server code (planService.ts) and
// client components (src/ui/reveal/RevealClient.tsx) and the share server
// component (app/share/[id]/page.tsx). Deliberately NOT part of planService,
// which is server-only by convention (imports getMapsProvider etc.) and
// cannot be imported from a "use client" module. This module must stay free
// of any server-only import (fs, config.ts, planService.ts, …).
//
// E6b — `applyDocPatch` below is a CLIENT-SIDE reimplementation of
// src/lib/engine/patch.ts's `applyDocPatch`, deliberately, not an import of
// it: that module's silent-degrade contract ("never throws on a stale patch
// … degrades to a no-op") is right for the engine's own proposal-costing use
// (./proposals.ts test-applies a patch and just wants "did anything change"),
// but E6b's accept flow needs to DISTINGUISH "applied" from "stale" so it can
// show a margin error and refresh instead of silently PUTting a no-op doc
// that still carries the resolved conflict. `engine/patch.ts` also has no
// "server-only" guard and IS otherwise import-safe from a client bundle, but
// re-deriving the five doc-mutating ops here keeps the validate-then-report
// contract local to the one caller that needs it, and keeps this file (the
// deliberately server-import-free module) the single client-safe home for
// doc-shape logic, matching `validManualOrder` immediately below.
import type { DocPatch } from "./engine/types";
import type { TripDay, TripDoc, TripStop } from "./store/types";

// A manualOrder is honored only if it is an exact permutation of the current
// stop ids — same size, same set, no duplicates, no unknowns. Anything else
// (a stale order from before the stop list changed) returns null, meaning
// "fall back to the solved/stored order" — the same rule enforced server-side
// by planService.planTripDay, mirrored here so every reader (server pages,
// client optimistic UI) agrees on what counts as a valid pin.
export function validManualOrder(
  manualOrder: string[] | undefined,
  stopIds: string[]
): string[] | null {
  if (!manualOrder || manualOrder.length !== stopIds.length || stopIds.length === 0) return null;
  const idSet = new Set(stopIds);
  const seen = new Set<string>();
  for (const id of manualOrder) {
    if (!idSet.has(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return manualOrder;
}

// ---------------------------------------------------------------------------
// E6b — applyDocPatch (client-side accept flow)
// ---------------------------------------------------------------------------

export type DocPatchResult = { ok: true; doc: TripDoc } | { ok: false; reason: string };

function withoutManualOrderDay(day: TripDay): TripDay {
  if (day.manualOrder === undefined) return day;
  const { manualOrder: _drop, ...rest } = day;
  return rest;
}

function withoutStop(day: TripDay, stopId: string): TripDay {
  return withoutManualOrderDay({ ...day, stops: day.stops.filter((s) => s.id !== stopId) });
}

function stripAnchor(stop: TripStop): TripStop {
  const { anchor: _drop, ...rest } = stop;
  return rest;
}

/**
 * Apply one proposal's `DocPatch` to `doc`, or report exactly why it could
 * not be applied. Mirrors src/lib/engine/patch.ts's `applyDocPatch` op-for-op
 * (see this file's header for why it is a separate implementation), but
 * VALIDATES first and reports staleness instead of silently no-opping — the
 * caller (RevealClient's accept handler) uses `ok: false` to show a
 * toast-style margin error and refresh from the server, never to PUT a doc
 * that looks accepted but changed nothing.
 *
 * `setPacePreset` is an honest, documented gap: today's TripDoc has nowhere
 * to persist a pace preset (engine/types.ts's own DocPatch comment — a
 * ConstraintSet is recompiled fresh from the doc on every solve, so there is
 * no field a client-side accept could write that would survive the round
 * trip). Reported as `ok: false` rather than silently accepted-but-inert.
 */
export function applyDocPatch(doc: TripDoc, patch: DocPatch): DocPatchResult {
  switch (patch.op) {
    case "removeStop": {
      const day = doc.days[patch.dayIndex];
      if (!day) return { ok: false, reason: "That day isn't part of this trip anymore." };
      if (!day.stops.some((s) => s.id === patch.stopId)) {
        return { ok: false, reason: "That stop is already gone." };
      }
      return {
        ok: true,
        doc: {
          ...doc,
          days: doc.days.map((d, i) => (i === patch.dayIndex ? withoutStop(d, patch.stopId) : d)),
          legOverrides: doc.legOverrides.filter(
            (o) =>
              !(
                o.dayIndex === patch.dayIndex &&
                (o.fromId === patch.stopId || o.toId === patch.stopId)
              )
          ),
        },
      };
    }

    case "setAnchor": {
      const day = doc.days[patch.dayIndex];
      if (!day) return { ok: false, reason: "That day isn't part of this trip anymore." };
      if (!day.stops.some((s) => s.id === patch.stopId)) {
        return { ok: false, reason: "That stop isn't on this day anymore." };
      }
      return {
        ok: true,
        doc: {
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
        },
      };
    }

    case "setDayWindow": {
      const day = doc.days[patch.dayIndex];
      if (!day) return { ok: false, reason: "That day isn't part of this trip anymore." };
      return {
        ok: true,
        doc: {
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
        },
      };
    }

    case "setDuration": {
      const day = doc.days[patch.dayIndex];
      if (!day) return { ok: false, reason: "That day isn't part of this trip anymore." };
      if (!day.stops.some((s) => s.id === patch.stopId)) {
        return { ok: false, reason: "That stop isn't on this day anymore." };
      }
      return {
        ok: true,
        doc: {
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
        },
      };
    }

    case "moveStop": {
      const from = doc.days[patch.fromDayIndex];
      const to = doc.days[patch.toDayIndex];
      if (!from || !to) return { ok: false, reason: "Those days aren't part of this trip anymore." };
      if (patch.fromDayIndex === patch.toDayIndex) return { ok: false, reason: "Nothing to move." };
      const stop = from.stops.find((s) => s.id === patch.stopId);
      if (!stop) return { ok: false, reason: "That stop isn't on that day anymore." };
      return {
        ok: true,
        doc: {
          ...doc,
          days: doc.days.map((d, i) => {
            if (i === patch.fromDayIndex) return withoutStop(d, patch.stopId);
            if (i === patch.toDayIndex) return withoutManualOrderDay({ ...d, stops: [...d.stops, stop] });
            return d;
          }),
          legOverrides: doc.legOverrides.filter(
            (o) =>
              !(
                o.dayIndex === patch.fromDayIndex &&
                (o.fromId === patch.stopId || o.toId === patch.stopId)
              )
          ),
        },
      };
    }

    case "setPacePreset":
      return {
        ok: false,
        reason: "Pace preferences aren't saved on this trip yet — try trimming a visit instead.",
      };
  }
}

// ---------------------------------------------------------------------------
// E6b — dismissal keying. A dismissed card is keyed to the CURRENT hash of the
// day it lives on (or the whole-trip solveHash for a dayIndex-less conflict),
// so it auto-expires the instant that day's content changes — see
// src/lib/store/types.ts's `dismissedProposals` doc comment for the full
// rationale. Shared between the write side (RevealClient's dismiss mutation)
// and the read side (JournalSidebar's render filter) so they can never
// disagree about what key a dismissal was written under.
// ---------------------------------------------------------------------------

/** The dayIndex a conflict/proposal patch is scoped to, or null for a
 * trip-level one (only `setPacePreset` has none — see engine/types.ts). */
export function dayIndexOfPatch(patch: DocPatch): number | null {
  switch (patch.op) {
    case "removeStop":
    case "setAnchor":
    case "setDayWindow":
    case "setDuration":
      return patch.dayIndex;
    case "moveStop":
      return patch.fromDayIndex;
    case "setPacePreset":
      return null;
  }
}

/** The current dismissal key for a conflict, given the conflict's own
 * `dayIndex` (preferred — always present in practice, per the conflict
 * shape) or, defensively, its resolving proposals' patches. Returns null
 * when `doc.plan` doesn't exist yet (nothing to dismiss against). */
export function dismissalKeyForConflict(
  doc: TripDoc,
  conflict: { dayIndex?: number },
  fallbackPatches: readonly DocPatch[] = []
): string | null {
  if (!doc.plan) return null;
  const dayIndex =
    conflict.dayIndex ??
    fallbackPatches.map(dayIndexOfPatch).find((i): i is number => i !== null);
  if (dayIndex !== undefined && doc.plan.dayHashes?.[dayIndex] !== undefined) {
    return doc.plan.dayHashes[dayIndex];
  }
  return doc.plan.solveHash;
}

/** Whether `conflict` currently has a live (non-expired) dismissal on `doc`. */
export function isConflictDismissed(
  doc: TripDoc,
  conflict: { id: string; dayIndex?: number },
  fallbackPatches: readonly DocPatch[] = []
): boolean {
  const key = dismissalKeyForConflict(doc, conflict, fallbackPatches);
  if (key === null) return false;
  return (doc.dismissedProposals ?? []).some((d) => d.id === conflict.id && d.dayHash === key);
}
