// E5a — the SolverEngine PORT plus the engine's own problem/solution vocabulary.
//
// This file is the seam the roadmap promised: everything upstream of the engine
// (planService, the pipeline, the SSE theatre — all E5b) speaks `EngineProblem`
// in and `EngineSolution` out, and nothing downstream of it (the map renderer,
// ShareTimeline, JournalSidebar, the legOverrides re-timing layer) notices which
// engine produced the `DayPlan[]` inside. `DayPlan` is imported, never
// redefined: it is the wire shape, unchanged since §1.
//
// ---------------------------------------------------------------------------
// WHY THE PROBLEM IS A SEPARATE TYPE FROM ConstraintSet
// ---------------------------------------------------------------------------
// A ConstraintSet is what someone ASSERTED about a trip. An EngineProblem is
// what a solver can actually consume: day-concrete (WeeklyHours already
// intersected with each day's weekday), travel-concrete (effective minutes
// already decided by the AUTO matrix — §2 decide-then-offer happens BEFORE the
// engine, never inside it), and index-concrete (dense integer node ids for the
// hot loop). `buildProblem` (./problem) is the only bridge, and it is pure.
//
// Every constraint that survives into the problem carries the `ConstraintRef`
// that produced it — a path into the ConstraintSet plus its provenance — so a
// conflict can say WHOSE constraint it broke without the engine ever holding a
// reference to the set itself.
//
// ---------------------------------------------------------------------------
// KEYING (the audit MAJOR that must never come back)
// ---------------------------------------------------------------------------
// Node identity is the OCCURRENCE KEY from `stopKeys(doc)` (constraints/compile),
// the same function that keys `ConstraintSet.stops`. A cross-day repeat visit
// ("Cathedral on day 1 and again on day 3") carries `id@dN` on its later
// occurrences. `EngineNode.stopId` is the bare TripStop id underneath, and it —
// not the key — is what the travel matrix and `DayPlan.entries[].stopId` use,
// because both of those are per-day and cannot collide.

import type {
  DurationRange,
  Effort,
  Minutes,
  PacePreset,
  Priority,
  Provenance,
  Window,
} from "../constraints/types";
import type { LatLng, Settings } from "../maps/types";
import type { DayPlan } from "../schedule/types";
import type { EffectiveLeg } from "../solver/types";

// ---------------------------------------------------------------------------
// Constraint provenance carried into the problem
// ---------------------------------------------------------------------------

/** Where a constraint came from, addressable. `path` is a dotted path into the
 * ConstraintSet (`stops.fx-10@d2.window`, `days.1.window`, `trip.pacePreset`,
 * `relations.precedence:a>b`) — E6 renders it, E7 patches it. */
export type ConstraintRef = { path: string; provenance: Provenance };

/** A constraint value the engine can act on: what it says, whether breaking it
 * is infeasible or merely priced, and where it came from.
 *
 * `weight` is the soft price in the objective's currency (≈ one minute of
 * travel) and is 0 for a hard constraint — a hard constraint is never traded,
 * so it has no price (mirrors `softWeight` in constraints/types). */
