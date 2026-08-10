// E2 — the production constraint model. This is the vocabulary every later
// milestone speaks: E3 fills `hours`, E5's engine consumes a ConstraintSet,
// E6 renders conflicts back through `provenance`, E7's LLM emits a
// ConstraintPatch. Promoted from `spike/ir.ts` with what the E1 spike taught.
//
// Everything is minutes-from-midnight local time and 0-based day INDEXES,
// matching the repo's schedule-math convention (src/lib/schedule/). No Date
// objects — determinism is part of the contract. Pure types + tiny pure
// helpers: no I/O, no deps, importable from anywhere.
//
// ---------------------------------------------------------------------------
// THE ANTI-REMODEL INVARIANT (the reason this file exists at E2, not at E5)
// ---------------------------------------------------------------------------
// The model is MULTI-DAY-NATIVE from day one. Day assignment is a per-stop
// constraint (`StopConstraints.pinnedDay`), never part of a stop's identity
// and never implied by which array a stop sits in.
//
//   * Launch (single-day mode): compileFromDoc hard-pins EVERY stop to the day
//     it was pasted on — `pinnedDay: { hardness: "hard", value: { index: d } }`.
//     The paste decides days; the engine only orders and times.
//   * Later (engine assigns days): the very same field carries
//     `hardness: { soft: { weight } }`, or is absent entirely.
//
// THE SHAPE NEVER CHANGES. Relaxing day assignment is a VALUE change on an
// existing field — one line in compileFromDoc plus a flag — not a type change,
// not a doc migration, not a re-render of anything downstream. Nothing in this
// file may be defined in a way that makes "which day" structural again.
//
// ---------------------------------------------------------------------------
// WHAT THE SPIKE TAUGHT (semantics that consumers of these types MUST honour)
// ---------------------------------------------------------------------------
// These are properties of the *meaning* of the types below, enforced by the
// engine and its evaluator rather than by the compiler. They are recorded here
// because every one of them was learned the expensive way in E1:
//
//  1. WAIT/IDLE IS STRUCTURAL. Idle time between two visits is
//     `max(0, next.startMin - prev.departMin - travelMin)` — computed from
//     starts, departures and the travel model, NEVER from a solver's
//     self-reported arrival. (A solver that reports arrive == start would
//     otherwise zero its own wait penalty on a technicality.)
//  2. HOURS SEMANTICS. A visit satisfies `hours` iff [startMin, departMin]
//     fits ENTIRELY inside ONE open interval of that day's weekday — never
//     across two intervals of a split shift — AND `lastEntryMin`, when
//     present, caps the START (not the departure).
//  3. PACE `maxActiveMin` IS THE DAY SPAN: last departure − first arrival, not
//     the sum of visit durations. A day of three visits with four idle hours
//     between them is a long day, and the model says so.
//  4. MEAL/QUIET BLOCKS EXCLUDE STARTS. A block forbids a visit from STARTING
//     inside it, half-open [startMin, endMin). Travel may cross a block, and a
//     visit already in progress may run through it.
//  5. DURATION IS A RANGE {minMin, typicalMin, maxMin}. Scheduling shorter
//     than `typicalMin` is legal down to `minMin` and is PENALISED (the E1
//     objective charges `WEIGHT_COMPRESSION` per compressed minute), so the
//     engine trims a visit only when it buys something.

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Minutes = number;

/** A closed interval of local minutes-from-midnight. Applied to a visit it
 * constrains the visit's START (see StopConstraints.window); applied to a day
 * it bounds arrivals and departures; applied as a meal/quiet block it is read
 * half-open [startMin, endMin) and forbids STARTS (spike learning 4). */
export type Window = { startMin: Minutes; endMin: Minutes };

/** Per-weekday open intervals, 0 = Monday .. 6 = Sunday (ISO). An empty array
 * means closed that weekday. `lastEntryMin` caps the latest allowed START
 * ("last entry 16:30"). `closedDates` are ISO dates (YYYY-MM-DD) that override
 * `byWeekday` to closed — public holidays, annual maintenance closures; E3
 * fills it from Google's `specialDays`/`regularOpeningHours`. */
