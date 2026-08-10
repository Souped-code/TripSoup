// Trip document + tripStore port — §4. One JSON document per trip, behind a
// slug. Anchors marked inline on stops; §2's persisted per-leg toggles live in
// legOverrides; user-facing settings (walkMax, driveOverheadMin) on the doc.

import type { LatLng } from "../maps/types";
import type { DayPlan } from "../schedule/types";
import type { WeeklyHours } from "../constraints/types";
// Imported from engine/types directly (not the engine/ barrel, which pulls in
// problem.ts, which imports TripDoc from THIS file) — a type-only import from
// the leaf module avoids that cycle.
import type { Conflict, Proposal } from "../engine/types";

export type TripStop = {
  id: string; // place_id (fixture or Google); a same-day duplicate occurrence
  // (D2.3 T4b) gets a deterministic suffixed id `${placeId}#${n}` instead —
  // see duplicateOf below.
  name: string;
  location: LatLng;
  address?: string;
  durationMin: number;
  anchor?: { startMin: number };
  source?: string; // original pasted input
  // D2.3 (T4b): set when this stop resolved to the SAME place as an earlier
  // stop within the same day (pipeline.ts's markDuplicateStops). Value = the
  // first occurrence's (bare, unsuffixed) place id. Additive/optional —
  // absent on existing docs and on every non-duplicate stop. Supersedes T4's
  // dedupDayStops (commit 5ea9719), which silently dropped the later
  // occurrence instead of keeping + flagging it; the UI (T6 sidebar) derives
  // its "duplicate of Stop N — remove if accidental" affordance from this
  // field, and the user decides whether the repeat was intentional.
  duplicateOf?: string;
  // E3 — Google's regularOpeningHours (resolvePlaces.ts's `Stop.openingHours`),
  // parsed via src/lib/maps/openingHours.ts's parseGoogleHours and attached
  // only when non-null. Additive/optional — absent on pre-E3 docs and on any
  // stop whose payload had no usable hours. Consumed today ONLY as an
  // advisory (src/lib/plan/hoursAdvisory.ts, via planStore.savePlanned /
  // pipeline.ts): a planned visit outside these hours produces a margin note,
  // never a solver constraint — E5 is what makes hours load-bearing on the
  // solve itself. Deliberately EXCLUDED from solveHash (see
  // src/lib/plan/solveProjection.ts's header comment) — the current engine
  // never reads it, so including it would stale every stored plan for zero
  // behaviour change.
  hours?: WeeklyHours;
};

export type TripDay = {
  date: string;
  // M1.5 — set when the paste gave no real calendar date ("Day 2", "Saturday",
  // or nothing at all). When present, `date` is an INERT placeholder (the run's
  // reference today) and day headings must render this label instead — never
  // today's real date dressed up as the trip date. Absent means `date` is a
  // genuine date the user supplied. Additive/optional: absent on existing docs.
  // Schedule math never reads either field; it runs on dayStartMin/dayEndMin.
  dayLabel?: string;
  dayStartMin: number;
  dayEndMin: number;
  stops: TripStop[];
  // Optional "visit beforeId before afterId" wishes (D2.1b). Additive: absent on
  // existing docs. Within-segment pairs constrain the solver; cross-segment pairs
  // are validated post-assembly; cross-day pairs surface as margin notes.
  precedence?: Array<{ beforeId: string; afterId: string; reason?: string }>;
  // Optional user-pinned order (D2.3, audit finding 12). When present and a valid
  // permutation of this day's stop ids, planTripDay skips the solver and retimes
  // this exact order (quality "manual"). Written by drag-reorder; cleared by the
  // "re-optimize" button (which hands ordering back to the solver).
  manualOrder?: string[];
};

export type LegOverride = {
  dayIndex: number;
  fromId: string;
  toId: string;
  mode: "walk" | "drive";
};

// E4 — persisted plan state (src/lib/planStore.ts is the sole writer). The
// engine used to be recomputed on every read (deterministic solver); E5
// swaps the solver for a seeded time-budgeted engine, killing that
// recompute-determinism, so plans must live as state on the doc instead.
// Additive/optional like every prior field — absent on pre-E4 docs, which
// planStore.readPlanned heals lazily on first read.
export type TripDoc = {
  tripId: string;
  days: TripDay[];
  settings: { walkMax: number; driveOverheadMin: number };
  legOverrides: LegOverride[];
  plan?: {
    version: 1;
    // The engine that produced `days` below. E5b: the production engine is
    // the E5a ALNS (src/lib/engine/, name "alns-ts") behind the SolverEngine
    // port; `seed` is derived deterministically from the doc's own solve
    // projection (src/lib/planEngine.ts's `seedFor`) — same doc, same seed,
    // same plan. The pre-E5 legacy exhaustive/heuristic solver ("legacy-
    // exhaustive") stays importable (src/lib/planService.ts's `planTripDay`,
    // used directly for a single day and for the manualOrder/toggle-only
    // paths) but is no longer what stamps a fresh whole-trip plan.
    engine: { name: string; version: string; seed: number };
    computedAt: string; // ISO timestamp
    // stableHash (../util/stableHash) of solveProjection(doc) — see
    // ../plan/solveProjection.ts for exactly what this covers/excludes.
    solveHash: string;
    days: DayPlan[]; // one per doc day, same DayPlan union as ../schedule/types
    // E5b — additive/optional, absent on pre-E5b docs (and on the "manual
    // order"/"toggle-only fast path" writes that don't recompute them; see
    // planStore.savePlanned). The engine's relaxations (never a silent cut)
    // and the priced ways out of them — src/lib/engine/types.ts is the
    // source of truth for both shapes. E6 renders these as cards; E5b only
    // stores them and turns them into short margin notes.
    conflicts?: Conflict[];
    proposals?: Proposal[];
  };
};

export interface TripStore {
  get(tripId: string): Promise<TripDoc | null>;
  put(doc: TripDoc): Promise<void>;
}
