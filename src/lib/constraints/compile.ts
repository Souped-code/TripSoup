// E2 — old model → new model, and patch merging.
//
// `compileFromDoc` is PURE and runs at SOLVE TIME. There is deliberately no
// doc migration: a TripDoc keeps exactly the fields it has today, and the
// constraint set is derived from them on every solve. That keeps every
// persisted doc, share link and legacy trip working untouched, and lets the
// mapping below change (E3's hours, E5's soft pins) without a data rewrite.
//
// NOT COMPILED, ON PURPOSE (both per the roadmap):
//  - `TripDay.manualOrder` — an ENGINE BYPASS, not a constraint. When present
//    the solver is skipped entirely and the pinned order is re-timed; modelling
//    it as a chain of precedence relations would hand it back to the optimiser
//    and quietly relitigate the user's drag.
//  - `TripDoc.legOverrides` — a POST-SOLVE re-timing layer (§2 decide-then-
//    offer). It changes leg modes on a fixed order and never the order, so it
//    is not an input to the constraint set at all (it is excluded from
//    solveHash for the same reason).
//  - `settings.walkMax` / `settings.driveOverheadMin` — travel-model params,
//    they belong to the matrix, not to the constraint vocabulary.

import type { TripDoc } from "../store/types";
import {
  canonicalRelationSpec,
  relationId,
  winner,
  type ConstraintPatch,
  type ConstraintSet,
  type Constraint,
  type DayConstraints,
  type ListConstraint,
  type PartyConstraints,
  type PartyConstraintsPatch,
  type Provenance,
  type Relation,
  type StopConstraints,
  type TripConstraints,
} from "./types";

// ---------------------------------------------------------------------------
// Compile policy — the knobs this milestone chooses
// ---------------------------------------------------------------------------

/** Soft weights are in the E1 objective's currency: one unit ≈ one minute of
 * travel. For calibration, that objective charges 200 to drop a "should" stop
 * and 60 to drop a "could" one. */
export const CROSS_DAY_PRECEDENCE_WEIGHT = 50;

/** The compiled default pace is a preference, not a rule: a day that runs long
 * should cost something, never be declared infeasible. Priced just under
 * dropping a "could" stop (60) — we would rather run a long day than lose a
 * stop the user asked for. */
export const DEFAULT_PACE_WEIGHT = 50;

const LEGACY: Provenance = { source: "legacy" };
const DERIVED: Provenance = { source: "derived" };
const GOOGLE: Provenance = { source: "google" };

const hard = <T>(value: T, provenance: Provenance): Constraint<T> => ({
  value,
  provenance,
  hardness: "hard",
});

const soft = <T>(value: T, provenance: Provenance, weight: number): Constraint<T> => ({
  value,
  provenance,
  hardness: { soft: { weight } },
});

// ---------------------------------------------------------------------------
// compileFromDoc
// ---------------------------------------------------------------------------

