// E5b — wires the E5a engine (src/lib/engine/, audited, port-only from here on)
// into the live plan path. This is the ONE module that calls `alnsEngine.solve`
// in production — planStore.savePlanned (via `planTripWithEngine`) and
// pipeline.ts's first solve (via `solveWithPreparedMatrices`, so it can
// interleave real per-day matrix progress with the engine's own progress —
// see that file's header) are its only two callers. Server-only (pulls in
// getMapsProvider via ./config, same as planService.ts).
//
// Three classes of day, decided BEFORE the engine ever sees them:
//   1. matrix-incomplete  — a same-day pair the provider/matrix couldn't cover.
//      MUST-DO 4 (E5a audit handoff): "a missing pair = legible rejected day,
//      not a throw" — assembleDay (src/lib/engine/assemble.ts) THROWS on a
//      missing same-day leg by design ("throwing beats inventing a mode the
//      matrix never offered"), and that throw would take the WHOLE multi-day
//      solve down with it if the day reached the engine at all. Caught here,
//      one day short of that, as an ordinary rejected DayPlan.
//   2. manualOrder        — an ENGINE BYPASS per the roadmap (E2's compile.ts
//      already refuses to model it as a constraint), retimed via the existing
//      rescheduleDay path exactly as planService.planTripDay did pre-E5.
//   3. everything else    — handed to the engine.
//
// Both (1) and (2) are excluded from the EngineProblem by feeding buildProblem
// a doc whose stops are emptied for those day indices (nodeKeys: [] — the
// engine sees a day with a window but nothing pinned to it) rather than by
// filtering the doc's day LIST, so every array stays positionally aligned with
// `doc.days` throughout — no dayIndex remapping anywhere in this file.

import { getMapsProvider } from "./config";
import { DEFAULT_SETTINGS, type Settings } from "./maps/types";
import { intersectHoursWithWeekday } from "./maps/openingHours";
import { compileFromDoc, stopKeys } from "./constraints/compile";
import {
  buildProblem,
  alnsEngine,
  isoWeekdayOfDay,
  type Conflict,
  type DocPatch,
  type Proposal,
} from "./engine";
// E6a — both `alnsEngine.solve` call sites below go through `runSolve`
// (src/lib/engineWorker/host.ts), which chooses worker-thread vs in-process
// per ENGINE_IN_WORKER/JEST_WORKER_ID. `alnsEngine` itself stays imported
// above for its `.name`/`.version` (engineMeta) — those are static strings,
// identical either way solve actually ran.
import { runSolve } from "./engineWorker/host";
import { hoursNoteFor } from "./plan/hoursAdvisory";
import { formatDuration } from "./util/duration";
import { dayProjection, solveProjection } from "./plan/solveProjection";
import { applyDocPatch, validManualOrder } from "./planShared";
import { buildEffectiveMatrix } from "./solver/effectiveMatrix";
import { applyLegModes, rescheduleDay } from "./schedule/schedule";
import { stableHash } from "./util/stableHash";
import type { EffectiveMatrix } from "./solver/types";
import type { Day, DayPlan } from "./schedule/types";
import type { TripDay, TripDoc, TripStop } from "./store/types";

export type EngineMeta = { name: string; version: string; seed: number };

export type EnginePlanResult = {
  days: DayPlan[];
  conflicts: Conflict[];
  proposals: Proposal[];
  softViolations: Array<{
    code: string;
    detail: string;
    stopIds: string[];
    dayIndex?: number;
    weight: number;
  }>;
  engineMeta: EngineMeta;
};

export function settingsOf(doc: TripDoc): Settings {
  return {
    ...DEFAULT_SETTINGS,
    walkMax: doc.settings.walkMax,
    driveOverheadMin: doc.settings.driveOverheadMin,
  };
}

// ---------------------------------------------------------------------------
// Budgets — MUST-DO 3: pass a FINITE, GENEROUS budget alongside an explicit
// iterCap, so the answer is machine-independent (search.ts: once iterCap is
// given, the wall clock stops gating the loop entirely — that's the engine's
// own deliberate determinism trade, not a bug here).
// ---------------------------------------------------------------------------