export type WeeklyHours = {
  byWeekday: ReadonlyArray<ReadonlyArray<Window>>; // length 7
  lastEntryMin?: Minutes;
  closedDates?: readonly string[];
};

/** Spike learning 5: not a scalar. `minMin <= typicalMin <= maxMin`; today's
 * docs carry a single number and compile to a degenerate range. */
export type DurationRange = { minMin: Minutes; typicalMin: Minutes; maxMin: Minutes };

export type Effort = "low" | "medium" | "high";
export type Priority = "must" | "should" | "could";
export type PacePreset = "relaxed" | "balanced" | "packed";

// ---------------------------------------------------------------------------
// The constraint envelope
// ---------------------------------------------------------------------------

/** Who asserted this.
 *  - `user`    — the human said so (typed it, confirmed it, edited it). Always wins.
 *  - `google`  — fetched fact about the world (opening hours, last entry).
 *  - `llm`     — inferred from prose. `confirmed: true` once a human accepted it,
 *                which is what promotes it above a Google fact (the human is
 *                overruling the world on purpose).
 *  - `legacy`  — a faithful reading of a pre-constraint TripDoc field
 *                (anchors, dayStartMin, precedence). Lowest rank: it is what we
 *                believed before anyone told us anything.
 *  - `derived` — a default WE invented because nobody said anything (effort
 *                "medium", pace "balanced"). Outranks `legacy` but loses to
 *                every real statement.
 * Closed on purpose: a new source must be ranked in PROVENANCE_RANK, and that
 * ranking is a product decision, not a type-level one. */
export type ProvenanceSource = "user" | "google" | "llm" | "legacy" | "derived";

export type Provenance = {
  source: ProvenanceSource;
  /** Only meaningful for `source: "llm"` (see PROVENANCE_RANK). E7 emits every
   * LLM constraint with `confirmed: false` — hard-vocabulary constraints enter
   * soft-until-confirmed and a human confirm promotes them. */
  confirmed?: boolean;
  /** E7's hallucination tether: the quoted span from the user's input that
   * justifies this constraint. An LLM constraint without one is DROPPED in
   * validation. Optional here because `user`/`google`/`legacy` sources have no
   * text to quote. */
  evidence?: string;
};

/** `hard` = inviolable; a solution that breaks it is infeasible, full stop.
 * `{ soft: { weight } }` = the engine may break it and pays `weight` penalty
 * units in the objective (same currency as the E1 objective, where one unit ≈
 * one minute of travel).
 *
 * For PARAMETER-valued constraints (duration, effort, pacePreset,
 * walkSpeedFactor) there is no violate-able predicate; read hardness as "may
 * the engine deviate from this value?" — `hard` means use it as given, soft
 * means deviation is allowed at that cost per unit of deviation. */
export type Hardness = "hard" | { soft: { weight: number } };

/** THE atom of the model. Everything asserted about a trip is a `Constraint<T>`:
 * a value plus who said it and how binding it is.
 *
 * Deliberately a WRAPPER, not an intersection (`T & {provenance, hardness}`):
 *  - payloads are often primitives (`Constraint<Effort>`) which cannot be
 *    intersected with an object;
 *  - it makes the constraint the ATOM OF MERGE — you cannot half-own an
 *    assertion, so `mergePatches` never has to invent the provenance of a
 *    partially-overwritten value;
 *  - generic helpers (isHard, softWeight, and the merge rule itself) work over
 *    any payload without conditional types. */
export type Constraint<T> = {
  readonly value: T;
  readonly provenance: Provenance;
  readonly hardness: Hardness;
};

/** A constraint that lives in a collection rather than a named slot. `id` is
 * its merge identity: patches address list members by id exactly the way they
 * address named slots by key. Ids are CANONICAL and derivable from the value
 * where possible (see `relationId`), so two sources asserting the same thing
 * collide and get resolved by precedence instead of silently duplicating. */
export type ListConstraint<T> = Constraint<T> & { readonly id: string };

export const isHard = <T>(c: Constraint<T>): boolean => c.hardness === "hard";

