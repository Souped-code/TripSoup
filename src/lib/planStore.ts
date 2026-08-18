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
//
// E5c — day-scoped solving (STATE.md's "CHRIS DECISIONS on the E5b product
// flags"): `savePlanned` is now INCREMENTAL. Below the toggle fast path, a
// second, cheaper-but-not-free fast path checks each day's own content hash
// (plan/solveProjection.ts's dayProjection/computeDayHash) against the
// stored plan's `dayHashes`: a day whose hash still matches AND whose stored
// status is "ok" is kept VERBATIM — not recomputed, not even touched. Only
// the days that actually changed (or a settings edit, which touches every
// day's projection, or a rejected day retrying) get solved, and each gets
// its OWN engine call (planEngine.ts's solveDayWithEngine) with its OWN
// content-derived seed — an edit to day 5 cannot reseed, and therefore
// cannot reshuffle, day 2. Explicit re-cook (recookDay/recookTrip below) is
// the only place a fresh solve happens WITHOUT a hash mismatch driving it.

import { getTripStore } from "./config";
import { planTripDay } from "./planService";
import {
  applyHoursAdvisoryToDay,
  applyOverridesToPlan,
  annotateAutoMoves,
  autoRelocateClosedDayStops,
  crossDayPrecedenceNotes,
  matrixForDay,
  planTripWithEngine,
  rescheduleDayWithBase,
  seedFor,
  settingsOf,
  solveDayWithEngine,
  toLegacyDay,
  type DaySolveResult,
  type EngineMeta,
} from "./planEngine";
import { alnsEngine, type Conflict, type DocPatch, type Proposal } from "./engine";
import { computeDayHashes, computeSolveHash } from "./plan/solveProjection";
import { rescheduleDay } from "./schedule/schedule";
import type { DayPlan } from "./schedule/types";
import type { TripDay, TripDoc } from "./store/types";

export { solveProjection } from "./plan/solveProjection";
export { planTripDay };

type PlanExtras = { conflicts?: Conflict[]; proposals?: Proposal[] };