const DEFAULT_ENGINE_BUDGET_MS = 20_000;
// jest sets JEST_WORKER_ID on every test worker automatically. Measured
// empirically (E5b): ts-jest's per-iteration overhead is roughly an order of
// magnitude worse than a plain `tsx`/production Node process (same formula,
// same iterCap: ~90k iterations at n=4 took ~300ms under tsx but 2-4s under
// jest) — almost certainly ts-jest's transform/VM context, not the engine.
// 500ms keeps every fixture-sized (single-digit to low-teens stops) test doc
// at the ITER_CAP formula's 20k-iteration FLOOR (the formula's minimum,
// regardless of budget — see ITER_CAP_MIN below), which measured ~500-700ms
// even under that jest overhead — comfortable under jest's default 5s
// per-test timeout, including tests that trigger two solves. Tests that want
// a bigger, deliberately-ALNS-bound problem (scale.test.ts, this file's own
// quality-regression harness) call the engine directly with their own
// explicit iterCap/timeBudgetMs and never go through this function at all.
// ENGINE_BUDGET_MS always wins when set explicitly (e.g. playwright.config.ts
// sets 3000 for the e2e dev server — a REAL Node process, not jest, where the
// overhead above doesn't apply, so it can afford to stay closer to "generous").
const TEST_ENGINE_BUDGET_MS = 500;