/** Penalty weight of a soft constraint; 0 for a hard one (a hard constraint is
 * never traded off, so it has no price). */
export const softWeight = <T>(c: Constraint<T>): number =>
  c.hardness === "hard" ? 0 : c.hardness.soft.weight;

// ---------------------------------------------------------------------------
// Merge precedence — the total order used by mergePatches
// ---------------------------------------------------------------------------

/** TOTAL precedence order over sources. Higher wins a slot collision.
 *
 *   user (100) > llm-confirmed (80) > google (60) > llm-unconfirmed (40)
 *              > derived (20) > legacy (0)
 *
 * Rationale for the two non-obvious placements:
 *  - `google` sits ABOVE unconfirmed LLM inference and BELOW confirmed: a
 *    fetched fact beats a guess, but a human who confirmed "they're holding
 *    the gallery open late for us" is deliberately overruling the world, and
 *    the model must let them.
 *  - `derived` sits ABOVE `legacy` so that a default we compute today (pace
 *    "balanced") replaces a pre-constraint-era reading rather than being
 *    silently pinned under it.
 *
 * Gaps of 20 are intentional: a future source slots between two existing ranks
 * without renumbering anything. `confirmed` is only rank-relevant for `llm` —
 * a user constraint is confirmed by construction and google/legacy/derived
 * have no one to confirm them. */
export const PROVENANCE_RANK = {
  user: 100,
  llmConfirmed: 80,
  google: 60,
  llmUnconfirmed: 40,
  derived: 20,
  legacy: 0,
} as const;

export function provenanceRank(p: Provenance): number {
  switch (p.source) {
    case "user":
      return PROVENANCE_RANK.user;
    case "llm":
      return p.confirmed ? PROVENANCE_RANK.llmConfirmed : PROVENANCE_RANK.llmUnconfirmed;
    case "google":
      return PROVENANCE_RANK.google;
    case "derived":
      return PROVENANCE_RANK.derived;
    case "legacy":
      return PROVENANCE_RANK.legacy;
  }
}

/** The merge rule, in one function — used for every slot and every list member,
 * so there is exactly one place where "who wins" is decided. `candidate` is
 * always the LATER assertion (base counts as earliest, then patches in argument
 * order), so equal rank resolves to the candidate: LAST WRITER OF EQUAL
 * PRECEDENCE WINS, while a higher-precedence assertion wins regardless of
 * position.
 *
 * Generic over anything carrying provenance so `Constraint<T>` and
 * `ListConstraint<T>` share the identical rule. */
export function winner<C extends { readonly provenance: Provenance }>(
  incumbent: C,
  candidate: C | undefined
): C;
export function winner<C extends { readonly provenance: Provenance }>(
  incumbent: C | undefined,
  candidate: C | undefined
): C | undefined;
export function winner<C extends { readonly provenance: Provenance }>(
  incumbent: C | undefined,
  candidate: C | undefined
): C | undefined {
  // `== null` (not `=== undefined`): wire-shaped patches (JSON.parse output)
  // can legally carry null, and a null candidate must read as "not asserted",
  // not crash provenanceRank (E2 audit, minor 2a). Same guard on a candidate
  // whose provenance is missing — a provenance-less assertion has no standing
  // in a precedence contest and is ignored (audit 2b).
  if (candidate == null || candidate.provenance == null) return incumbent ?? undefined;
  if (incumbent == null || incumbent.provenance == null) return candidate;
  return provenanceRank(candidate.provenance) >= provenanceRank(incumbent.provenance)
    ? candidate
    : incumbent;
}

// ---------------------------------------------------------------------------
// Stop-level constraints
// ---------------------------------------------------------------------------

/** Which day this stop lands on. See THE ANTI-REMODEL INVARIANT at the top of
 * this file: hardness lives on the enclosing Constraint, so the single-day →
 * multi-day switch is `hardness: "hard"` → `{ soft: { weight } }` and nothing
 * else moves. */
export type PinnedDay = { index: number };

