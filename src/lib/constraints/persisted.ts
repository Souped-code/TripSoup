// E7 — the PERSISTED constraint layer. TripDoc.constraints is a stored
// ConstraintPatch (E2's wire shape, unchanged): what the LLM compiler emitted,
// what a user's chip confirm/delete/edit rewrote, what the E6 pace-proposal
// accept writes. This module owns its three lifecycle points:
//
//   sanitizeConstraintPatch — the boundary. Structural zod validation, unknown
//     stop keys / out-of-range days dropped, the E7 safety rules ENFORCED in
//     data (an llm-sourced constraint without a verbatim evidence quote is
//     dropped; an llm-UNCONFIRMED constraint can never be hard — clamped to
//     soft). Runs at the PUT boundary (normalizing what's stored) and
//     defensively before every solve merge.
//
//   mergeStoredPatches — how a NEW compile lands on an EXISTING stored patch:
//     slot-wise winner() (E2's one merge rule), so a fresh llm emission
//     replaces last week's llm emission but can never displace a user edit or
//     a confirmed chip.
//
//   constraintSetForSolve — what the solve paths call instead of bare
//     compileFromDoc: the compiled base with the stored patch merged on top.
//     No stored patch = byte-identical to compileFromDoc (E5/E6 behaviour).
//
// Positional-day caveat (E2 audit's design note, owned here): `days` patch
// keys are positional. Sanitization drops indexes outside the CURRENT doc, but
// a day inserted/reordered later can still retarget a surviving day-scoped
// entry. v1 records this as a known limitation; stop-level entries (the bulk
// of E7 emissions) are keyed by occurrence id and immune.

import { z } from "zod";
import type { TripDoc } from "../store/types";
import {
  winner,
  type Constraint,
  type ConstraintPatch,
  type ConstraintSet,
  type DayConstraintsPatch,
  type ListConstraint,
  type PartyConstraintsPatch,
  type Relation,
  type StopConstraintsPatch,
} from "./types";
import { compileFromDoc, mergePatches, stopKeys } from "./compile";

/** Default penalty for an unconfirmed LLM assertion (same currency as the
 * objective: ~1 unit per minute of travel). Deliberately below
 * CROSS_DAY_PRECEDENCE_WEIGHT (50): an unconfirmed guess should bend before a
 * stated wish does. */
export const LLM_SOFT_WEIGHT = 30;

/** TIMED intent (stop windows, day pins) prices higher: honouring "sunset at
 * the park" usually COSTS wait (0.3/min — six idle hours ≈ 112 units), so a
 * window priced like other soft slots would rationally never bend the
 * schedule it exists to bend. 150 outbids the realistic wait range while
 * still losing to a hard constraint and to dropping a should-stop (200). */
export const LLM_WINDOW_WEIGHT = 150;

// ---------------------------------------------------------------------------
// Wire schema (bounded — this crosses the PUT boundary)
// ---------------------------------------------------------------------------

const MinutesSchema = z.number().finite().min(0).max(2880);
const WindowSchema = z
  .object({ startMin: MinutesSchema, endMin: MinutesSchema })
  .refine((w) => w.endMin >= w.startMin, { message: "endMin before startMin" });
const HardnessSchema = z.union([
  z.literal("hard"),
  z.object({ soft: z.object({ weight: z.number().finite().min(0).max(100000) }) }),
]);
const ProvenanceSchema = z.object({
  source: z.enum(["user", "google", "llm", "legacy", "derived"]),
  confirmed: z.boolean().optional(),
  evidence: z.string().min(1).max(400).optional(),
});
const constraintOf = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, provenance: ProvenanceSchema, hardness: HardnessSchema });
const listConstraintOf = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    id: z.string().min(1).max(160),
    value,
    provenance: ProvenanceSchema,
    hardness: HardnessSchema,
  });

const DurationRangeSchema = z
  .object({ minMin: MinutesSchema, typicalMin: MinutesSchema, maxMin: MinutesSchema })
  .refine((d) => d.minMin <= d.typicalMin && d.typicalMin <= d.maxMin, {
    message: "duration range out of order",
  });