export function engineBudgetMs(): number {
  const raw = Number(process.env.ENGINE_BUDGET_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return process.env.JEST_WORKER_ID !== undefined
    ? TEST_ENGINE_BUDGET_MS
    : DEFAULT_ENGINE_BUDGET_MS;
}

// Mirrors src/lib/engine/search.ts's ITER_CAP formula EXACTLY (same constants,
// cited there). Duplicated rather than imported: the constants are internal to
// search.ts and not part of the engine's public surface (src/lib/engine/
// index.ts) — this file may only consume that port. Computing the cap here
// (instead of leaving it to search.ts's own internal default) is what makes it
// possible to pass `iterCap` explicitly, per MUST-DO 3 and the roadmap's "same
// doc -> same seed -> same plan" contract: a size-only, budget-only formula
// computed OUTSIDE the engine is exactly as deterministic as one computed
// inside it, since it is the same formula over the same inputs.
const ITER_CAP_RATE = 430;
const ITER_CAP_MIN = 20_000;
const ITER_CAP_MAX = 500_000;

export function iterCapFor(n: number, budgetMs: number): number {
  const raw = Math.round((ITER_CAP_RATE * budgetMs) / (n + 10));
  return Math.min(ITER_CAP_MAX, Math.max(ITER_CAP_MIN, raw));
}

// ---------------------------------------------------------------------------
// Seed — deterministic from the doc's solve-relevant content, so the SAME doc
// always gets the SAME seed (and, at a fixed iterCap, the SAME plan), while
// any edit that changes solveHash naturally reseeds the solve. solveProjection
// is pure and has no dependency on this module or on planStore, so importing
// it directly here (rather than computeSolveHash from planStore) carries no
// cycle risk.
// ---------------------------------------------------------------------------

function truncateSeed(hex: string): number {
  // Truncate to 32 bits: an 8-hex-digit prefix of a sha256 hex digest, read as
  // an unsigned 32-bit int (>>> 0). createRng (util/rng.ts) coerces its seed
  // to a 32-bit int internally anyway, so this loses nothing meaningful.
  return parseInt(hex.slice(0, 8), 16) >>> 0;
}

export function seedFor(doc: TripDoc): number {
  return truncateSeed(stableHash(solveProjection(doc)));
}

// E5c decision 2 — a day-scoped solve seeds from THAT DAY's own content hash
// only, so an edit to any other day can never reseed (and hence never
// reshuffle) this one — churn confinement by construction. Used by
// solveDayWithEngine below; the whole-doc `seedFor` above stays what a
// trip-scope re-cook uses (planStore.ts's recookTrip) for its one joint solve.
export function seedForDay(doc: TripDoc, dayIndex: number): number {
  return truncateSeed(stableHash(dayProjection(doc, dayIndex)));
}

// ---------------------------------------------------------------------------
// Per-day matrix acquisition + pair-completeness (MUST-DO 4)
// ---------------------------------------------------------------------------

export function toLegacyDay(tripDay: TripDay): Day {
  return {
    date: tripDay.date,
    dayStartMin: tripDay.dayStartMin,
    dayEndMin: tripDay.dayEndMin,
    stops: tripDay.stops.map((s) => ({
      id: s.id,
      name: s.name,
      durationMin: s.durationMin,
      anchor: s.anchor,
    })),
    precedence: tripDay.precedence,
  };
}

/** The first same-day ordered pair the effective matrix has no entry for, by
 * NAME (for a legible message) — or null when every pair is covered. Mirrors
 * planService.planTripDay's implicit assumption (it never checked this and
 * would have thrown deep inside rescheduleDay/planDay instead). */
function firstMissingPair(stops: readonly TripStop[], matrix: EffectiveMatrix): [string, string] | null {
  for (const a of stops) {
    for (const b of stops) {
      if (a.id === b.id) continue;
      if (!matrix[a.id]?.[b.id]) return [a.name, b.name];
    }
  }
  return null;
}

export type DayMatrixResult = { matrix: EffectiveMatrix; rejectedMessage: string | null };

export async function matrixForDay(tripDay: TripDay, settings: Settings): Promise<DayMatrixResult> {
  if (tripDay.stops.length === 0) return { matrix: {}, rejectedMessage: null };
  const provider = getMapsProvider();
  try {
    const driveMatrix = await provider.getTravelMatrix(
      tripDay.stops.map((s) => ({ id: s.id, location: s.location })),
      "driving"
    );
    const locations = Object.fromEntries(tripDay.stops.map((s) => [s.id, s.location]));
    const matrix = buildEffectiveMatrix(driveMatrix, locations, settings);
    const missing = firstMissingPair(tripDay.stops, matrix);
    if (missing) {
      return {
        matrix: {},
        rejectedMessage: `This day's plan couldn't be cooked — the travel time between "${missing[0]}" and "${missing[1]}" is missing.`,
      };
    }
    return { matrix, rejectedMessage: null };
  } catch (e) {
    return {
      matrix: {},
      rejectedMessage: "This day's plan couldn't be cooked — " + (e instanceof Error ? e.message : String(e)),
    };
  }
}

// ---------------------------------------------------------------------------
// legOverrides re-timing — the SAME machinery planService.planTripDay used,
// applied to a day's FINAL chosen order regardless of who chose it (the
// engine or a manual pin). Mirrors planTripDay's override block verbatim.
// ---------------------------------------------------------------------------

export function applyOverridesToPlan(
  doc: TripDoc,
  dayIndex: number,
  day: Day,
  plan: Extract<DayPlan, { status: "ok" }>,
  matrix: EffectiveMatrix,
  settings: Settings
): DayPlan {
  const overrides = doc.legOverrides.filter((o) => o.dayIndex === dayIndex);
  if (overrides.length === 0) return plan;

  const legPairs = new Set(plan.legs.map((l) => `${l.fromId}|${l.toId}`));
  const applicable = overrides.filter(
    (o) => legPairs.has(`${o.fromId}|${o.toId}`) && (o.mode === "drive" || matrix[o.fromId][o.toId].walkMin !== null)
  );
  if (applicable.length === 0) return plan;

  const toggled = applyLegModes(matrix, applicable);
  const retimed = rescheduleDay(day, plan.order, toggled, settings, plan.quality);
  if (retimed.status === "ok" && plan.marginNotes) {
    return { ...retimed, marginNotes: plan.marginNotes };
  }
  return retimed;
}

// ---------------------------------------------------------------------------
// Journal-voice margin notes from conflicts / soft violations (MUST-DO 2:
// "surface conflicts as margin notes minimally before hoursFromDoc runs in
// prod"). Deliberately SKIPS `hours`-coded conflicts: applyHoursAdvisories
// (src/lib/plan/hoursAdvisory.ts) still runs over every day below and already
// produces a nicer, specific note for that case ("closes at 17:00", "doesn't
// open until…") — reporting it again here would just double the note.
// ---------------------------------------------------------------------------

function shortReason(c: Conflict): string {
  switch (c.code) {
    case "dropped-stop":
    case "dropped-must":
      return "it didn't fit the day";
    case "anchor-start":
      return `it would land ${formatDuration(c.violatedByMin)} after its booked time`;
    case "day-window":
      return `the day runs ${formatDuration(c.violatedByMin)} over`;
    case "precedence":
      return "the order it was meant to follow got tangled";
    case "pace-active":
    case "pace-effort":
    case "pace-gap":
      return "the day's too packed";
    case "meal-block":
      return "it landed in a held block";
    default:
      return "something didn't line up";
  }
}

function conflictNotesForDay(conflicts: readonly Conflict[], dayIndex: number, nameOf: (key: string) => string): string[] {
  return conflicts
    .filter((c) => c.dayIndex === dayIndex && c.code !== "hours")
    .map((c) => {
      const who = c.stopIds.length > 0 ? c.stopIds.map(nameOf).join(" & ") : "your plan";
      return `Gracie couldn't fit ${who} — ${shortReason(c)}. Tap re-plan after adjusting.`;
    });
}

// Non-precedence soft violations (pace, today) get their own prefix. THREE
// distinct note prefixes exist on purpose (E5c audit F1 + the prefix collision
// it exposed): each class has a different lifecycle across retimes/day-solves,
// and the strip-and-re-derive logic tells them apart ONLY by prefix:
//   "Heads up — "     hours advisories — re-derived from the retimed schedule
//   "Worth noting — " cross-day precedence — re-derived from the doc (below)
//   "Pace check — "   engine pace findings — carried verbatim (day content
//                     unchanged on a kept day means they remain valid)
function softViolationNotesForDay(
  violations: EnginePlanResult["softViolations"],
  dayIndex: number
): string[] {
  return violations
    .filter((v) => v.dayIndex === dayIndex && v.code !== "precedence")
    .map((v) => `Pace check — ${v.detail}.`);
}

/**
 * Cross-day precedence advisories, derived from the FULL doc — the single
 * source of truth for this note class in EVERY solve path (E5c audit F1: the
 * day-scoped solve empties other days, compileFromDoc drops the now-dangling
 * pair, and the note silently vanished; deriving from the doc instead of the
 * engine's soft violations makes the note's existence independent of solve
 * scope). Decidable without the engine because pins are hard: the wish is
 * violated iff the before-endpoint's day comes after the after-endpoint's.
 * Attached to the BEFORE endpoint's day, matching the engine's own convention.
 */
export function crossDayPrecedenceNotes(doc: TripDoc, dayIndex: number): string[] {
  const dayOf = new Map<string, number>();
  doc.days.forEach((d, i) => {
    for (const s of d.stops) if (!dayOf.has(s.id)) dayOf.set(s.id, i);
  });
  const nameOf = (id: string): string =>
    doc.days.flatMap((d) => d.stops).find((s) => s.id === id)?.name ?? id;

  const notes: string[] = [];
  for (const d of doc.days) {
    for (const pair of d.precedence ?? []) {
      const bd = dayOf.get(pair.beforeId);
      const ad = dayOf.get(pair.afterId);
      if (bd === undefined || ad === undefined || bd === ad) continue; // same-day or dangling
      if (bd <= ad) continue; // wish satisfied by the day assignment
      if (bd !== dayIndex) continue; // note lives on the before-endpoint's day
      notes.push(
        `Worth noting — "${nameOf(pair.beforeId)}" was meant to come before "${nameOf(pair.afterId)}".`
      );
    }
  }
  return notes;
}

function withMarginNotes(plan: DayPlan, notes: readonly string[]): DayPlan {
  if (notes.length === 0 || plan.status !== "ok") return plan;
  return { ...plan, marginNotes: [...(plan.marginNotes ?? []), ...notes] };
}

export function applyHoursAdvisoryToDay(doc: TripDoc, dayIndex: number, plan: DayPlan): DayPlan {
  if (plan.status !== "ok") return plan;
  const day = doc.days[dayIndex];
  const weekday = isoWeekdayOfDay(day);
  if (weekday === null) return plan;
  const stopsById = new Map(day.stops.map((s) => [s.id, s]));
  const notes: string[] = [];
  for (const entry of plan.entries) {
    const stop = stopsById.get(entry.stopId);
    if (!stop?.hours) continue;
    const open = intersectHoursWithWeekday(stop.hours, weekday);
    // F7 (E5b audit must-not, closed E6b) — lastEntryMin/closedDates are
    // enforced HARD by the engine (problem.ts's hoursFromDoc) but say nothing
    // to a byWeekday-only `open` check; see hoursAdvisory.ts's hoursNoteFor
    // doc comment for why a breach could otherwise produce zero margin note.
    const note = hoursNoteFor(stop.name, weekday, entry.startMin, entry.departMin, open, {
      lastEntryMin: stop.hours.lastEntryMin,
      closedToday: stop.hours.closedDates?.includes(day.date) ?? false,
    });
    if (note) notes.push(note);
  }
  return withMarginNotes(plan, notes);
}

// ---------------------------------------------------------------------------
// Closed-day auto-relocation (Chris, 2026-08-14): a stop whose hours say it is
// CLOSED on the day the paste assigned it — and that the user hasn't
// explicitly committed to that day (no anchor/booking) — should not become a
// decision card; Gracie puts it on a day that works and says so in the
// margin. Runs ONLY after whole-trip solves (initial cook + re-cook trip):
// day membership on a closed day can only come from the paste, because the
// one cross-day move a user can make — accepting a moveDay proposal — can
// never target a closed day (deriveProposals filters any candidate that
// creates a new conflict). Anchored stops keep asking via the cards, exactly
// as before. Selection reuses the engine's own priced proposals: the cheapest
// moveDay that RESOLVES the closed-day conflict (proposals are already sorted
// by costDeltaMin, and pricing already proved it creates no new conflict).
// ---------------------------------------------------------------------------

const WEEKDAY_PLURAL = [
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
  "Sundays",
] as const;

export type AutoMove = {
  stopId: string;
  stopName: string;
  fromDayIndex: number;
  toDayIndex: number;
  /** "Mondays" — or "that day" when the closure came from closedDates rather
   * than a weekday pattern (or the weekday is somehow unknowable). */
  closedOn: string;
};

export type AutoRelocateOutcome = { doc: TripDoc; moves: AutoMove[] };

/** Pure selection + doc application; the CALLER re-solves the returned doc
 * (matrices change when day membership does) and annotates the fresh plans
 * with `autoMoveNotes`. Returns null when nothing is auto-movable. */
export function autoRelocateClosedDayStops(
  doc: TripDoc,
  result: EnginePlanResult
): AutoRelocateOutcome | null {
  const dismissedIds = new Set((doc.dismissedProposals ?? []).map((d) => d.id));
  const moves: AutoMove[] = [];
  let nextDoc = doc;

  for (const conflict of result.conflicts) {
    if (conflict.code !== "hours" || !conflict.closedDay) continue;
    if (conflict.dayIndex === undefined) continue;
    if (dismissedIds.has(conflict.id)) continue; // the user already said "leave it"

    // Cheapest moveDay that provably fixes this conflict. Proposal patches
    // carry doc-level stop ids (not node keys), so no key mapping is needed.
    const proposal = result.proposals.find(
      (p) => p.kind === "moveDay" && p.patch.op === "moveStop" && p.resolves.includes(conflict.id)
    );
    if (!proposal || proposal.patch.op !== "moveStop") continue;
    const { stopId, fromDayIndex, toDayIndex } = proposal.patch;

    const fromDay = nextDoc.days[fromDayIndex];
    const stop = fromDay?.stops.find((s) => s.id === stopId);
    if (!stop) continue; // already moved by an earlier conflict this pass
    if (stop.anchor) continue; // booked = explicitly committed → card, not auto-move

    const applied = applyDocPatch(nextDoc, proposal.patch);
    if (!applied.ok) continue; // stale against an earlier move — leave as a card

    const weekday = fromDay === undefined ? null : isoWeekdayOfDay(fromDay);
    nextDoc = applied.doc;
    moves.push({
      stopId,
      stopName: stop.name,
      fromDayIndex,
      toDayIndex,
      closedOn: weekday === null ? "that day" : WEEKDAY_PLURAL[weekday],
    });
  }

  return moves.length === 0 ? null : { doc: nextDoc, moves };
}

/** Margin notes for a completed auto-move pass, appended to the RE-SOLVED
 * plans: one on the origin day (where the user will look for the stop) and
 * one on the destination (why it appeared). "Heads up — " class on purpose:
 * planStore strips-and-re-derives that prefix on the next re-plan, so the
 * notice lives exactly until the user next touches the trip. */
export function annotateAutoMoves(days: DayPlan[], moves: readonly AutoMove[]): DayPlan[] {
  if (moves.length === 0) return days;
  return days.map((plan, i) => {
    const notes: string[] = [];
    for (const m of moves) {
      if (i === m.fromDayIndex) {
        notes.push(
          `Heads up — Gracie moved ${m.stopName} to day ${m.toDayIndex + 1}: Google says it's closed on ${m.closedOn}.`
        );
      }
      if (i === m.toDayIndex) {
        notes.push(
          `Heads up — ${m.stopName} moved here from day ${m.fromDayIndex + 1}: Google says it's closed on ${m.closedOn}.`
        );
      }
    }
    return withMarginNotes(plan, notes);
  });
}

// ---------------------------------------------------------------------------
// planTripWithEngine
// ---------------------------------------------------------------------------

export type PreparedDayMatrices = {
  matrices: EffectiveMatrix[];
  rejectedMessages: Map<number, string>;
  manualOrders: Map<number, string[]>;
};

/**
 * The per-day, genuinely-async part: fetch/derive each day's effective matrix
 * (provider I/O), classify pair-incomplete days as rejected (MUST-DO 4) and
 * manualOrder days as engine-bypassed. Split out from `planTripWithEngine` so
 * pipeline.ts's SSE generator can `yield` real per-day progress between
 * iterations of THIS loop — a callback threaded into a function pipeline.ts
 * doesn't own can observe progress, but it cannot suspend pipeline.ts's own
 * generator, which is the whole point of a generator being a generator.
 */
export async function prepareDayMatrices(doc: TripDoc): Promise<PreparedDayMatrices> {
  const settings = settingsOf(doc);
  const rejectedMessages = new Map<number, string>();
  const matrices: EffectiveMatrix[] = [];
  for (let i = 0; i < doc.days.length; i++) {
    const { matrix, rejectedMessage } = await matrixForDay(doc.days[i], settings);
    matrices.push(matrix);
    if (rejectedMessage) rejectedMessages.set(i, rejectedMessage);
  }

  const manualOrders = new Map<number, string[]>();
  doc.days.forEach((tripDay, i) => {
    if (rejectedMessages.has(i)) return;
    const order = validManualOrder(
      tripDay.manualOrder,
      tripDay.stops.map((s) => s.id)
    );
    if (order) manualOrders.set(i, order);
  });

  return { matrices, rejectedMessages, manualOrders };
}

export type SolveWithPreparedOptions = {
  /** Threaded straight into the engine's own SolveOptions.onProgress (see
   * src/lib/engine/types.ts) — this file adds no logic on top, it just gives
   * a caller outside the engine's port a way to observe the SAME progress
   * events the port already emits. NOTE: `alnsEngine.solve` is a synchronous,
   * CPU-bound call (its own doc comment: "wrapping it in a Promise would buy
   * nothing... it blocks") — a caller that wants to `yield` these between
   * OTHER awaited work must collect them here and yield them afterward; they
   * cannot arrive live mid-call no matter how this callback is wired, because
   * nothing else runs on Node's single thread until the call returns.
   */
  onSolveProgress?: (p: { pct: number; bestScore: number; phase: string }) => void;
  /** WALL-CLOCK mode (E5b audit F1): omit iterCap so the engine's own clock
   * genuinely nets the solve at timeBudgetMs. Used by readPlanned's heal path,
   * which runs inside a page render: a heal needs to FINISH more than it needs
   * byte-reproducibility (the healed plan is persisted, so whichever anytime
   * result it lands on becomes stable anyway). Explicit re-plans keep the
   * deterministic iterCap mode. */
  wallClockOnly?: boolean;
};

/** The rest of the pipeline, given matrices already prepared (see
 * `prepareDayMatrices`). `planTripWithEngine` below is just this composed
 * with that. */
export async function solveWithPreparedMatrices(
  doc: TripDoc,
  prepared: PreparedDayMatrices,
  opts: SolveWithPreparedOptions = {}
): Promise<EnginePlanResult> {
  const settings = settingsOf(doc);
  const { matrices, rejectedMessages, manualOrders } = prepared;
  const excluded = new Set<number>([...rejectedMessages.keys(), ...manualOrders.keys()]);

  // ---- build + solve the engine problem over everything else --------------
  const engineDoc: TripDoc = {
    ...doc,
    days: doc.days.map((d, i) => (excluded.has(i) ? { ...d, stops: [] } : d)),
  };
  const set = compileFromDoc(engineDoc);
  const problem = buildProblem(engineDoc, set, matrices);

  const seed = seedFor(doc);
  const timeBudgetMs = engineBudgetMs();

  const solution = await runSolve(problem, {
    seed,
    timeBudgetMs,
    // Deterministic mode passes an explicit iterCap; wall-clock mode (heals —
    // audit F1) omits it so the engine's clock genuinely nets at the budget.
    ...(opts.wallClockOnly ? {} : { iterCap: iterCapFor(problem.nodes.length, timeBudgetMs) }),
    // The hard safety net (E5b audit F2): iterCap alone leaves NOTHING bounding
    // wall time — 26s was measured over a "20s budget" on a fast dev box, and a
    // slow serverless vCPU multiplies that. 3x budget (1.5x in wall-clock mode,
    // where the primary clock is already armed) = generous enough that the net
    // firing means the machine is pathologically slow, in which case an anytime
    // best-so-far (with determinism sacrificed for that one solve) is strictly
    // better than a platform timeout. (E6a: `runSolve`'s worker path adds its
    // OWN +5s grace on top of this before terminate()-ing — see host.ts.)
    hardStopMs: opts.wallClockOnly ? timeBudgetMs * 1.5 : timeBudgetMs * 3,
    onProgress: opts.onSolveProgress,
  });

  const nameOf = (key: string): string => problem.nodes.find((n) => n.key === key)?.name ?? key;

  // ---- assemble per-day plans -----------------------------------------------
  const days: DayPlan[] = await Promise.all(
    doc.days.map(async (tripDay, i) => {
      const message = rejectedMessages.get(i);
      if (message !== undefined) return { status: "rejected" as const, message };

      const manualOrder = manualOrders.get(i);
      const day = toLegacyDay(tripDay);
      if (manualOrder) {
        const plan = rescheduleDay(day, manualOrder, matrices[i], settings, "manual");
        if (plan.status !== "ok") return plan; // e.g. a manual order that breaks an anchor
        const withOverrides = applyOverridesToPlan(doc, i, day, plan, matrices[i], settings);
        return applyHoursAdvisoryToDay(doc, i, withOverrides);
      }

      const enginePlan = solution.days[i];
      if (enginePlan.status !== "ok") return enginePlan; // defensive: the engine never returns this
      // Strip the engine's OWN marginNotes (assembleDay attached
      // marginNotesForDay(conflicts, dayIndex) internally — see
      // src/lib/engine/alnsEngine.ts) before layering ours on: those are the
      // same conflicts conflictNotesForDay below turns into journal-voice
      // notes, and leaving both in would show every conflict twice, once in
      // the engine's own wording and once in Gracie's.
      const { marginNotes: _engineNotes, ...cleanPlan } = enginePlan;
      const withOverrides = applyOverridesToPlan(doc, i, day, cleanPlan, matrices[i], settings);
      const withConflictNotes = withMarginNotes(withOverrides, [
        ...conflictNotesForDay(solution.conflicts, i, nameOf),
        ...softViolationNotesForDay(solution.softViolations, i),
        // Cross-day precedence: from the DOC, not the engine's violations —
        // identical in every solve scope (audit F1; helper doc comment).
        ...crossDayPrecedenceNotes(doc, i),
      ]);
      return applyHoursAdvisoryToDay(doc, i, withConflictNotes);
    })
  );

  // Excluded days contributed ZERO nodes to the problem, so nothing the engine
  // returns can reference them — this filter is a defensive no-op that keeps
  // that invariant honest if the engine's internals ever change under it.
  const conflicts = solution.conflicts.filter((c) => c.dayIndex === undefined || !excluded.has(c.dayIndex));
  const keptConflictIds = new Set(conflicts.map((c) => c.id));
  const proposals = solution.proposals
    .map((p) => ({ ...p, resolves: p.resolves.filter((id) => keptConflictIds.has(id)) }))
    .filter((p) => p.resolves.length > 0 && !proposalTouchesExcludedDay(p.patch, excluded));
  const softViolations = solution.softViolations.filter(
    (v) => v.dayIndex === undefined || !excluded.has(v.dayIndex)
  );

  return {
    days,
    conflicts,
    proposals,
    softViolations,
    engineMeta: { name: alnsEngine.name, version: alnsEngine.version, seed },
  };
}

/** `prepareDayMatrices` + `solveWithPreparedMatrices`, composed — the
 * ordinary entry point for a caller (planStore.savePlanned) that doesn't need
 * per-day/per-tick progress observation. */
export async function planTripWithEngine(
  doc: TripDoc,
  opts: SolveWithPreparedOptions = {}
): Promise<EnginePlanResult> {
  const prepared = await prepareDayMatrices(doc);
  return solveWithPreparedMatrices(doc, prepared, opts);
}

// ---------------------------------------------------------------------------
// E5c — day-scoped solve. planStore.ts's incremental savePlanned calls this
// once per STALE day (never for a day whose stored plan is being kept
// verbatim); planStore.ts's recookDay forces exactly one call here too,
// ignoring whether the day's hash actually changed. Same "other days emptied"
// trick as solveWithPreparedMatrices's excluded-day handling above, just
// carried to its limit: every day except `dayIndex` is emptied, so the
// problem the engine sees reduces to EXACTLY that day's slice — launch mode
// hard-pins every stop to its own day, so that slice IS that day's slice of
// the whole-trip solve (STATE.md's E5c decision 1). Cross-day proposals
// (moveDay) cannot arise here by construction: every OTHER day contributes
// zero nodes, so there is nothing to propose moving a stop to/from.
// ---------------------------------------------------------------------------

export type DaySolveResult = {
  day: DayPlan;
  conflicts: Conflict[];
  proposals: Proposal[];
  softViolations: EnginePlanResult["softViolations"];
};

export async function solveDayWithEngine(
  doc: TripDoc,
  dayIndex: number,
  opts: SolveWithPreparedOptions = {}
): Promise<DaySolveResult> {
  const settings = settingsOf(doc);
  const tripDay = doc.days[dayIndex];
  const { matrix, rejectedMessage } = await matrixForDay(tripDay, settings);
  if (rejectedMessage) {
    return { day: { status: "rejected", message: rejectedMessage }, conflicts: [], proposals: [], softViolations: [] };
  }

  const day = toLegacyDay(tripDay);
  const manualOrder = validManualOrder(
    tripDay.manualOrder,
    tripDay.stops.map((s) => s.id)
  );
  if (manualOrder) {
    const plan = rescheduleDay(day, manualOrder, matrix, settings, "manual");
    if (plan.status !== "ok") return { day: plan, conflicts: [], proposals: [], softViolations: [] };
    const withOverrides = applyOverridesToPlan(doc, dayIndex, day, plan, matrix, settings);
    return {
      day: applyHoursAdvisoryToDay(doc, dayIndex, withOverrides),
      conflicts: [],
      proposals: [],
      softViolations: [],
    };
  }

  const excluded = new Set(doc.days.map((_, i) => i).filter((i) => i !== dayIndex));
  const engineDoc: TripDoc = {
    ...doc,
    days: doc.days.map((d, i) => (i === dayIndex ? d : { ...d, stops: [] })),
  };
  const set = compileFromDoc(engineDoc);
  const matrices = doc.days.map((_, i) => (i === dayIndex ? matrix : {}));
  const problem = buildProblem(engineDoc, set, matrices);

  // Per-day seed (E5c decision 2) — see seedForDay's own doc comment.
  const seed = seedForDay(doc, dayIndex);
  const timeBudgetMs = engineBudgetMs();

  const solution = await runSolve(problem, {
    seed,
    timeBudgetMs,
    ...(opts.wallClockOnly ? {} : { iterCap: iterCapFor(problem.nodes.length, timeBudgetMs) }),
    hardStopMs: opts.wallClockOnly ? timeBudgetMs * 1.5 : timeBudgetMs * 3,
    onProgress: opts.onSolveProgress,
  });

  const nameOf = (key: string): string => problem.nodes.find((n) => n.key === key)?.name ?? key;

  const enginePlan = solution.days[dayIndex];
  if (enginePlan.status !== "ok") {
    return { day: enginePlan, conflicts: [], proposals: [], softViolations: [] }; // defensive: the engine never returns this
  }
  const { marginNotes: _engineNotes, ...cleanPlan } = enginePlan;
  const withOverrides = applyOverridesToPlan(doc, dayIndex, day, cleanPlan, matrix, settings);

  // F4 (E5c audit): stopKeys is DOC-GLOBAL, so a cross-day repeat that keys
  // `id@dN` in a trip-scope solve keys BARE `id` here (earlier days emptied).
  // Schedules and patches are safe (they use bare stopId + dayIndex), but
  // persisted Conflict keys/ids must be scope-independent — E6's dismissal
  // keying depends on "same breach = same id". Remap this solve's occurrence
  // keys to the FULL doc's, positionally (same day, same stop index).
  const keyMap = new Map<string, string>();
  const emptiedKeys = stopKeys(engineDoc);
  const fullKeys = stopKeys(doc);
  emptiedKeys[dayIndex].forEach((k, j) => {
    const full = fullKeys[dayIndex][j];
    if (k !== full) keyMap.set(k, full);
  });
  const remapKey = (k: string): string => keyMap.get(k) ?? k;
  const remapConflict = (c: Conflict): Conflict => {
    if (keyMap.size === 0) return c;
    let { id, constraintRef } = c;
    for (const [from, to] of keyMap) {
      id = id.split(from).join(to);
      constraintRef = { ...constraintRef, path: constraintRef.path.split(from).join(to) };
    }
    return { ...c, id, constraintRef, stopIds: c.stopIds.map(remapKey) };
  };

  const conflicts = solution.conflicts.filter((c) => c.dayIndex === dayIndex).map(remapConflict);
  const keptConflictIds = new Set(
    solution.conflicts.filter((c) => c.dayIndex === dayIndex).map((c) => c.id)
  );
  const proposals = solution.proposals
    .map((p) => ({
      ...p,
      resolves: p.resolves.filter((id) => keptConflictIds.has(id)).map((id) => {
        let out = id;
        for (const [from, to] of keyMap) out = out.split(from).join(to);
        return out;
      }),
    }))
    .filter((p) => p.resolves.length > 0 && !proposalTouchesExcludedDay(p.patch, excluded));
  const softViolations = solution.softViolations
    .filter((v) => v.dayIndex === dayIndex)
    .map((v) => (keyMap.size === 0 ? v : { ...v, stopIds: v.stopIds.map(remapKey) }));

  const withConflictNotes = withMarginNotes(withOverrides, [
    ...conflictNotesForDay(solution.conflicts, dayIndex, nameOf),
    ...softViolationNotesForDay(solution.softViolations, dayIndex),
    // Cross-day precedence: from the DOC — identical in every solve scope
    // (audit F1; see crossDayPrecedenceNotes).
    ...crossDayPrecedenceNotes(doc, dayIndex),
  ]);

  return {
    day: applyHoursAdvisoryToDay(doc, dayIndex, withConflictNotes),
    conflicts,
    proposals,
    softViolations,
  };
}

function proposalTouchesExcludedDay(patch: DocPatch, excluded: ReadonlySet<number>): boolean {
  switch (patch.op) {
    case "removeStop":
    case "setAnchor":
    case "setDayWindow":
    case "setDuration":
      return excluded.has(patch.dayIndex);
    case "moveStop":
      return excluded.has(patch.fromDayIndex) || excluded.has(patch.toDayIndex);
    case "setPacePreset":
      return false;
  }
}