/** Derive the constraint set a solve should run against from today's TripDoc.
 *
 * The mapping, field by field:
 *
 *   stop.anchor.startMin  → hard visit-START window [t, t]        (legacy)
 *   stop.durationMin      → hard duration {min: d, typical: d, max: d} (legacy)
 *   (nothing)             → effort "medium", hard                 (derived)
 *   (nothing)             → priority "must", hard                 (legacy)
 *   containing day index  → hard pinnedDay                        (legacy)
 *   day.dayStart/EndMin   → hard day window                       (legacy)
 *   day.precedence[]      → precedence relation, hard same-day / soft cross-day (legacy)
 *   (nothing)             → trip pacePreset "balanced", soft      (derived)
 *
 * Provenance is chosen honestly: `legacy` where the value is a faithful reading
 * of a doc field (anchors, durations, day windows, precedence) or of the old
 * engine's semantics (`priority: "must"` — today's solver never drops a stop);
 * `derived` where WE invented the value because nobody said anything (effort,
 * pace). Both lose to any later user or LLM statement, `legacy` first.
 *
 * The pins are HARD: single-day launch mode, the paste decides days. Flipping
 * to engine-assigned days is a hardness change on this one line — see THE
 * ANTI-REMODEL INVARIANT in ./types.
 *
 * Two total-ness rules, both deliberate:
 *  - `stops` is keyed by OCCURRENCE, not bare stop id. The doc de-duplicates
 *    only WITHIN a day ("Cathedral on day 1 and again on day 3" legitimately
 *    keeps one bare id on both days — pipeline.ts's markDuplicateStops is
 *    explicitly scoped per-day). Collapsing to first-occurrence-owns was the
 *    E2 audit's MAJOR finding: it silently dropped the later visit's anchor
 *    and pinned everything to the first day. Instead every occurrence gets its
 *    own entry via stopKeys() below — its own pin, its own window, its own
 *    duration. Keying-level only; the anti-remodel invariant (hard→soft pin is
 *    a value change) is untouched.
 *  - A precedence pair naming a stop that exists nowhere in the doc is DROPPED
 *    (today's engine already downgrades those to a margin note). Every relation
 *    endpoint in the returned set is therefore a key of `stops`, which the
 *    engine may rely on.
 */

/**
 * The occurrence key for every stop of every day, aligned with doc.days[i]
 * .stops[j]. First occurrence of a stored id anywhere in the doc keeps the
 * bare id; a LATER occurrence on another day gets `${id}@d${dayIndex}`
 * (within-day repeats already carry pipeline's `#n` suffix, so same-day
 * collisions cannot reach here; place ids never contain "@"). Exported as the
 * ONE keying function — E5's problem builder must use this same function so
 * ConstraintSet keys and problem-instance node ids can never diverge.
 */
export function stopKeys(doc: TripDoc): string[][] {
  const seen = new Set<string>();
  return doc.days.map((day, dayIndex) =>
    day.stops.map((s) => {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        return s.id;
      }
      return `${s.id}@d${dayIndex}`;
    })
  );
}