const WeeklyHoursSchema = z.object({
  byWeekday: z.array(z.array(WindowSchema).max(6)).length(7),
  lastEntryMin: MinutesSchema.optional(),
  closedDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(60).optional(),
});
const StopPatchSchema = z.object({
  window: constraintOf(WindowSchema).optional(),
  hours: constraintOf(WeeklyHoursSchema).optional(),
  duration: constraintOf(DurationRangeSchema).optional(),
  effort: constraintOf(z.enum(["low", "medium", "high"])).optional(),
  priority: constraintOf(z.enum(["must", "should", "could"])).optional(),
  pinnedDay: constraintOf(z.object({ index: z.number().int().min(0).max(365) })).optional(),
});
const DayPatchSchema = z.object({
  window: constraintOf(WindowSchema).optional(),
  mealBlocks: z.array(listConstraintOf(WindowSchema)).max(12).optional(),
  paceBudget: constraintOf(
    z.object({
      maxActiveMin: MinutesSchema.optional(),
      maxEffortPoints: z.number().finite().min(0).max(100).optional(),
    })
  ).optional(),
});
const TripPatchSchema = z.object({
  pacePreset: constraintOf(z.enum(["relaxed", "balanced", "packed"])).optional(),
  party: z
    .object({
      walkSpeedFactor: constraintOf(z.number().finite().min(0.25).max(4)).optional(),
      arrivalPins: z
        .array(
          listConstraintOf(
            z.object({
              personLabel: z.string().max(80),
              notBeforeMin: MinutesSchema,
              dayIndex: z.number().int().min(0).max(365).optional(),
            })
          )
        )
        .max(12)
        .optional(),
      quietBlocks: z.array(listConstraintOf(WindowSchema)).max(12).optional(),
    })
    .optional(),
});
const RelationSchema = listConstraintOf(
  z.union([
    z.object({ kind: z.literal("precedence"), beforeId: z.string().max(160), afterId: z.string().max(160) }),
    z.object({ kind: z.literal("sameDay"), aId: z.string().max(160), bId: z.string().max(160) }),
    z.object({ kind: z.literal("notSameDay"), aId: z.string().max(160), bId: z.string().max(160) }),
  ])
);
const ConstraintPatchSchema = z.object({
  version: z.literal(1).optional(),
  stops: z.record(z.string().max(200), StopPatchSchema).optional(),
  days: z.record(z.string().max(6), DayPatchSchema).optional(),
  trip: TripPatchSchema.optional(),
  relations: z.array(RelationSchema).max(60).optional(),
});

// ---------------------------------------------------------------------------
// The E7 safety rules, applied to one constraint
// ---------------------------------------------------------------------------

/** null = drop the constraint entirely (llm without evidence — the
 * hallucination tether). Otherwise returns the constraint with the
 * soft-until-confirmed clamp applied. */
function applyRules<C extends Constraint<unknown>>(c: C): C | null {
  if (c.provenance.source !== "llm") return c;
  const evidence = c.provenance.evidence;
  if (evidence === undefined || evidence.trim() === "") return null;
  if (c.provenance.confirmed === true) return c;
  if (c.hardness === "hard") {
    return { ...c, hardness: { soft: { weight: LLM_SOFT_WEIGHT } } };
  }
  return c;
}

function rulesOver<T>(list: readonly ListConstraint<T>[] | undefined): ListConstraint<T>[] | undefined {
  if (!list) return undefined;
  const kept = list
    .map((c) => applyRules(c))
    .filter((c): c is ListConstraint<T> => c !== null);
  return kept.length > 0 ? kept : undefined;
}

const prune = <T extends object>(o: T): T | undefined =>
  Object.values(o).some((v) => v !== undefined) ? o : undefined;

// ---------------------------------------------------------------------------
// sanitizeConstraintPatch
// ---------------------------------------------------------------------------

/** Structural + semantic validation of a stored/incoming patch against the
 * CURRENT doc. Returns the canonical patch (possibly `{}`), or null when the
 * shape itself is invalid (the PUT boundary 400s on null; a merely-stale patch
 * degrades by dropping the stale parts instead). */