// Pure — stamps already-computed day plans onto the doc. No I/O. Exported so
// a caller that has already paid for a full solve (pipeline.ts's matrix/solve
// stage) can persist those results without recomputing them. dayHashes is
// ALWAYS computed fresh off `doc` here (never threaded through as a param) —
// it is a pure function of the doc, and every caller of stampPlan/
// persistPlanned (toggle fast path, day-scoped incremental save, explicit
// re-cook, pipeline.ts's first solve) wants exactly that, so there is no
// version to get wrong.
export function stampPlan(doc: TripDoc, days: DayPlan[], engine: EngineMeta, extras: PlanExtras = {}): TripDoc {
  return {
    ...doc,
    plan: {
      version: 1,
      engine,
      computedAt: new Date().toISOString(),
      solveHash: computeSolveHash(doc),
      dayHashes: computeDayHashes(doc),
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

// Two note classes are RE-DERIVED on every retime rather than carried (E5b
// audit F5; E5c audit F1): hours advisories ("Heads up — ", re-derived from
// the retimed schedule) and cross-day precedence ("Worth noting — ",
// re-derived from the doc). Everything else ("Pace check — ", conflict notes)
// carries verbatim — a kept/retimed day's content hasn't changed, so those
// remain valid. The prefixes ARE the class markers; see planEngine.ts's
// softViolationNotesForDay comment for the taxonomy.
const REDERIVED_NOTE_PREFIXES = ["Heads up — ", "Worth noting — "];

/**
 * The one retime-with-overrides carry, shared by the toggle fast path AND the
 * incremental save's kept days (E5c audit F2: kept days previously skipped
 * this entirely, so a toggle saved alongside any rejected day — which
 * declines the fast path — silently never re-timed: the override persisted on
 * the doc while the kept plan showed the old mode).
 */
async function retimeStoredDay(
  doc: TripDoc,
  i: number,
  storedPlan: DayPlan,
  settings: ReturnType<typeof settingsOf>
): Promise<DayPlan> {
  if (storedPlan.status !== "ok") return storedPlan;
  const tripDay = doc.days[i];
  const { matrix, rejectedMessage } = await matrixForDay(tripDay, settings, doc.homeBase);
  if (rejectedMessage) return { status: "rejected" as const, message: rejectedMessage };

  const day = toLegacyDay(tripDay);
  const base = rescheduleDayWithBase(doc, day, storedPlan.order, matrix, settings, storedPlan.quality);
  if (base.status !== "ok") return base;
  const carried = (storedPlan.marginNotes ?? []).filter(
    (n) => !REDERIVED_NOTE_PREFIXES.some((p) => n.startsWith(p))
  );
  const withCross = [...carried, ...crossDayPrecedenceNotes(doc, i)];
  const seeded = withCross.length > 0 ? { ...base, marginNotes: withCross } : base;
  const retimed = applyOverridesToPlan(doc, i, day, seeded, matrix, settings);
  return applyHoursAdvisoryToDay(doc, i, retimed);
}

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
    prior.days.map((storedPlan, i) => retimeStoredDay(doc, i, storedPlan, settings))
  );

  return persistPlanned(doc, days, prior.engine, {
    conflicts: prior.conflicts,
    proposals: prior.proposals,
  });
}

// ---------------------------------------------------------------------------
// E5c — day-scoped incremental save
// ---------------------------------------------------------------------------

function currentEngineMeta(doc: TripDoc): EngineMeta {
  return { name: alnsEngine.name, version: alnsEngine.version, seed: seedFor(doc) };
}

/** Which days need a fresh solve. A day is stale when:
 *   - the stored plan can't be trusted to cover it at all (missing/wrong-
 *     length dayHashes -> every pre-E5c doc; a day-count mismatch; or a
 *     different production engine -> "structural", ALL days go stale, the
 *     one-time heal STATE.md's E5c design calls for), or
 *   - its own content hash changed (plan/solveProjection.ts's
 *     computeDayHash — covers that day's fields PLUS doc.settings, so a
 *     settings edit stales every day), or
 *   - its stored status isn't "ok" (a rejected day always gets a fresh
 *     attempt on an explicit save; readPlanned's age-gated heal path is what
 *     scopes an aged rejection's retry down to just that day — see its own
 *     comment), or
 *   - the caller force-marked it stale (recookDay's "ignore matching hash").
 */
function staleDayIndices(
  doc: TripDoc,
  priorPlan: TripDoc["plan"] | undefined,
  currentHashes: readonly string[],
  forceStale: ReadonlySet<number>
): Set<number> {
  const structural =
    !priorPlan ||
    !priorPlan.dayHashes ||
    priorPlan.dayHashes.length !== doc.days.length ||
    priorPlan.days.length !== doc.days.length ||
    priorPlan.engine.name !== alnsEngine.name;

  const stale = new Set<number>();
  doc.days.forEach((_, i) => {
    if (structural || forceStale.has(i)) {
      stale.add(i);
      return;
    }
    const hashChanged = priorPlan!.dayHashes![i] !== currentHashes[i];
    const notOk = priorPlan!.days[i]?.status !== "ok";
    if (hashChanged || notOk) stale.add(i);
  });
  return stale;
}

function proposalTouchesDay(patch: DocPatch, days: ReadonlySet<number>): boolean {
  switch (patch.op) {
    case "removeStop":
    case "setAnchor":
    case "setDayWindow":
    case "setDuration":
      return days.has(patch.dayIndex);
    case "moveStop":
      return days.has(patch.fromDayIndex) || days.has(patch.toDayIndex);
    case "setPacePreset":
      return false;
  }
}

/** The incremental save at the heart of E5c: kept days are carried forward
 * exactly as stored (same DayPlan object — not recomputed, not even
 * touched); stale days are solved DAY-SCOPED, independently of each other
 * (planEngine.ts's solveDayWithEngine — one engine call per stale day, its
 * own seed, its own try/catch so one day's failure can't take another down).
 * `forceStale` additionally forces specific days to resolve even when their
 * hash still matches — recookDay's explicit "solve this fresh anyway". */
async function solveIncremental(
  doc: TripDoc,
  stored: TripDoc | null,
  opts: { healMode?: boolean },
  forceStale: ReadonlySet<number> = new Set()
): Promise<TripDoc> {
  const priorPlan = stored?.plan;
  const currentHashes = computeDayHashes(doc);
  const stale = staleDayIndices(doc, priorPlan, currentHashes, forceStale);

  const fresh = new Map<number, DaySolveResult>();
  await Promise.all(
    [...stale].map(async (i) => {
      try {
        fresh.set(i, await solveDayWithEngine(doc, i, opts.healMode ? { wallClockOnly: true } : {}));
      } catch (e) {
        // Day-scoped, so an exception here has exactly one day to blame —
        // unlike the pre-E5c whole-trip solve, every OTHER stale day (and
        // every kept day) is unaffected.
        const message = "This day's plan couldn't be cooked — " + (e instanceof Error ? e.message : String(e));
        fresh.set(i, {
          day: { status: "rejected" as const, message },
          conflicts: [],
          proposals: [],
          softViolations: [],
        });
      }
    })
  );

  // Kept days are NOT carried raw: they pass through the same
  // retime-with-overrides carry the toggle fast path uses (audit F2 — a
  // legOverrides change rides along with any other edit in one PUT, and
  // dayProjection deliberately excludes legOverrides, so a kept day's hash
  // can match while its overrides changed). Retime is O(stops) per day with
  // a cached matrix — cheap, and idempotent when nothing changed.
  const days: DayPlan[] = await Promise.all(
    doc.days.map((_, i) =>
      stale.has(i)
        ? Promise.resolve(fresh.get(i)!.day)
        : retimeStoredDay(doc, i, priorPlan!.days[i], settingsOf(doc))
    )
  );

  // Conflicts/proposals: keep the stored ones that belong entirely to KEPT
  // days; a conflict with no dayIndex (trip-global) is dropped rather than
  // guessed at — a real trip-scope re-cook is what recomputes those honestly.
  const keptConflicts = (priorPlan?.conflicts ?? []).filter(
    (c) => c.dayIndex !== undefined && !stale.has(c.dayIndex)
  );
  const keptConflictIds = new Set(keptConflicts.map((c) => c.id));
  const keptProposals = (priorPlan?.proposals ?? [])
    .map((p) => ({ ...p, resolves: p.resolves.filter((id) => keptConflictIds.has(id)) }))
    .filter((p) => p.resolves.length > 0 && !proposalTouchesDay(p.patch, stale));

  // Flatten in DAY-INDEX order, not Promise.all completion order (audit F3 —
  // with 2+ stale days and real-provider I/O, insertion order into `fresh` is
  // nondeterministic, denting "same doc + same edit → same bytes").
  const staleSorted = [...stale].sort((a, b) => a - b);
  const freshConflicts = staleSorted.flatMap((i) => fresh.get(i)!.conflicts);
  const freshProposals = staleSorted.flatMap((i) => fresh.get(i)!.proposals);

  return persistPlanned(doc, days, currentEngineMeta(doc), {
    conflicts: [...keptConflicts, ...freshConflicts],
    proposals: [...keptProposals, ...freshProposals],
  });
}

// Solve (or cheaply retime, or incrementally re-solve just the stale days)
// and persist the result. This is the ONLY place day plans are computed from
// scratch — every explicit re-plan (PUT /api/trips/[id], POST
// /api/trips/[id]/plan, a legOverrides toggle) routes through here.
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

  // healMode (audit F1): heals run inside PAGE renders, so day-scoped solves
  // use the engine's wall-clock mode — guaranteed to finish near the budget
  // rather than running an iterCap to completion on whatever CPU serverless
  // gave us. Threaded through solveIncremental -> solveDayWithEngine.
  return solveIncremental(doc, stored, opts);
}

