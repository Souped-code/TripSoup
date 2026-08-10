// E4 — plan persistence chokepoint. Server-only. All day plans are computed
// HERE and only here; every read of "the plan" for a trip goes through
// readPlanned, never a fresh per-page recompute (that recompute-on-every-read
// pattern is what E4 replaces — see design.md's E4 for the why).
//
// E5b: `savePlanned` now runs the E5a engine (src/lib/planEngine.ts) instead
// of the legacy per-day solver. Two exceptions stay on cheaper/older paths on
// purpose:
//   - `planTripDay` (src/lib/planService.ts, unchanged) is still exported and
//     used directly by tests and by anything that only needs ONE day's plan
//     without paying for a whole-trip engine solve.
//   - the "toggle-only" fast path below: when NOTHING solve-relevant changed
//     since the stored plan (same solveHash) and the stored plan was produced
//     by the CURRENT production engine, only `legOverrides` could have
//     changed (solveHash now covers every other solve-relevant field,
//     including hours — see plan/solveProjection.ts). Retiming the stored
//     order per day is O(stops), not O(engine budget) — this is what keeps a
//     leg toggle instant once solves cost up to ENGINE_BUDGET_MS instead of
//     being effectively free (E4's carry-forward note; the audit called this
//     "the 20s-toggle problem").

import { getTripStore } from "./config";
import { planTripDay } from "./planService";
import {
  applyHoursAdvisoryToDay,
  applyOverridesToPlan,
  matrixForDay,
  planTripWithEngine,
  seedFor,
  settingsOf,
  toLegacyDay,
  type EngineMeta,
} from "./planEngine";
import { alnsEngine, type Conflict, type Proposal } from "./engine";
import { computeSolveHash } from "./plan/solveProjection";
import { rescheduleDay } from "./schedule/schedule";
import type { DayPlan } from "./schedule/types";
import type { TripDoc } from "./store/types";

export { solveProjection } from "./plan/solveProjection";
export { planTripDay };

type PlanExtras = { conflicts?: Conflict[]; proposals?: Proposal[] };

// Pure — stamps already-computed day plans onto the doc. No I/O. Exported so
// a caller that has already paid for a full solve (pipeline.ts's matrix/solve
// stage) can persist those results without recomputing them.
export function stampPlan(doc: TripDoc, days: DayPlan[], engine: EngineMeta, extras: PlanExtras = {}): TripDoc {
  return {
    ...doc,
    plan: {
      version: 1,
      engine,
      computedAt: new Date().toISOString(),
      solveHash: computeSolveHash(doc),
      days,
      ...(extras.conflicts && extras.conflicts.length > 0 ? { conflicts: extras.conflicts } : {}),
      ...(extras.proposals && extras.proposals.length > 0 ? { proposals: extras.proposals } : {}),
    },
  };
}

export async function persistPlanned(
  doc: TripDoc,
  days: DayPlan[],
  engine: EngineMeta,
  extras: PlanExtras = {}
): Promise<TripDoc> {
  const stamped = stampPlan(doc, days, engine, extras);
  await getTripStore().put(stamped);
  return stamped;
}

// ---------------------------------------------------------------------------
// Toggle-only fast path
// ---------------------------------------------------------------------------

// hoursAdvisory's notes all share this prefix — the fast path strips and
// re-derives them on the RETIMED schedule (E5b audit F5: a toggle that shifts
// an arrival past closing produced no new note, and a stale "closes before
// you'd arrive" survived a toggle that un-broke it).
const HOURS_NOTE_PREFIX = "Heads up — ";

/**
 * Returns the retimed doc when `doc` qualifies for the cheap toggle path,
 * or null when a real re-plan is needed.
 *
 * `prior` is the STORE's copy of the plan, never the incoming doc's (E5b
 * audit F6): plan is a server-computed field, but `engine.name` and
 * `solveHash` are client-computable, so trusting the request body's copy let
 * a crafted PUT persist a fabricated order/quality/notes that share viewers
 * would then be served — and a non-permutation order would throw inside
 * rescheduleDay as an unhandled 500. The store's copy is the only honest one.
 *
 * Every stored day's ORDER is kept exactly as-is (quality label included —
 * "manual" stays "manual") and only re-timed against the current
 * legOverrides; conflicts/proposals carry forward unchanged (they describe
 * the constraint model, which — by the solveHash match — has not moved).
 * Hours advisories are re-derived from the retimed schedule, not carried.
 */