export function sanitizeConstraintPatch(raw: unknown, doc: TripDoc): ConstraintPatch | null {
  const parsed = ConstraintPatchSchema.safeParse(raw);
  if (!parsed.success) return null;
  const patch = parsed.data as ConstraintPatch;

  const keyRows = stopKeys(doc);
  const knownKeys = new Set(keyRows.flat());
  // occurrence key -> the day its stop currently sits on (pinnedDay guard).
  const dayOfKey = new Map<string, number>();
  keyRows.forEach((row, dayIndex) => row.forEach((k) => dayOfKey.set(k, dayIndex)));

  let stops: Record<string, StopConstraintsPatch> | undefined;
  if (patch.stops) {
    const out: Record<string, StopConstraintsPatch> = {};
    for (const [key, sp] of Object.entries(patch.stops)) {
      if (!knownKeys.has(key)) continue; // stale reference — degrade, don't corrupt
      // NEVER assign an explicit `undefined` (audit finding 5: an own-property
      // undefined survives pruning and crashes canonicalJson at the hash).
      const cleaned: StopConstraintsPatch = {};
      const w = sp.window ? applyRules(sp.window) : null;
      if (w) cleaned.window = w;
      const h = sp.hours ? applyRules(sp.hours) : null;
      if (h) cleaned.hours = h;
      const du = sp.duration ? applyRules(sp.duration) : null;
      if (du) cleaned.duration = du;
      const ef = sp.effort ? applyRules(sp.effort) : null;
      if (ef) cleaned.effort = ef;
      const pr = sp.priority ? applyRules(sp.priority) : null;
      if (pr) cleaned.priority = pr;
      if (sp.pinnedDay) {
        const pd = applyRules(sp.pinnedDay);
        // Audit finding 3: an llm pin whose index differs from the day the
        // stop actually sits on would out-rank the legacy hard pin, break
        // launch mode (floor off, day assignment live) and let a scoped
        // solve lose the stop entirely. While launch mode is the shipped
        // reality, an llm pin is kept ONLY as a matching, chip-visible
        // statement; cross-day pinned intent is a moveDay flow, not a pin
        // fight. Non-llm pins (none are produced today) keep the range check
        // only.
        const matchesDocDay =
          pd?.provenance.source === "llm" ? pd.value.index === dayOfKey.get(key) : true;
        if (pd && pd.value.index < doc.days.length && matchesDocDay) cleaned.pinnedDay = pd;
      }
      if (prune(cleaned)) out[key] = cleaned;
    }
    if (Object.keys(out).length > 0) stops = out;
  }

  let days: Record<number, DayConstraintsPatch> | undefined;
  if (patch.days) {
    const out: Record<number, DayConstraintsPatch> = {};
    for (const [k, dp] of Object.entries(patch.days)) {
      const idx = Number.parseInt(k, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= doc.days.length) continue;
      const cleaned: DayConstraintsPatch = {};
      const w = dp.window ? applyRules(dp.window) : null;
      if (w) cleaned.window = w;
      const pb = dp.paceBudget ? applyRules(dp.paceBudget) : null;
      if (pb) cleaned.paceBudget = pb;
      const mb = rulesOver(dp.mealBlocks);
      if (mb) cleaned.mealBlocks = mb;
      if (prune(cleaned)) out[idx] = cleaned;
    }
    if (Object.keys(out).length > 0) days = out;
  }

  let trip: ConstraintPatch["trip"];
  if (patch.trip) {
    const pace = patch.trip.pacePreset ? applyRules(patch.trip.pacePreset) : null;
    let party: PartyConstraintsPatch | undefined;
    if (patch.trip.party) {
      const cleaned: PartyConstraintsPatch = {};
      const wsf = patch.trip.party.walkSpeedFactor
        ? applyRules(patch.trip.party.walkSpeedFactor)
        : null;
      if (wsf) cleaned.walkSpeedFactor = wsf;
      const pins = rulesOver(patch.trip.party.arrivalPins);
      if (pins) {
        const kept = pins.filter(
          (p) => p.value.dayIndex === undefined || p.value.dayIndex < doc.days.length
        );
        if (kept.length > 0) cleaned.arrivalPins = kept; // no [] husks (finding 11)
      }
      const qb = rulesOver(patch.trip.party.quietBlocks);
      if (qb) cleaned.quietBlocks = qb;
      party = prune(cleaned);
    }
    const built = { ...(pace ? { pacePreset: pace } : {}), ...(party ? { party } : {}) };
    if (Object.keys(built).length > 0) trip = built;
  }

  let relations: Relation[] | undefined;
  if (patch.relations) {
    const kept = (rulesOver(patch.relations) ?? []).filter((rel) => {
      const s = rel.value;
      const [a, b] = s.kind === "precedence" ? [s.beforeId, s.afterId] : [s.aId, s.bId];
      return knownKeys.has(a) && knownKeys.has(b) && a !== b;
    });
    if (kept.length > 0) relations = kept;
  }

  return {
    ...(stops ? { stops } : {}),
    ...(days ? { days } : {}),
    ...(trip ? { trip } : {}),
    ...(relations ? { relations } : {}),
  };
}

