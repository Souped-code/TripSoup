// E4 — plan persistence chokepoint. Server-only. All day plans are computed
// HERE and only here; every read of "the plan" for a trip goes through
// readPlanned, never a fresh per-page recompute (that recompute-on-every-read
// pattern is what E4 replaces — see design.md's E4 for the why). E5 swaps
// planTripDay's solver for a seeded time-budgeted engine without touching this
// module's contract: savePlanned/readPlanned/persistPlanned stay the same,
// only what they stamp into `engine` and how planTripDay computes changes.

import { getTripStore } from "./config";
import { planTripDay } from "./planService";
import { computeSolveHash } from "./plan/solveProjection";
import { applyHoursAdvisories } from "./plan/hoursAdvisory";
import type { DayPlan } from "./schedule/types";
import type { TripDoc } from "./store/types";

export { solveProjection } from "./plan/solveProjection";

// Current engine: the deterministic exhaustive/heuristic solver in
// src/lib/schedule/schedule.ts. `seed` is unused today (the solver is fully
// deterministic) but stamped now so E5's seeded engine is a drop-in — no
// TripDoc shape change needed when it lands.
const ENGINE = { name: "legacy-exhaustive", version: "1", seed: 0 } as const;

// Pure — stamps already-computed day plans onto the doc. No I/O. Exported so
// a caller that has already paid for a full planTripDay pass (pipeline.ts's
// matrix/solve loop) can persist those results without recomputing them.
export function stampPlan(doc: TripDoc, days: DayPlan[]): TripDoc {
  return {
    ...doc,
    plan: {
      version: 1,
      engine: ENGINE,
      computedAt: new Date().toISOString(),
      solveHash: computeSolveHash(doc),
      days,
    },
  };
}

export async function persistPlanned(doc: TripDoc, days: DayPlan[]): Promise<TripDoc> {
  const stamped = stampPlan(doc, days);
  await getTripStore().put(stamped);
  return stamped;
}

// Solve every day fresh and persist the result. The ONLY place day plans are
// computed from scratch — every explicit re-plan (PUT /api/trips/[id], POST
// /api/trips/[id]/plan, a legOverrides toggle) routes through here.
//
// Same resilience pattern the reveal/share pages used to apply themselves: a
// single day's planTripDay failure (matrix/adapter error) degrades to a
// rejected-status plan for THAT day rather than throwing and taking the whole
// save down with it.
export async function savePlanned(doc: TripDoc): Promise<TripDoc> {
  const days: DayPlan[] = await Promise.all(
    doc.days.map(async (_, i) => {
      try {
        return await planTripDay(doc, i);
      } catch (e) {
        return {
          status: "rejected" as const,
          message:
            "This day's plan couldn't be cooked — " + (e instanceof Error ? e.message : String(e)),
        };
      }
    })
  );
  // E3 — advisory-only opening-hours warnings, applied to the freshly
  // computed plans BEFORE they're persisted (see hoursAdvisory.ts's header
  // for why this isn't inside persistPlanned/stampPlan itself).
  return persistPlanned(doc, applyHoursAdvisories(doc, days));
}

// Read the stored plan, self-healing exactly once when it's missing or stale:
//   - missing entirely -> a pre-E4 doc, never had a plan stamped
//   - solveHash mismatch -> the solve-relevant projection changed since the
//     last stamp (tampered doc, or a bug elsewhere that wrote via a path other
//     than this module)
// Both cases get the same treatment: recompute, persist, return the healed
// doc. The travel matrix is cached (file/KV — see config.ts), so a heal is
// never a meaningful spend.
// A rejected day may be a TRANSIENT failure (matrix/KV hiccup during the solve
// that stamped it) — pre-E4 the next page load recomputed and self-recovered,
// so a persisted plan must not turn a hiccup into a permanent "couldn't be
// cooked" (E4 audit, finding 1 [MAJOR]). A stored plan containing a rejected
// day is therefore heal-eligible again once it has AGED past this window. The
// window is the hot-loop guard: a deterministically-broken day re-solves at
// most once per window per read, not on every read.
const REJECTED_RETRY_AFTER_MS = 5 * 60_000;

export async function readPlanned(tripId: string): Promise<TripDoc | null> {
  const doc = await getTripStore().get(tripId);
  if (!doc) return null;
  if (doc.plan && doc.plan.solveHash === computeSolveHash(doc)) {
    const hasRejectedDay = doc.plan.days.some((d) => d.status === "rejected");
    if (!hasRejectedDay) return doc;
    const ageMs = Date.now() - Date.parse(doc.plan.computedAt);
    // NaN age (malformed computedAt) deliberately falls through to heal.
    if (ageMs < REJECTED_RETRY_AFTER_MS) return doc;
  }
  return savePlanned(doc);
}