export function compileFromDoc(doc: TripDoc): ConstraintSet {
  const stops: Record<string, StopConstraints> = {};
  const keys = stopKeys(doc);
  /** occurrence key → its day index (every occurrence is pinned to ITS day). */
  const dayOfKey = new Map<string, number>();
  /** bare stored id → occurrence keys per day index, for precedence resolution. */
  const keysOfId = new Map<string, Map<number, string>>();

  doc.days.forEach((day, dayIndex) => {
    day.stops.forEach((stop, stopIdx) => {
      const key = keys[dayIndex][stopIdx];
      dayOfKey.set(key, dayIndex);
      if (!keysOfId.has(stop.id)) keysOfId.set(stop.id, new Map());
      keysOfId.get(stop.id)!.set(dayIndex, key);

      const constraints: StopConstraints = {
        duration: hard(
          { minMin: stop.durationMin, typicalMin: stop.durationMin, maxMin: stop.durationMin },
          LEGACY
        ),
        effort: hard("medium", DERIVED),
        priority: hard("must", LEGACY),
        pinnedDay: hard({ index: dayIndex }, LEGACY),
      };
      // E7 audit finding 2: Google hours must live in the compiled BASE (not
      // only as buildNode's when-absent fallback) so provenance rank actually
      // adjudicates the slot — an unconfirmed llm lastEntry (rank 40) now
      // LOSES to the fetched fact (60) instead of evicting it, and a
      // confirmed one (80) wins deliberately. Same value/hardness/provenance
      // buildNode's fallback produced, so a doc without a stored patch
      // compiles to the identical problem.
      if (stop.hours) {
        constraints.hours = hard(stop.hours, GOOGLE);
      }
      if (stop.anchor) {
        // An anchor is a booked time: the visit STARTS exactly then. The
        // degenerate window is the honest reading — and the moment the model
        // wants "somewhere between 14:00 and 15:00" it is already expressible.
        constraints.window = hard(
          { startMin: stop.anchor.startMin, endMin: stop.anchor.startMin },
          LEGACY
        );
      }
      stops[key] = constraints;
    });
  });

  const days: DayConstraints[] = doc.days.map((day) => ({
    window: hard({ startMin: day.dayStartMin, endMin: day.dayEndMin }, LEGACY),
  }));

  // Precedence wishes. Same-day pairs are enforceable by construction (the
  // engine orders within a day), so they compile hard; a cross-day pair is a
  // wish about a day assignment the paste already fixed, so it compiles soft
  // and shows up as a trade-off rather than an infeasibility.
  const byId = new Map<string, Relation>();
  doc.days.forEach((day, dayIndex) => {
    for (const pair of day.precedence ?? []) {
      // Precedence pairs live on a specific day; resolve each endpoint to the
      // occurrence ON THAT DAY when one exists (the pair was written about
      // that visit), falling back to the id's first occurrence for a
      // cross-day wish. Dangling references (no occurrence anywhere) drop.
      const resolve = (storedId: string): string | undefined => {
        const perDay = keysOfId.get(storedId);
        if (!perDay) return undefined;
        return perDay.get(dayIndex) ?? perDay.values().next().value;
      };
      const beforeKey = resolve(pair.beforeId);
      const afterKey = resolve(pair.afterId);
      if (beforeKey === undefined || afterKey === undefined) continue; // dangling reference
      const spec = canonicalRelationSpec({
        kind: "precedence",
        beforeId: beforeKey,
        afterId: afterKey,
      });
      const id = relationId(spec);
      if (byId.has(id)) continue; // the same wish stated twice is one constraint
      const sameDay = dayOfKey.get(beforeKey) === dayOfKey.get(afterKey);
      byId.set(id, {
        id,
        ...(sameDay
          ? hard(spec, LEGACY)
          : soft(spec, LEGACY, CROSS_DAY_PRECEDENCE_WEIGHT)),
      });
    }
  });

  const trip: TripConstraints = {
    pacePreset: soft("balanced", DERIVED, DEFAULT_PACE_WEIGHT),
  };

  return { version: 1, stops, days, trip, relations: [...byId.values()] };
}

// ---------------------------------------------------------------------------
// mergePatches
// ---------------------------------------------------------------------------

/** Fold patches onto a compiled base, newest last. See ConstraintPatch in
 * ./types for the full rule set; the short version:
 *
 *   user > llm-confirmed > google > llm-unconfirmed > derived > legacy,
 *   ties broken by "later patch wins", nothing is ever deleted, and patches
 *   cannot create stops or days.
 *
 * Pure and total: no throw path, no I/O. Unknown stop ids, out-of-range day
 * indexes and unparseable day keys are ignored rather than fatal, so a stale
 * patch (E6 applies one against a doc that has since changed) degrades to a
 * no-op on the parts that no longer exist instead of corrupting the set. */
export function mergePatches(base: ConstraintSet, ...patches: ConstraintPatch[]): ConstraintSet {
  return patches.reduce(applyPatch, base);
}

function applyPatch(base: ConstraintSet, patch: ConstraintPatch): ConstraintSet {
  return {
    version: base.version,
    stops: mergeStops(base.stops, patch.stops),
    days: mergeDays(base.days, patch.days),
    trip: mergeTrip(base.trip, patch.trip),
    relations: mergeList(base.relations, patch.relations),
  };
}