// ---------------------------------------------------------------------------
// mergeStoredPatches — a NEW patch landing on the STORED one
// ---------------------------------------------------------------------------

function mergeLists<T>(
  prev: readonly ListConstraint<T>[] | undefined,
  next: readonly ListConstraint<T>[] | undefined
): ListConstraint<T>[] | undefined {
  if (!prev) return next ? [...next] : undefined;
  if (!next) return [...prev];
  const byId = new Map<string, ListConstraint<T>>();
  for (const c of prev) byId.set(c.id, c);
  for (const c of next) {
    const w = winner(byId.get(c.id), c);
    if (w) byId.set(c.id, w);
  }
  return [...byId.values()];
}

/** Slot-wise winner() merge of two PATCHES (not a set): what "compile again"
 * or "apply this chip edit" does to the stored patch. Same precedence rule as
 * the solve-time merge, so what you store is what you'd have won anyway. */
export function mergeStoredPatches(prev: ConstraintPatch, next: ConstraintPatch): ConstraintPatch {
  const stops: Record<string, StopConstraintsPatch> = { ...(prev.stops ?? {}) };
  for (const [key, np] of Object.entries(next.stops ?? {})) {
    const pp = stops[key] ?? {};
    stops[key] = {
      ...(winner(pp.window, np.window) ? { window: winner(pp.window, np.window) } : {}),
      ...(winner(pp.hours, np.hours) ? { hours: winner(pp.hours, np.hours) } : {}),
      ...(winner(pp.duration, np.duration) ? { duration: winner(pp.duration, np.duration) } : {}),
      ...(winner(pp.effort, np.effort) ? { effort: winner(pp.effort, np.effort) } : {}),
      ...(winner(pp.priority, np.priority) ? { priority: winner(pp.priority, np.priority) } : {}),
      ...(winner(pp.pinnedDay, np.pinnedDay) ? { pinnedDay: winner(pp.pinnedDay, np.pinnedDay) } : {}),
    };
  }

  const days: Record<number, DayConstraintsPatch> = { ...(prev.days ?? {}) };
  for (const [k, np] of Object.entries(next.days ?? {})) {
    const idx = Number.parseInt(k, 10);
    const pp = days[idx] ?? {};
    days[idx] = {
      ...(winner(pp.window, np.window) ? { window: winner(pp.window, np.window) } : {}),
      ...(winner(pp.paceBudget, np.paceBudget) ? { paceBudget: winner(pp.paceBudget, np.paceBudget) } : {}),
      ...(mergeLists(pp.mealBlocks, np.mealBlocks) ? { mealBlocks: mergeLists(pp.mealBlocks, np.mealBlocks) } : {}),
    };
  }

  const pace = winner(prev.trip?.pacePreset, next.trip?.pacePreset);
  const party: PartyConstraintsPatch = {
    ...(winner(prev.trip?.party?.walkSpeedFactor, next.trip?.party?.walkSpeedFactor)
      ? { walkSpeedFactor: winner(prev.trip?.party?.walkSpeedFactor, next.trip?.party?.walkSpeedFactor) }
      : {}),
    ...(mergeLists(prev.trip?.party?.arrivalPins, next.trip?.party?.arrivalPins)
      ? { arrivalPins: mergeLists(prev.trip?.party?.arrivalPins, next.trip?.party?.arrivalPins) }
      : {}),
    ...(mergeLists(prev.trip?.party?.quietBlocks, next.trip?.party?.quietBlocks)
      ? { quietBlocks: mergeLists(prev.trip?.party?.quietBlocks, next.trip?.party?.quietBlocks) }
      : {}),
  };
  const trip = {
    ...(pace ? { pacePreset: pace } : {}),
    ...(prune(party) ? { party } : {}),
  };

  const relations = mergeLists(prev.relations, next.relations);

  return {
    ...(Object.keys(stops).length > 0 ? { stops } : {}),
    ...(Object.keys(days).length > 0 ? { days } : {}),
    ...(Object.keys(trip).length > 0 ? { trip } : {}),
    ...(relations && relations.length > 0 ? { relations } : {}),
  };
}

