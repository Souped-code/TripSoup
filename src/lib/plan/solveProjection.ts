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
// E3 DECISION: stop.hours (WeeklyHours, src/lib/store/types.ts) is ALSO
// excluded here, deliberately. The current engine (src/lib/schedule/
// schedule.ts) never reads hours at all — E3 only threads them to an
// advisory margin-note check (src/lib/plan/hoursAdvisory.ts) that runs
// AFTER the solve, on the already-computed plan. Including hours in the
// projection would stale every previously-stored plan's solveHash for a
// field the solver structurally ignores — a recompute with zero behaviour
// change. E5 MUST add stop.hours (and any other new constraint field it
// starts consuming) to SolveProjectionStop/solveProjection the moment its
// engine actually reads them, or a hours-only edit will silently serve a
// stale plan.

import type { LatLng } from "../maps/types";
import type { TripDay, TripDoc } from "../store/types";
import { stableHash } from "../util/stableHash";

export type SolveProjectionStop = {
  id: string;
  location: LatLng;
  durationMin: number;
  anchor?: { startMin: number };
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