function mergeStops(
  base: Readonly<Record<string, StopConstraints>>,
  patch: ConstraintPatch["stops"]
): Readonly<Record<string, StopConstraints>> {
  if (!patch) return base;
  const out: Record<string, StopConstraints> = { ...base };
  for (const [stopId, p] of Object.entries(patch)) {
    // Prototype-pollution guard (E2 audit, minor 2c): a JSON-parsed
    // "__proto__" key would read Object.prototype as a truthy "existing stop"
    // and graft merged fields onto the record's prototype chain. Only own,
    // data-bearing keys of `base` are mergeable.
    if (!Object.prototype.hasOwnProperty.call(out, stopId)) continue;
    const b = out[stopId];
    if (!b || !p) continue; // patches cannot create stops — the doc owns them
    const merged: StopConstraints = {
      duration: winner(b.duration, p.duration),
      effort: winner(b.effort, p.effort),
      priority: winner(b.priority, p.priority),
    };
    const window = winner(b.window, p.window);
    if (window) merged.window = window;
    const hours = winner(b.hours, p.hours);
    if (hours) merged.hours = hours;
    const pinnedDay = winner(b.pinnedDay, p.pinnedDay);
    if (pinnedDay) merged.pinnedDay = pinnedDay;
    out[stopId] = merged;
  }
  return out;
}

function mergeDays(
  base: readonly DayConstraints[],
  patch: ConstraintPatch["days"]
): readonly DayConstraints[] {
  if (!patch) return base;
  const out = [...base];
  for (const [key, p] of Object.entries(patch)) {
    // JSON round-trips numeric keys as strings; parse defensively and ignore
    // anything that is not an index of an existing day.
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= out.length || !p) continue;
    const b = out[index];
    const merged: DayConstraints = { window: winner(b.window, p.window) };
    const mealBlocks = mergeOptionalList(b.mealBlocks, p.mealBlocks);
    if (mealBlocks) merged.mealBlocks = mealBlocks;
    const paceBudget = winner(b.paceBudget, p.paceBudget);
    if (paceBudget) merged.paceBudget = paceBudget;
    out[index] = merged;
  }
  return out;
}

function mergeTrip(base: TripConstraints, patch: ConstraintPatch["trip"]): TripConstraints {
  if (!patch) return base;
  const merged: TripConstraints = { pacePreset: winner(base.pacePreset, patch.pacePreset) };
  const party = mergeParty(base.party, patch.party);
  if (party) merged.party = party;
  return merged;
}

function mergeParty(
  base: PartyConstraints | undefined,
  patch: PartyConstraintsPatch | undefined
): PartyConstraints | undefined {
  if (!patch) return base;
  const b = base ?? {};
  const merged: PartyConstraints = {};
  const walkSpeedFactor = winner(b.walkSpeedFactor, patch.walkSpeedFactor);
  if (walkSpeedFactor) merged.walkSpeedFactor = walkSpeedFactor;
  const arrivalPins = mergeOptionalList(b.arrivalPins, patch.arrivalPins);
  if (arrivalPins) merged.arrivalPins = arrivalPins;
  const quietBlocks = mergeOptionalList(b.quietBlocks, patch.quietBlocks);
  if (quietBlocks) merged.quietBlocks = quietBlocks;
  // An empty patch never conjures an empty `party: {}` into the set.
  return Object.keys(merged).length > 0 ? merged : base;
}

/** Merge two lists of individually-provenanced constraints by `id`: base order
 * is preserved, colliding ids resolve by the one merge rule, and ids the patch
 * introduces are appended in patch order. Deterministic, and never deletes. */
function mergeList<T>(
  base: readonly ListConstraint<T>[],
  patch: readonly ListConstraint<T>[] | undefined
): readonly ListConstraint<T>[] {
  if (!patch) return base;
  const out: ListConstraint<T>[] = [];
  const at = new Map<string, number>();
  for (const c of base) {
    const i = at.get(c.id);
    if (i === undefined) {
      at.set(c.id, out.length);
      out.push(c);
    } else {
      out[i] = c; // duplicate ids inside base: keep the position, take the last
    }
  }
  for (const c of patch) {
    const i = at.get(c.id);
    if (i === undefined) {
      at.set(c.id, out.length);
      out.push(c);
    } else {
      out[i] = winner(out[i], c);
    }
  }
  return out;
}

function mergeOptionalList<T>(
  base: readonly ListConstraint<T>[] | undefined,
  patch: readonly ListConstraint<T>[] | undefined
): readonly ListConstraint<T>[] | undefined {
  if (!patch) return base;
  return mergeList(base ?? [], patch);
}