// ---------------------------------------------------------------------------
// Chip edits — confirm / delete, shared by the UI mutations and their tests
// ---------------------------------------------------------------------------

export type ChipTarget =
  | { scope: "stop"; key: string; slot: keyof StopConstraintsPatch }
  | { scope: "trip"; slot: "pacePreset" }
  | { scope: "quietBlock"; id: string };

/** Confirm promotes an LLM inference to a binding fact: confirmed: true (rank
 * 80 — above Google) and hardness "hard" ("the human is overruling the world
 * on purpose"). Non-llm constraints are returned unchanged — there is nothing
 * to confirm about a user's own statement. */
export function confirmConstraint(patch: ConstraintPatch, target: ChipTarget): ConstraintPatch {
  const promote = <C extends Constraint<unknown>>(c: C | undefined): C | undefined => {
    if (!c || c.provenance.source !== "llm") return c;
    return { ...c, provenance: { ...c.provenance, confirmed: true }, hardness: "hard" as const };
  };
  if (target.scope === "trip") {
    const pace = promote(patch.trip?.pacePreset);
    if (!pace) return patch;
    return { ...patch, trip: { ...(patch.trip ?? {}), pacePreset: pace } };
  }
  if (target.scope === "quietBlock") {
    const blocks = patch.trip?.party?.quietBlocks;
    if (!blocks) return patch;
    return {
      ...patch,
      trip: {
        ...(patch.trip ?? {}),
        party: {
          ...(patch.trip?.party ?? {}),
          quietBlocks: blocks.map((b) => (b.id === target.id ? (promote(b) ?? b) : b)),
        },
      },
    };
  }
  const sp = patch.stops?.[target.key];
  const c = promote(sp?.[target.slot]);
  if (!sp || !c) return patch;
  return {
    ...patch,
    stops: { ...(patch.stops ?? {}), [target.key]: { ...sp, [target.slot]: c } },
  };
}

/** Delete removes the constraint from the STORED patch entirely (E2's "no
 * tombstones" rule: removal is auditable as absence) and prunes empty
 * containers so the canonical form stays canonical. */