/** `duration`, `effort` and `priority` are REQUIRED: every stop has all three
 * (compileFromDoc supplies defaults with honest provenance), so the engine
 * never has to invent them mid-solve. Everything else is optional and absent
 * means unconstrained.
 *
 * ADDING A CONSTRAINT KIND IS ADDITIVE: append a new optional slot here. No
 * existing producer, consumer, patch or persisted set breaks. */
export type StopConstraints = {
  /** Constrains the visit's START, not its arrival and not its departure. A
   * legacy anchor compiles to the degenerate window [t, t]. */
  window?: Constraint<Window>;
  /** Weekly opening hours; E3 fills these from Google. Semantics: spike
   * learning 2 (whole visit inside ONE interval; lastEntryMin caps the start). */
  hours?: Constraint<WeeklyHours>;
  duration: Constraint<DurationRange>;
  effort: Constraint<Effort>;
  /** `must` + hard = may never be dropped. `should`/`could` are the priorities
   * the engine may drop, at the soft weight carried here. */
  priority: Constraint<Priority>;
  pinnedDay?: Constraint<PinnedDay>;
};

// ---------------------------------------------------------------------------
// Day-level constraints
// ---------------------------------------------------------------------------

/** Per-day pace budget. Absent = the trip-level `pacePreset` supplies it. The
 * plan's "future-proofed for per-day knobs": this slot is that future-proofing,
 * populated by nothing today. `maxActiveMin` is the day SPAN (spike learning 3). */
export type PaceBudget = { maxActiveMin?: Minutes; maxEffortPoints?: number };

export type DayConstraints = {
  /** The day's own bounds: nothing arrives before startMin, nothing departs
   * after endMin. */
  window: Constraint<Window>;
  /** Blocks in which no visit may START (spike learning 4) — held lunch/dinner
   * reservations. Each block is individually provenanced so E6 can say WHOSE
   * constraint a conflict belongs to; merged by `id`. */
  mealBlocks?: readonly ListConstraint<Window>[];
  paceBudget?: Constraint<PaceBudget>;
};

// NOTE (deliberate omission, E3 owns it): DayConstraints carries no `date` or
// `weekday`, even though WeeklyHours must be intersected against a weekday to
// become day-concrete. M1.5 docs can carry an INERT placeholder date (see
// TripDay.dayLabel), so a `weekday` derived here would be a confident lie on
// exactly the trips where hours matter least. E3 decides how a label-only day
// resolves its weekday, and adds the field then — additively.

// ---------------------------------------------------------------------------
// Trip-level constraints
// ---------------------------------------------------------------------------

/** One person's "not before" — "Ana lands at 11:40, nothing before 12:30".
 * `dayIndex` absent = applies to every day (a standing "we don't do mornings"). */
export type ArrivalPin = { personLabel: string; notBeforeMin: Minutes; dayIndex?: number };

/** Party facts, expressed as trip-level constraints (split-groups stay M5).
 * A namespace grouping constraints, not itself a constraint — there is no
 * provenance for "having a party", only for each fact about it. */
export type PartyConstraints = {
  /** Multiplier on walking times: 1.0 = the model's default pace, >1 slower.
   * A hard one means "use exactly this"; soft means the engine may push. */
  walkSpeedFactor?: Constraint<number>;
  arrivalPins?: readonly ListConstraint<ArrivalPin>[];
  /** Trip-wide blocks in which no visit may START — naps, prayer, school runs.
   * Same half-open START semantics as day mealBlocks. */
  quietBlocks?: readonly ListConstraint<Window>[];
};

export type TripConstraints = {
  pacePreset: Constraint<PacePreset>;
  party?: PartyConstraints;
};

// ---------------------------------------------------------------------------
// Cross-stop relations
// ---------------------------------------------------------------------------

/** Adding a relation kind is additive for PRODUCERS; consumers get an
 * exhaustiveness error at every switch, which is the point — a new relation the
 * engine silently ignores would be worse than a compile failure. */
export type RelationSpec =
  | { kind: "precedence"; beforeId: string; afterId: string }
  | { kind: "sameDay"; aId: string; bId: string }
  | { kind: "notSameDay"; aId: string; bId: string };

export type Relation = ListConstraint<RelationSpec>;