function withoutManualOrder(day: TripDay): TripDay {
  if (!day.manualOrder) return day;
  const { manualOrder: _drop, ...rest } = day;
  return rest;
}

// ---------------------------------------------------------------------------
// E5c — explicit re-cook. Subsumes the old bare "re-optimize" semantics
// (clearing manualOrder and handing ordering back to the solver), now
// explicitly SCOPED: one day, or the whole trip.
// ---------------------------------------------------------------------------

/** Re-cook one day: clears THAT day's manualOrder and force-solves it fresh
 * — even if its content hash already matches the stored plan (an already-
 * engine-solved day with no manualOrder to clear still gets a genuine new
 * solve; "re-cook" is a real, explicit action, not a conditional no-op).
 * Every OTHER day is left exactly as stored — recook is scoped like an
 * ordinary edit (STATE.md's E5c decision 1). Unrelated staleness elsewhere
 * (another hash-stale or rejected day) IS also re-solved on the same pass —
 * staleDayIndices makes no scope distinction, deliberately: serving a
 * knowingly-stale day just to honour scope wording would be worse (E5c audit
 * F5 corrected this comment, not the behaviour). (When the stored plan can't be
 * trusted to cover the trip at all — missing, legacy, or a day-count
 * mismatch — `solveIncremental`'s own structural check falls back to
 * resolving every day; there is no honest "other days as stored" to keep in
 * that case either.) */
export async function recookDay(doc: TripDoc, dayIndex: number): Promise<TripDoc> {
  const cleared: TripDoc = {
    ...doc,
    days: doc.days.map((d, i) => (i === dayIndex ? withoutManualOrder(d) : d)),
  };
  const stored = await getTripStore().get(cleared.tripId);
  return solveIncremental(cleared, stored, {}, new Set([dayIndex]));
}

