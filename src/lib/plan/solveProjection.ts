// E4 — the solve-relevant projection of a TripDoc, and its hash. Pure, no I/O,
// no server-only dependency (deliberately: fileStore.ts's put() invariant
// check imports THIS module, not planStore.ts, to avoid a cycle — planStore.ts
// pulls in ../config, which constructs fileStore.ts itself). See
// src/lib/planStore.ts for the read/write chokepoint that uses this.
//
// solveHash covers EXACTLY what changes the solver's answer:
//   - per day: date, dayStartMin, dayEndMin, stops (id/location/durationMin/
//     anchor only), precedence, manualOrder
//   - settings: walkMax, driveOverheadMin
// It deliberately EXCLUDES legOverrides (a leg toggle re-times the stored
// order via planTripDay's existing legOverrides machinery — no full re-solve
// needed) and every display-only field (stop name/address/source/
// duplicateOf, day dayLabel) — none of those affect what the solver decides.
//
// E5b: stop.hours (WeeklyHours, src/lib/store/types.ts) now ENTERS the
// projection. It used to be excluded (see the git history of this comment for
// the E3-era reasoning): the legacy solver never read hours at all, so
// including them would have staled every stored plan for a field nothing
// consumed. That reasoning no longer holds — src/lib/planEngine.ts's engine
// compiles TripStop.hours into HARD day-concrete constraints
// (src/lib/engine/problem.ts's `hoursFromDoc`, default on) and genuinely
// reorders/breaches around them, so a hours-only edit (a corrected opening
// time, say) can change the solved order and must invalidate the stored plan.
// THIS STALES EVERY PREVIOUSLY-STORED PLAN'S solveHash EXACTLY ONCE — the
// existing self-heal path (planStore.readPlanned: hash mismatch -> recompute,
// persist, return) absorbs it for free on next read, at zero Google spend
// (the travel matrix is still cached). No migration needed or wanted.

import type { LatLng } from "../maps/types";
import type { WeeklyHours } from "../constraints/types";
import type { TripDay, TripDoc } from "../store/types";
import { stableHash } from "../util/stableHash";

export type SolveProjectionStop = {
  id: string;
  location: LatLng;
  durationMin: number;
  anchor?: { startMin: number };
  hours?: WeeklyHours;
};

export type SolveProjectionDay = {
  date: string;
  dayStartMin: number;
  dayEndMin: number;
  stops: SolveProjectionStop[];
  precedence?: TripDay["precedence"];
  manualOrder?: string[];
};

export type SolveProjection = {
  days: SolveProjectionDay[];
  settings: { walkMax: number; driveOverheadMin: number };
};

// canonicalJson (stableHash's backbone) rejects `undefined` outright, so
// optional fields are spread in only when present — never assigned undefined.
export function solveProjection(doc: TripDoc): SolveProjection {
  return {
    days: doc.days.map((day) => ({
      date: day.date,
      dayStartMin: day.dayStartMin,
      dayEndMin: day.dayEndMin,
      stops: day.stops.map((s) => ({
        id: s.id,
        location: s.location,
        durationMin: s.durationMin,
        ...(s.anchor ? { anchor: s.anchor } : {}),
        ...(s.hours ? { hours: s.hours } : {}),
      })),
      ...(day.precedence ? { precedence: day.precedence } : {}),
      ...(day.manualOrder ? { manualOrder: day.manualOrder } : {}),
    })),
    settings: {
      walkMax: doc.settings.walkMax,
      driveOverheadMin: doc.settings.driveOverheadMin,
    },
  };
}

export function computeSolveHash(doc: TripDoc): string {
  return stableHash(solveProjection(doc));
}