async function toggleFastPath(doc: TripDoc, prior: TripDoc["plan"]): Promise<TripDoc | null> {
  if (!prior) return null;
  if (prior.engine.name !== alnsEngine.name) return null;
  if (prior.solveHash !== computeSolveHash(doc)) return null;
  // A rejected/infeasible day needs a REAL retry (its matrix fetch might
  // succeed now — see readPlanned's REJECTED_RETRY_AFTER_MS heal path below),
  // not a pass-through that never re-attempts it. The fast path only applies
  // when every stored day is healthy, i.e. the only thing that could have
  // changed under a matching solveHash is legOverrides.
  if (prior.days.some((d) => d.status !== "ok")) return null;
  // Belt-and-braces alongside the solveHash match: the stored plan must cover
  // exactly the doc's days (a mismatched stored plan crashed the share render
  // in the F6 attack; unreachable once prior comes from the store, but cheap).
  if (prior.days.length !== doc.days.length) return null;

  const settings = settingsOf(doc);
  const days: DayPlan[] = await Promise.all(
    prior.days.map(async (storedPlan, i) => {
      if (storedPlan.status !== "ok") return storedPlan;
      const tripDay = doc.days[i];
      const { matrix, rejectedMessage } = await matrixForDay(tripDay, settings);
      if (rejectedMessage) return { status: "rejected" as const, message: rejectedMessage };

      const day = toLegacyDay(tripDay);
      const base = rescheduleDay(day, storedPlan.order, matrix, settings, storedPlan.quality);
      if (base.status !== "ok") return base;
      // Carry every stored note EXCEPT hours advisories, which are re-derived
      // below against the retimed schedule (audit F5).
      const carried = (storedPlan.marginNotes ?? []).filter((n) => !n.startsWith(HOURS_NOTE_PREFIX));
      const seeded = carried.length > 0 ? { ...base, marginNotes: carried } : base;
      const retimed = applyOverridesToPlan(doc, i, day, seeded, matrix, settings);
      return applyHoursAdvisoryToDay(doc, i, retimed);
    })
  );

  return persistPlanned(doc, days, prior.engine, {
    conflicts: prior.conflicts,
    proposals: prior.proposals,
  });
}

// Solve (or cheaply retime) every day and persist the result. This is the
// ONLY place day plans are computed from scratch — every explicit re-plan
// (PUT /api/trips/[id], POST /api/trips/[id]/plan, a legOverrides toggle)
// routes through here.
export async function savePlanned(
  doc: TripDoc,
  opts: { healMode?: boolean } = {}
): Promise<TripDoc> {
  // The fast-path prior comes from the STORE, never the incoming doc (audit
  // F6 — see toggleFastPath's doc comment). One extra get per save; the
  // stores are a local file read or one KV round-trip.
  const stored = await getTripStore().get(doc.tripId);
  const fast = await toggleFastPath(doc, stored?.plan);
  if (fast) return fast;

  try {
    // planTripWithEngine already applies the E3 hours advisory per day
    // internally (engine days get it as a defensive catch-all on top of the
    // engine's own hard hours handling; manualOrder/rejected days get it as
    // their ONLY hours check, hours being advisory-only there) — nothing left
    // to do here but persist.
    //
    // healMode (audit F1): heals run inside PAGE renders, so they use the
    // engine's wall-clock mode — guaranteed to finish near the budget rather
    // than running an iterCap to completion on whatever CPU serverless gave us.
    const result = await planTripWithEngine(doc, opts.healMode ? { wallClockOnly: true } : {});
    return persistPlanned(doc, result.days, result.engineMeta, {
      conflicts: result.conflicts,
      proposals: result.proposals,
    });
  } catch (e) {
    // The engine solves every non-bypassed day in ONE call (E5a's per-trip,
    // not per-day, architecture) — an exception here (buildProblem on
    // malformed input; matrix errors are already caught per-day inside
    // planTripWithEngine and never reach this catch) has no single day to
    // blame, so every day degrades to rejected together rather than losing
    // the save. This mirrors the resilience pre-E5b had per-day, at the
    // coarser grain the new architecture actually offers.
    const message = "This day's plan couldn't be cooked — " + (e instanceof Error ? e.message : String(e));
    const days: DayPlan[] = doc.days.map(() => ({ status: "rejected" as const, message }));
    return persistPlanned(doc, days, { name: alnsEngine.name, version: alnsEngine.version, seed: seedFor(doc) });
  }
}

// Read the stored plan, self-healing exactly once when it's missing or stale:
//   - missing entirely -> a pre-E4 doc, never had a plan stamped
//   - solveHash mismatch -> the solve-relevant projection changed since the
//     last stamp (tampered doc, a bug elsewhere that wrote via a path other
//     than this module, OR — once, for every doc stamped before E5b — hours
//     newly entering the projection; see plan/solveProjection.ts's header)
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
  return savePlanned(doc, { healMode: true });
}