/** Re-cook the whole trip: clears EVERY day's manualOrder and runs one joint
 * whole-trip engine solve (planEngine.ts's planTripWithEngine — the same
 * path the pre-E5c whole-doc save always used). This is the one place a
 * fresh solve spans multiple days at once, so it's the only place cross-day
 * moveDay proposals can surface (they need the cross-day view) and the only
 * place the whole-doc seed (`seedFor`) still governs a solve. */
export async function recookTrip(doc: TripDoc): Promise<TripDoc> {
  const cleared: TripDoc = { ...doc, days: doc.days.map(withoutManualOrder) };
  try {
    let target = cleared;
    let result = await planTripWithEngine(target);
    let days = result.days;
    // Closed-day auto-relocation (Chris, 2026-08-14) — whole-trip solves only;
    // see planEngine's autoRelocateClosedDayStops doc comment for why this can
    // never override a user decision. One pass, one re-solve, by design.
    const relocated = autoRelocateClosedDayStops(target, result);
    if (relocated) {
      target = relocated.doc;
      result = await planTripWithEngine(target);
      days = annotateAutoMoves(result.days, relocated.moves);
    }
    return persistPlanned(target, days, result.engineMeta, {
      conflicts: result.conflicts,
      proposals: result.proposals,
    });
  } catch (e) {
    // Mirrors the pre-E5c whole-doc catch: one joint call, no single day to
    // blame, so every day degrades to rejected together rather than losing
    // the save.
    const message = "This day's plan couldn't be cooked — " + (e instanceof Error ? e.message : String(e));
    const days: DayPlan[] = cleared.days.map(() => ({ status: "rejected" as const, message }));
    return persistPlanned(cleared, days, currentEngineMeta(cleared));
  }
}

// Read the stored plan, self-healing when it's missing or stale:
//   - missing entirely -> a pre-E4 doc, never had a plan stamped
//   - solveHash mismatch -> the solve-relevant projection changed since the
//     last stamp (tampered doc, a bug elsewhere that wrote via a path other
//     than this module, OR — once, for every doc stamped before E5b — hours
//     newly entering the projection; see plan/solveProjection.ts's header)
//   - dayHashes missing or the wrong length -> a pre-E5c doc (or one whose
//     day count changed under a mismatched plan somehow), heal-eligible for
//     the same "structural" reason solveIncremental treats it as ALL-stale
//   - a stored day is `rejected` and the plan has aged past the retry window
//     below
// Below, `savePlanned` is now INCREMENTAL (E5c): a tampered/rejected SINGLE
// day heals just that day, not the whole trip; a legacy doc (no dayHashes)
// heals every day once, exactly as it did pre-E5c. The travel matrix is
// cached (file/KV — see config.ts), so a heal is never a meaningful spend.
// A rejected day may be a TRANSIENT failure (matrix/KV hiccup during the solve
// that stamped it) — pre-E4 the next page load recomputed and self-recovered,
// so a persisted plan must not turn a hiccup into a permanent "couldn't be
// cooked" (E4 audit, finding 1 [MAJOR]). A stored plan containing a rejected
// day is therefore heal-eligible again once it has AGED past this window. The
// window is the hot-loop guard: a deterministically-broken day re-solves at
// most once per window per read, not on every read — and (E5c) that re-solve
// is scoped to just the rejected day(s), via solveIncremental's own
// hash-matches-but-not-"ok" staleness rule.
const REJECTED_RETRY_AFTER_MS = 5 * 60_000;

export async function readPlanned(tripId: string): Promise<TripDoc | null> {
  const doc = await getTripStore().get(tripId);
  if (!doc) return null;
  const structurallyFresh =
    !!doc.plan?.dayHashes &&
    doc.plan.dayHashes.length === doc.days.length &&
    doc.plan.days.length === doc.days.length;
  if (doc.plan && structurallyFresh && doc.plan.solveHash === computeSolveHash(doc)) {
    const hasRejectedDay = doc.plan.days.some((d) => d.status === "rejected");
    if (!hasRejectedDay) return doc;
    const ageMs = Date.now() - Date.parse(doc.plan.computedAt);
    // NaN age (malformed computedAt) deliberately falls through to heal.
    if (ageMs < REJECTED_RETRY_AFTER_MS) return doc;
  }
  return savePlanned(doc, { healMode: true });
}