export function removeConstraint(patch: ConstraintPatch, target: ChipTarget): ConstraintPatch {
  if (target.scope === "trip") {
    if (!patch.trip?.pacePreset) return patch;
    const { pacePreset: _dropped, ...restTrip } = patch.trip;
    const trip = prune(restTrip as Record<string, unknown>) ? restTrip : undefined;
    const { trip: _t, ...rest } = patch;
    return { ...rest, ...(trip ? { trip } : {}) };
  }
  if (target.scope === "quietBlock") {
    const blocks = patch.trip?.party?.quietBlocks;
    if (!blocks) return patch;
    const kept = blocks.filter((b) => b.id !== target.id);
    const party = {
      ...(patch.trip?.party ?? {}),
      ...(kept.length > 0 ? { quietBlocks: kept } : {}),
    };
    if (kept.length === 0) delete (party as { quietBlocks?: unknown }).quietBlocks;
    const trip = {
      ...(patch.trip ?? {}),
      ...(prune(party as Record<string, unknown>) ? { party } : {}),
    };
    if (!prune(party as Record<string, unknown>)) delete (trip as { party?: unknown }).party;
    const { trip: _t, ...rest } = patch;
    return { ...rest, ...(prune(trip as Record<string, unknown>) ? { trip } : {}) };
  }
  const sp = patch.stops?.[target.key];
  if (!sp || !sp[target.slot]) return patch;
  const { [target.slot]: _dropped, ...restSlots } = sp;
  const stops = { ...(patch.stops ?? {}) };
  if (prune(restSlots as Record<string, unknown>)) stops[target.key] = restSlots;
  else delete stops[target.key];
  const { stops: _s, ...rest } = patch;
  return { ...rest, ...(Object.keys(stops).length > 0 ? { stops } : {}) };
}

// ---------------------------------------------------------------------------
// constraintSetForSolve — the one entry point solve paths use
// ---------------------------------------------------------------------------

/** compileFromDoc + the stored patch. The stored patch is keyed by the FULL
 * doc's occurrence keys; a day-scoped solve compiles from an `engineDoc`
 * whose emptied days SHIFT those keys for cross-day repeat visits (the E7
 * audit's finding 6: day-2's `id@d2` becomes bare `id`, so day-0's
 * constraints would land on day-2's visit — a retarget, not a degrade).
 * `fullDoc` (the un-emptied doc, when the caller solves a projection) drives
 * a positional key REMAP: fullKey -> engineKey per surviving occurrence, so
 * every constraint follows its own visit and constraints of emptied-away
 * occurrences drop. No stored patch = compileFromDoc verbatim. */
export function constraintSetForSolve(engineDoc: TripDoc, fullDoc: TripDoc = engineDoc): ConstraintSet {
  const base = compileFromDoc(engineDoc);
  const stored = fullDoc.constraints;
  if (!stored) return base;

  let patch = stored;
  if (fullDoc !== engineDoc) {
    const fullKeys = stopKeys(fullDoc);
    const engineKeys = stopKeys(engineDoc);
    const keyMap = new Map<string, string>();
    fullDoc.days.forEach((day, i) => {
      day.stops.forEach((stop, j) => {
        // Positional identity: engineDoc empties days but never reorders the
        // survivors, so (i, j) pairs align wherever the day survived.
        if (engineDoc.days[i]?.stops[j]?.id === stop.id) {
          keyMap.set(fullKeys[i][j], engineKeys[i][j]);
        }
      });
    });
    const remappedStops: Record<string, StopConstraintsPatch> = {};
    for (const [key, sp] of Object.entries(stored.stops ?? {})) {
      const mapped = keyMap.get(key);
      if (mapped) remappedStops[mapped] = sp;
    }
    const remappedRelations = (stored.relations ?? []).flatMap((rel) => {
      const s = rel.value;
      const [a, b] = s.kind === "precedence" ? [s.beforeId, s.afterId] : [s.aId, s.bId];
      const ma = keyMap.get(a);
      const mb = keyMap.get(b);
      if (!ma || !mb) return [];
      const spec =
        s.kind === "precedence"
          ? { kind: s.kind, beforeId: ma, afterId: mb }
          : { kind: s.kind, aId: ma, bId: mb };
      return [{ ...rel, value: spec } as Relation];
    });
    patch = {
      ...stored,
      ...(Object.keys(remappedStops).length > 0 ? { stops: remappedStops } : { stops: undefined }),
      ...(remappedRelations.length > 0 ? { relations: remappedRelations } : { relations: undefined }),
    };
    // strip the undefineds the spread trick above can leave
    if (patch.stops === undefined) {
      const { stops: _s, ...rest } = patch;
      patch = rest;
    }
    if (patch.relations === undefined) {
      const { relations: _r, ...rest } = patch;
      patch = rest;
    }
  }

  const sane = sanitizeConstraintPatch(patch, engineDoc);
  if (!sane) return base;
  return mergePatches(base, sane);
}