export type Enforced<T> = {
  readonly value: T;
  readonly hard: boolean;
  readonly weight: number;
  readonly ref: ConstraintRef;
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** Day-concrete opening hours: index i = trip day i.
 *  - `null`  — this stop's hours say nothing about that day (no hours at all,
 *              or a dayLabel/unparseable day that HAS no weekday, in which case
 *              hours stay advisory-only, which is E3's job and not the
 *              engine's).
 *  - `[]`    — closed all day.
 *  - windows — the open intervals. A visit must fit ENTIRELY inside ONE of them
 *              (spike learning 2), and `lastEntryMin` independently caps the
 *              START. */
export type DayConcreteHours = {
  readonly openByDay: readonly (readonly Window[] | null)[];
  readonly lastEntryMin?: Minutes;
};

export type EngineNode = {
  /** Occurrence key — `stopKeys(doc)`. THE identity everywhere in the engine. */
  readonly key: string;
  /** Bare TripStop id: the travel-matrix key and the `DayPlan` entry id. */
  readonly stopId: string;
  readonly name: string;
  /** Used ONLY for Shaw relatedness in the destroy operator. Travel TIMES always
   * come from the effective matrix — never from these coordinates. */
  readonly location: LatLng;
  readonly duration: Enforced<DurationRange>;
  readonly effort: Enforced<Effort>;
  readonly effortPoints: number;
  readonly priority: Enforced<Priority>;
  /** Objective price of leaving this stop out (spike calibration: should 200,
   * could 60). A `must` stop is never traded away for a price — see
   * DROP_PENALTY_MUST in ./search — but it still needs a finite number so two
   * bad answers can be ranked. */
  readonly dropPenalty: number;
  /** Visit-START window. A legacy anchor is the degenerate [t, t]. */
  readonly window?: Enforced<Window>;
  /** True for a hard degenerate [t, t] window — i.e. a booked time. Drives
   * `PlanEntry.kind: "anchor"`, preserving the old kind semantics exactly. */
  readonly isAnchor: boolean;
  readonly hours?: Enforced<DayConcreteHours>;
  /** Which day. Present and hard = launch mode (the paste decides days).
   * Absent or soft = the engine may assign; the multi-day machinery in ./search
   * is alive for exactly that day, and the hybrid exhaustive floor switches
   * itself off the moment any pin stops being hard. */
  readonly pinnedDay?: Enforced<number>;
};

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** Resolved per-day pace budget. `maxActiveMin` is the day SPAN (last departure
 * − first arrival), NOT the sum of visit durations (spike learning 3). */
export type PaceBudget = {
  readonly maxActiveMin: Minutes;
  readonly maxEffortPoints: number;
  /** Breathing room ON TOP of travel between consecutive visits. Applied to the
   * schedule only when the pace constraint is HARD — a derived "balanced"
   * default is a preference we invented, and forcing 10-minute gaps into every
   * plan on the strength of it would silently repace every existing trip. When
   * soft, the span overrun is priced instead (see ./evaluate). */
  readonly minGapMin: Minutes;
};

export type EngineDay = {
  readonly index: number;
  readonly date: string;
  readonly dayLabel?: string;
  /** ISO weekday, 0 = Monday .. 6 = Sunday, or null when the day has no real
   * calendar date (M1.5 `dayLabel` placeholder, or an unparseable date). A null
   * weekday means NO hours constraints on that day — see DayConcreteHours. */
  readonly weekday: number | null;
  readonly window: Enforced<Window>;
  /** Blocks in which no visit may START, half-open [startMin, endMin) — day
   * meal blocks plus the trip's quiet blocks, already merged. */
  readonly blocks: readonly Enforced<Window>[];
  readonly pace: Enforced<PaceBudget>;
  /** Node keys pinned to this day, in the doc's list order. Ordering input for
   * the exhaustive floor (which reproduces the old solver's anchor-segmenting)
   * and nothing else — the ALNS reorders freely. */
  readonly nodeKeys: readonly string[];
};

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export type EngineRelation = {
  readonly id: string;
  readonly kind: "precedence" | "sameDay" | "notSameDay";
  /** `precedence`: a must precede b. Symmetric kinds: canonicalised endpoints. */
  readonly aKey: string;
  readonly bKey: string;
  readonly hard: boolean;
  readonly weight: number;
  readonly ref: ConstraintRef;
};

// ---------------------------------------------------------------------------
// Travel
// ---------------------------------------------------------------------------

/** The travel model, flattened for the hot loop. §2 is LOCKED and happens
 * upstream: the engine consumes the AUTO effective matrix and never decides a
 * mode itself, so `minutesByDay` is already `walk ? walkMin : driveMin +
 * driveOverheadMin` for whichever mode the matrix chose. Asymmetry is allowed
 * (real drive matrices are asymmetric); nothing here assumes a metric.
 *
 * Indexing is `from * n + to` over the dense node index below. */
export type EngineTravel = {
  readonly n: number;
  /** node key -> dense index. */
  readonly index: Readonly<Record<string, number>>;
  readonly minutesByDay: readonly Float64Array[];
  /** The leg behind each pair, for DayPlan assembly, or null when this pair was
   * not in that day's matrix. A null leg means `minutesByDay` holds a
   * STRAIGHT-LINE ESTIMATE, which happens only for cross-day pairs (stop X of
   * day 1 next to stop Y of day 2) and is therefore only ever read while
   * costing a `moveDay` PROPOSAL — never while assembling a returned plan.
   * Launch mode's hard pins mean no emitted plan can contain such a leg, and
   * ./assemble throws rather than inventing one if that ever changes. */
  readonly legsByDay: readonly (readonly (EffectiveLeg | null)[])[];
};

/** E6d — the trip's home base (TripDoc.homeBase) as depot travel: every day
 * starts with a lead-out from the base to its first stop and ends with the
 * return from its last, both priced in the objective and both bounded by the
 * day window. NOT a node: the base is never visited, dropped, ordered or
 * pinned — it exists purely as per-day travel rows, index-aligned with
 * `travel.index`. `null` legs mean the minutes are straight-line estimates
 * (same contract as EngineTravel.legsByDay — only reachable while costing a
 * cross-day moveDay proposal, never in an emitted plan). */
export type EngineBase = {
  readonly name: string;
  readonly location: LatLng;
  /** minutes base -> node, one Float64Array(n) per day. */
  readonly outByDay: readonly Float64Array[];
  /** minutes node -> base, one Float64Array(n) per day. */
  readonly backByDay: readonly Float64Array[];
  readonly outLegsByDay: readonly (readonly (EffectiveLeg | null)[])[];
  readonly backLegsByDay: readonly (readonly (EffectiveLeg | null)[])[];
};

// ---------------------------------------------------------------------------
// The problem
// ---------------------------------------------------------------------------

export type EngineProblem = {
  readonly version: 1;
  readonly tripId: string;
  readonly nodes: readonly EngineNode[];
  readonly days: readonly EngineDay[];
  readonly relations: readonly EngineRelation[];
  readonly travel: EngineTravel;
  /** E6d — present iff the doc has a homeBase. Absent = byte-identical
   * pre-depot behaviour everywhere (the harnesses pin this). */
  readonly base?: EngineBase;
  readonly pacePreset: Enforced<PacePreset>;
  /** The travel-model params (walkMax, driveOverheadMin, maxExhaustive…). The
   * engine reads only `maxExhaustive` (the floor's width) from these; the
   * mode decisions baked into `travel` were made with the same settings. */
  readonly settings: Settings;
};

// ---------------------------------------------------------------------------
// Solution
// ---------------------------------------------------------------------------

/** An interior schedule: what the search produces, what ./evaluate scores, and
 * what ./assemble turns into DayPlans. Every node of the problem appears in
 * exactly one of `visits` / `dropped` — nothing is ever silently cut. */
export type EngineVisit = {
  readonly key: string;
  readonly dayIndex: number;
  /** Structural: previous departure + travel. NEVER backdated to `startMin`
   * (spike learning 1 — a solver that reports arrive == start would zero its
   * own wait penalty on a technicality). */
  readonly arriveMin: Minutes;
  readonly startMin: Minutes;
  readonly departMin: Minutes;
};

export type EngineSchedule = {
  readonly visits: readonly EngineVisit[];
  readonly dropped: readonly string[];
};

/** One relaxation the engine took in order to return a plan at all. The plan
 * still contains the engine's best attempt at the offending stop (marked) —
 * "never a silent cut" is the whole point.
 *
 * `stopIds` carries OCCURRENCE KEYS (the engine's node identity), matching
 * `constraintRef.path`. `violatedByMin` is the size of the breach in minutes;
 * it is 0 for breaches that have no natural minute measure (a closed weekday, a
 * violated precedence pair), which is exactly what the old solver did for
 * `precedence:` infeasibilities. */
export type Conflict = {
  readonly id: string;
  readonly code: string;
  readonly stopIds: readonly string[];
  readonly dayIndex?: number;
  readonly violatedByMin: number;
  readonly constraintRef: ConstraintRef;
  /** Journal-voice one-liner. Decorative; the structured fields are the API. */
  readonly message: string;
  /** `hours` conflicts only: the stop has NO open interval at all on this day
   * (closed weekday or closedDates hit), as opposed to a schedulable-but-missed
   * window. The machine-readable form of "no amount of shuffling fixes it" —
   * planEngine's closed-day auto-relocation keys on this, never on message
   * text. */
  readonly closedDay?: boolean;
};

// (Proposal lives further down; see its `imperfect` field for the E7.2
// rough-fix tier.)

/** A minimal, typed description of a change an E6 UI can apply.
 *
 * Two appliers, on purpose (./patch): doc-level ops rewrite the TripDoc,
 * constraint-level ops rewrite the compiled ConstraintSet. Today's TripDoc has
 * nowhere to persist a pace preset, and inventing a field for it here would be
 * a schema change E5a has no mandate for; `applyConstraintPatch` keeps the loop
 * closeable (patch → recompile → re-solve) without one. */
export type DocPatch =
  /** dropStop. */
  | { readonly op: "removeStop"; readonly dayIndex: number; readonly stopId: string }
  /** shiftWindow, on a booked time. `startMin: null` un-books the stop. */
  | {
      readonly op: "setAnchor";
      readonly dayIndex: number;
      readonly stopId: string;
      readonly startMin: number | null;
    }
  /** shiftWindow, on the day's own bounds. */
  | {
      readonly op: "setDayWindow";
      readonly dayIndex: number;
      readonly startMin?: number;
      readonly endMin?: number;
    }
  /** moveDay. Launch mode EMITS this and never applies it (hard pins are the
   * paste's decision); E6 gates acceptance behind `suggest.crossDate`. */
  | {
      readonly op: "moveStop";
      readonly fromDayIndex: number;
      readonly toDayIndex: number;
      readonly stopId: string;
    }
  /** trimDuration. */
  | {
      readonly op: "setDuration";
      readonly dayIndex: number;
      readonly stopId: string;
      readonly durationMin: number;
    }
  /** relaxPace. Constraint-level: see the note above. */
  | { readonly op: "setPacePreset"; readonly preset: PacePreset };

export type ProposalKind =
  | "dropStop"
  | "shiftWindow"
  | "moveDay"
  | "relaxPace"
  | "trimDuration";

/** A priced trade-off. `costDeltaMin` is the objective change measured by
 * actually test-applying the patch and re-evaluating ONCE (bounded: no search),
 * in the objective's currency (≈ minutes of travel). Negative = better. */
export type Proposal = {
  readonly id: string;
  readonly kind: ProposalKind;
  readonly patch: DocPatch;
  readonly resolves: readonly string[];
  readonly costDeltaMin: number;
  readonly message: string;
  /** E7.2 — a ROUGH FIX: it resolves its conflict but introduces a smaller
   * breach elsewhere (the clean-fix filter found nothing better). Surfaced
   * so "Skip it" is never a conflict's only card; the UI labels it and the
   * price is honest. */
  readonly imperfect?: boolean;
};

export type ObjectiveBreakdown = {
  readonly travelMin: number;
  readonly waitMin: number;
  readonly dropPenalty: number;
  readonly compressionPenalty: number;
  /** Total priced soft-constraint penalty (soft windows/hours/relations/pace). */
  readonly softViolations: number;
};

export type EngineSolution = {
  /** One per problem day, same `DayPlan` union as ../schedule/types. */
  readonly days: DayPlan[];
  /** Occurrence key -> day index. `-1` = the engine could not place it at all
   * (always accompanied by a conflict). */
  readonly assignment: Record<string, number>;
  readonly objectiveBreakdown: ObjectiveBreakdown;
  readonly conflicts: Conflict[];
  readonly proposals: Proposal[];
  /** ITEMISED soft violations the returned plan pays for (soft windows/
   * relations/pace the engine chose to break at their weight). The old engine
   * surfaced its one soft case — cross-day precedence — as a margin note; E6
   * renders these as visible trades. Summed in
   * objectiveBreakdown.softViolations (E5a audit, finding 4). */
  readonly softViolations: Array<{
    code: string;
    detail: string;
    stopIds: string[];
    dayIndex?: number;
    weight: number;
  }>;
};

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export type SolveOptions = {
  seed: number;
  timeBudgetMs: number;
  /** DETERMINISTIC stop condition, overriding the size/budget-derived cap (see
   * ITER_CAP in ./search). Set it and the answer no longer depends on machine
   * speed at all — which is why the determinism tests set it, and why E5b may
   * set it for a "same plan on every replica" guarantee. */
  iterCap?: number;
  /** HARD wall-clock safety net that applies EVEN WITH iterCap set (E5b audit,
   * F2: iterCap + finite budget left nothing actually bounding solve time — a
   * 26s solve was measured over a "20s budget"). When it fires, the anytime
   * best-so-far is returned and byte-determinism is sacrificed for that one
   * solve — the right trade for a serverless function that must finish. Sized
   * by the caller well above the expected solve time (net, not budget). */
  hardStopMs?: number;
  onProgress?: (p: { pct: number; bestScore: number; phase: string }) => void;
  /** Safety net only, exactly like the wall clock: aborting mid-search returns
   * the best-so-far (anytime), which is by definition no longer reproducible. */
  signal?: { readonly aborted: boolean };
};

/** The port. Returning `EngineSolution | Promise<EngineSolution>` is deliberate:
 * the in-process ALNS is synchronous (it is a CPU-bound loop on a single thread
 * — wrapping it in a Promise would buy nothing and would only hide that it
 * blocks), while the spike's losing contender survives behind this same port as
 * an HTTP adapter, which cannot be. Callers `await` and both fit. */
export interface SolverEngine {
  readonly name: string;
  readonly version: string;
  solve(problem: EngineProblem, opts: SolveOptions): EngineSolution | Promise<EngineSolution>;
}