/** Canonical, content-derived merge identity for a relation. Symmetric kinds
 * sort their endpoints so `sameDay(a,b)` and `sameDay(b,a)` are ONE constraint
 * and collide (then resolve by precedence) instead of duplicating. */
export function relationId(spec: RelationSpec): string {
  if (spec.kind === "precedence") return `precedence:${spec.beforeId}>${spec.afterId}`;
  const [x, y] = spec.aId <= spec.bId ? [spec.aId, spec.bId] : [spec.bId, spec.aId];
  return `${spec.kind}:${x}~${y}`;
}

/** Normalises a symmetric relation's endpoints so that value and id agree. */
export function canonicalRelationSpec(spec: RelationSpec): RelationSpec {
  if (spec.kind === "precedence") return spec;
  return spec.aId <= spec.bId ? spec : { kind: spec.kind, aId: spec.bId, bId: spec.aId };
}

// ---------------------------------------------------------------------------
// The aggregate
// ---------------------------------------------------------------------------

/** Everything the engine is told about one trip.
 *
 * `stops` is keyed by TripStop.id and is day-agnostic — the day a stop belongs
 * to is `stops[id].pinnedDay`, never the key and never the array it sits in.
 * `days` is positional: index i is trip day i. */
export type ConstraintSet = {
  /** Schema version. Bumped only on a breaking change to these types; every
   * planned extension is additive and leaves this at 1. */
  readonly version: 1;
  readonly stops: Readonly<Record<string, StopConstraints>>;
  readonly days: readonly DayConstraints[];
  readonly trip: TripConstraints;
  readonly relations: readonly Relation[];
};

// ---------------------------------------------------------------------------
// Patches (E7's wire shape)
// ---------------------------------------------------------------------------

export type StopConstraintsPatch = Partial<StopConstraints>;
export type DayConstraintsPatch = Partial<DayConstraints>;
export type PartyConstraintsPatch = Partial<PartyConstraints>;
export type TripConstraintsPatch = {
  pacePreset?: Constraint<PacePreset>;
  party?: PartyConstraintsPatch;
};

/** A partial ConstraintSet: what the E7 LLM compiler emits, what the E6
 * "accept this trade-off" flow applies, what a user's chip edit persists.
 *
 * Deep-partial DOWN TO THE CONSTRAINT, never inside one — the constraint is the
 * atom of merge, so a patch supplies whole `Constraint<T>` values (each with
 * its own provenance) or says nothing about that slot. There is no way to
 * express "change this window's endMin but keep its provenance", and that is
 * deliberate: a half-owned assertion has no honest provenance.
 *
 * MERGE RULES (see mergePatches in ./compile):
 *  1. Named slots merge by key, list slots by `ListConstraint.id`.
 *  2. Collisions resolve by PROVENANCE_RANK; ties go to the LATER patch
 *     (`base` is earliest, then patches in argument order). So patch ORDER
 *     matters only between equal-precedence assertions; a higher-precedence
 *     assertion wins from any position.
 *  3. A patch NEVER DELETES what it does not mention. Absent means "no
 *     opinion", not "remove".
 *  4. There is deliberately NO deletion/tombstone form in v1: E7's "delete this
 *     chip" removes the constraint from the stored patch and recompiles, which
 *     is auditable in a way an inline tombstone is not. If a true remove is ever
 *     needed it slots in additively as a `remove?: string[]` field of paths.
 *  5. Patches CANNOT CREATE stops or days — the doc owns those. References to
 *     unknown stop ids or out-of-range day indexes are ignored, so a stale
 *     patch degrades instead of corrupting.
 *
 * `days` is keyed by day INDEX so a patch that touches only day 2 need not
 * carry a sparse array. (JSON round-trips those keys as strings; numeric
 * indexing still reads them, and mergePatches parses defensively.) */
export type ConstraintPatch = {
  readonly version?: 1;
  readonly stops?: Readonly<Record<string, StopConstraintsPatch>>;
  readonly days?: Readonly<Record<number, DayConstraintsPatch>>;
  readonly trip?: TripConstraintsPatch;
  readonly relations?: readonly Relation[];
};
