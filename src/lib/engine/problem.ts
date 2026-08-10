// E5a — ConstraintSet + TripDoc + effective matrices -> EngineProblem. PURE.
//
// This is the ONLY bridge between "what someone asserted" (a ConstraintSet) and
// "what a solver can consume" (an EngineProblem). Three things become concrete
// here, and each of them is a thing the engine must never have to do mid-search:
//
//  1. KEYS. Nodes are keyed by `stopKeys(doc)` — the same exported function
//     that keys `ConstraintSet.stops`. Not "the same convention": the same
//     function. Cross-day repeat visits carry `id@dN` occurrence keys, and the
//     E2 audit's MAJOR was exactly what happens when two sides of this seam
//     invent the keying independently.
//  2. HOURS. WeeklyHours x the day's weekday, resolved to per-day open
//     intervals, here. A day whose date is an M1.5 `dayLabel` placeholder (or
//     unparseable) has NO weekday and therefore NO hours constraints at all —
//     the same rule hoursAdvisory applies, for the same reason: checking hours
//     against a placeholder date is a confident lie. Advisory-only stays E3's.
//  3. TRAVEL. Effective minutes per ordered pair per day, read out of the AUTO
//     effective matrix. §2 (decide-then-offer) is LOCKED and happens upstream:
//     the engine consumes whatever mode the matrix chose and never chooses one.
//
// Nothing here reads the clock, the network or a config; `buildProblem(a) ===
// buildProblem(a)` for every input, which is what makes the engine's
// determinism claim meaningful.

import {
  isHard,
  softWeight,
  type ConstraintSet,
  type Constraint,
  type DurationRange,
  type Effort,
  type Minutes,
  type PacePreset,
  type Priority,
  type Provenance,
  type WeeklyHours,
  type Window,
} from "../constraints/types";
import { stopKeys } from "../constraints/compile";
import { googleWeekdayToIso, intersectHoursWithWeekday } from "../maps/openingHours";
import { DEFAULT_SETTINGS, type LatLng, type Settings } from "../maps/types";
import { isWalkEligible, walkMinutes } from "../maps/walkEstimator";
import { effectiveMinutes } from "../solver/effectiveMatrix";
import type { EffectiveLeg, EffectiveMatrix } from "../solver/types";
import type { TripDoc, TripStop } from "../store/types";
import type {
  ConstraintRef,
  DayConcreteHours,
  EngineDay,
  EngineNode,
  EngineProblem,
  EngineRelation,
  EngineTravel,
  Enforced,
  PaceBudget,
} from "./types";

// ---------------------------------------------------------------------------
// Promoted spike constants (E1's `spike/ir.ts`, verbatim values)
// ---------------------------------------------------------------------------

/** Pace preset -> per-day budget. Promoted (copied) from the spike rather than
 * imported: `spike/` is frozen as the historical artifact of the benchmark, and
 * a production tune of these numbers must not retroactively edit the record the
 * verdict was made on. `maxActiveMin` is the day SPAN (spike learning 3). */
export const PACE_BUDGETS: Readonly<Record<PacePreset, PaceBudget>> = {
  relaxed: { maxActiveMin: 480, maxEffortPoints: 8, minGapMin: 20 },
  balanced: { maxActiveMin: 600, maxEffortPoints: 12, minGapMin: 10 },
  packed: { maxActiveMin: 720, maxEffortPoints: 16, minGapMin: 0 },
};

export const EFFORT_POINTS: Readonly<Record<Effort, number>> = { low: 1, medium: 2, high: 3 };

/** Drop prices, in the objective's currency (spike/evaluator). A `must` is not
 * priced here at all — dropping one is a hard violation, not a trade (see
 * `dropPenaltyOf`). */
export const DROP_PENALTY_SHOULD = 200;
export const DROP_PENALTY_COULD = 60;

/** Straight-line speed ratio used ONLY to estimate a pair the day's matrix does
 * not contain (a cross-day pair, when costing a `moveDay` proposal). Never used
 * for an emitted plan — see EngineTravel.legsByDay. 6x walking is a coarse
 * urban driving figure; the estimate exists to rank proposals, not to schedule. */
const ESTIMATE_DRIVE_SPEEDUP = 6;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type BuildProblemOptions = {
  /** Travel-model params. Defaults to DEFAULT_SETTINGS overlaid with the doc's
   * own walkMax/driveOverheadMin — the same projection planService uses. */
  settings?: Settings;
  /**
   * Compile `TripStop.hours` (E3's parsed Google payload) into hard hours
   * constraints when the ConstraintSet carries none for that stop. Default ON.
   *
   * Why this lives here and not in `compileFromDoc`: the roadmap parks "hours x
   * weekday -> day-concrete windows" in the compile step, but the compile step
   * is day-agnostic BY DESIGN (see the deliberate omission note at the bottom of
   * constraints/types: DayConstraints carries no weekday, and E5 was left to
   * decide how a label-only day resolves one). This builder is where a day gets
   * a weekday, so it is where hours can become concrete without the constraint
   * model growing a date. Set `false` to get the pre-E5 behaviour (hours are
   * advisory-only, the plan ignores them).
   */
  hoursFromDoc?: boolean;
};

// ---------------------------------------------------------------------------
// Weekday derivation — hoursAdvisory's convention, verbatim
// ---------------------------------------------------------------------------

/** ISO weekday (0 = Monday) for a trip day, or null when the day has none.
 *
 * Parsed at UTC NOON so no local timezone can roll the calendar date backward
 * or forward before the weekday is read off it — the same trick (and the same
 * reason) as hoursAdvisory.ts and JournalSidebar's fmtDayDate. A `dayLabel` day
 * carries an INERT placeholder date (M1.5) and gets null; so does a date string
 * that does not parse. */
export function isoWeekdayOfDay(day: { date: string; dayLabel?: string }): number | null {
  if (day.dayLabel !== undefined) return null;
  const jsDay = new Date(`${day.date}T12:00:00Z`).getUTCDay();
  if (Number.isNaN(jsDay)) return null;
  return googleWeekdayToIso(jsDay);
}

// ---------------------------------------------------------------------------
// Small helpers over Constraint<T>
// ---------------------------------------------------------------------------

const refOf = (path: string, provenance: Provenance): ConstraintRef => ({ path, provenance });

function enforce<T>(c: Constraint<T>, path: string): Enforced<T> {
  return { value: c.value, hard: isHard(c), weight: softWeight(c), ref: refOf(path, c.provenance) };
}

function enforceAs<T, U>(c: Constraint<T>, path: string, value: U): Enforced<U> {
  return { value, hard: isHard(c), weight: softWeight(c), ref: refOf(path, c.provenance) };
}

const LEGACY: Provenance = { source: "legacy" };
const DERIVED: Provenance = { source: "derived" };
const GOOGLE: Provenance = { source: "google" };

function hardFallback<T>(value: T, path: string, provenance: Provenance): Enforced<T> {
  return { value, hard: true, weight: 0, ref: refOf(path, provenance) };
}

function normaliseDuration(d: DurationRange): DurationRange {
  const typicalMin = Math.max(0, d.typicalMin);
  const maxMin = Math.max(typicalMin, Number.isFinite(d.maxMin) ? d.maxMin : typicalMin);
  const minMin = Math.min(Math.max(0, d.minMin), typicalMin);
  return { minMin, typicalMin, maxMin };
}

function dropPenaltyOf(priority: Priority, hard: boolean, weight: number): number {
  if (priority === "must") return hard ? 0 : weight; // hard must = a violation, not a price
  return priority === "should" ? DROP_PENALTY_SHOULD : DROP_PENALTY_COULD;
}

// ---------------------------------------------------------------------------
// buildProblem
// ---------------------------------------------------------------------------

export function buildProblem(
  doc: TripDoc,
  set: ConstraintSet,
  /** One AUTO effective matrix per trip day, positionally aligned with
   * `doc.days`. A day with no stops may pass `{}`. */
  matrices: readonly EffectiveMatrix[],
  opts: BuildProblemOptions = {}
): EngineProblem {
  const settings: Settings = opts.settings ?? {
    ...DEFAULT_SETTINGS,
    walkMax: doc.settings.walkMax,
    driveOverheadMin: doc.settings.driveOverheadMin,
  };
  const hoursFromDoc = opts.hoursFromDoc !== false;

  const keys = stopKeys(doc);
  const weekdays = doc.days.map(isoWeekdayOfDay);
  const D = doc.days.length;

  // ---- nodes ---------------------------------------------------------------
  const nodes: EngineNode[] = [];
  const nodeKeysByDay: string[][] = doc.days.map(() => []);

  doc.days.forEach((day, dayIndex) => {
    day.stops.forEach((stop, stopIdx) => {
      const key = keys[dayIndex][stopIdx];
      nodeKeysByDay[dayIndex].push(key);
      nodes.push(buildNode(key, stop, dayIndex, set, doc, weekdays, hoursFromDoc));
    });
  });

  // ---- days ----------------------------------------------------------------
  const days: EngineDay[] = doc.days.map((day, dayIndex) => {
    const dc = set.days[dayIndex];
    const windowConstraint =
      dc?.window ??
      ({
        value: { startMin: day.dayStartMin, endMin: day.dayEndMin },
        provenance: LEGACY,
        hardness: "hard",
      } as Constraint<Window>);
    let window = enforce(windowConstraint, `days.${dayIndex}.window`);

    // Arrival pins raise the day's floor. HARD pins only: a soft "not before"
    // has no violate-able predicate here without a penalty term the constraint
    // model does not yet feed (nothing emits arrival pins before E7), so a soft
    // pin is deliberately NOT applied rather than silently applied as hard.
    for (const pin of set.trip.party?.arrivalPins ?? []) {
      if (!isHard(pin)) continue;
      if (pin.value.dayIndex !== undefined && pin.value.dayIndex !== dayIndex) continue;
      if (pin.value.notBeforeMin <= window.value.startMin) continue;
      window = {
        value: { startMin: pin.value.notBeforeMin, endMin: window.value.endMin },
        hard: true,
        weight: 0,
        // The BINDING constraint is what a conflict must cite.
        ref: refOf(`trip.party.arrivalPins.${pin.id}`, pin.provenance),
      };
    }

    const blocks: Enforced<Window>[] = [];
    for (const mb of dc?.mealBlocks ?? []) {
      blocks.push(enforce(mb, `days.${dayIndex}.mealBlocks.${mb.id}`));
    }
    for (const qb of set.trip.party?.quietBlocks ?? []) {
      blocks.push(enforce(qb, `trip.party.quietBlocks.${qb.id}`));
    }

    const preset = set.trip.pacePreset;
    const presetBudget = PACE_BUDGETS[preset.value] ?? PACE_BUDGETS.balanced;
    const dayPace = dc?.paceBudget;
    const pace: Enforced<PaceBudget> = dayPace
      ? enforceAs(dayPace, `days.${dayIndex}.paceBudget`, {
          maxActiveMin: dayPace.value.maxActiveMin ?? presetBudget.maxActiveMin,
          maxEffortPoints: dayPace.value.maxEffortPoints ?? presetBudget.maxEffortPoints,
          minGapMin: presetBudget.minGapMin,
        })
      : enforceAs(preset, "trip.pacePreset", presetBudget);

    return {
      index: dayIndex,
      date: day.date,
      ...(day.dayLabel === undefined ? {} : { dayLabel: day.dayLabel }),
      weekday: weekdays[dayIndex],
      window,
      blocks,
      pace,
      nodeKeys: nodeKeysByDay[dayIndex],
    };
  });

  // ---- relations -----------------------------------------------------------
  const known = new Set(nodes.map((n) => n.key));
  const relations: EngineRelation[] = [];
  for (const rel of set.relations) {
    const spec = rel.value;
    const [aKey, bKey] =
      spec.kind === "precedence" ? [spec.beforeId, spec.afterId] : [spec.aId, spec.bId];
    if (!known.has(aKey) || !known.has(bKey) || aKey === bKey) continue;
    relations.push({
      id: rel.id,
      kind: spec.kind,
      aKey,
      bKey,
      hard: isHard(rel),
      weight: softWeight(rel),
      ref: refOf(`relations.${rel.id}`, rel.provenance),
    });
  }

  return {
    version: 1,
    tripId: doc.tripId,
    nodes,
    days,
    relations,
    travel: buildTravel(nodes, D, matrices, settings),
    pacePreset: enforce(set.trip.pacePreset, "trip.pacePreset"),
    settings,
  };
}

function buildNode(
  key: string,
  stop: TripStop,
  dayIndex: number,
  set: ConstraintSet,
  doc: TripDoc,
  weekdays: readonly (number | null)[],
  hoursFromDoc: boolean
): EngineNode {
  const sc = set.stops[key];
  const path = `stops.${key}`;

  const duration: Enforced<DurationRange> = sc
    ? enforceAs(
        sc.duration,
        `${path}.duration`,
        normaliseDuration(sc.duration.value)
      )
    : hardFallback(
        normaliseDuration({
          minMin: stop.durationMin,
          typicalMin: stop.durationMin,
          maxMin: stop.durationMin,
        }),
        `${path}.duration`,
        LEGACY
      );

  const effort: Enforced<Effort> = sc
    ? enforce(sc.effort, `${path}.effort`)
    : hardFallback<Effort>("medium", `${path}.effort`, DERIVED);

  const priority: Enforced<Priority> = sc
    ? enforce(sc.priority, `${path}.priority`)
    : hardFallback<Priority>("must", `${path}.priority`, LEGACY);

  const window = sc?.window ? enforce(sc.window, `${path}.window`) : undefined;
  const isAnchor =
    window !== undefined && window.hard && window.value.startMin === window.value.endMin;

  const pinnedDay: Enforced<number> | undefined = sc?.pinnedDay
    ? enforceAs(sc.pinnedDay, `${path}.pinnedDay`, sc.pinnedDay.value.index)
    : hardFallback(dayIndex, `${path}.pinnedDay`, LEGACY);

  // Hours: the ConstraintSet wins; otherwise E3's parsed payload on the doc,
  // compiled here as a hard `google` fact (see BuildProblemOptions.hoursFromDoc).
  let hoursConstraint: Constraint<WeeklyHours> | undefined = sc?.hours;
  const hoursPath = `${path}.hours`;
  if (!hoursConstraint && hoursFromDoc && stop.hours) {
    hoursConstraint = { value: stop.hours, provenance: GOOGLE, hardness: "hard" };
  }

  let hours: Enforced<DayConcreteHours> | undefined;
  if (hoursConstraint) {
    const weekly = hoursConstraint.value;
    const openByDay = doc.days.map((day, i) => {
      const weekday = weekdays[i];
      if (weekday === null) return null; // no weekday -> hours say nothing (E3 keeps it advisory)
      if (weekly.closedDates?.includes(day.date)) return [];
      return intersectHoursWithWeekday(weekly, weekday);
    });
    if (openByDay.some((o) => o !== null)) {
      const concrete: DayConcreteHours = {
        openByDay,
        ...(weekly.lastEntryMin === undefined ? {} : { lastEntryMin: weekly.lastEntryMin }),
      };
      hours = enforceAs(hoursConstraint, hoursPath, concrete);
    }
  }

  return {
    key,
    stopId: stop.id,
    name: stop.name,
    location: stop.location,
    duration,
    effort,
    effortPoints: EFFORT_POINTS[effort.value] ?? 2,
    priority,
    dropPenalty: dropPenaltyOf(priority.value, priority.hard, priority.weight),
    ...(window ? { window } : {}),
    isAnchor,
    ...(hours ? { hours } : {}),
    ...(pinnedDay ? { pinnedDay } : {}),
  };
}

// ---------------------------------------------------------------------------
// Travel
// ---------------------------------------------------------------------------

function buildTravel(
  nodes: readonly EngineNode[],
  D: number,
  matrices: readonly EffectiveMatrix[],
  settings: Settings
): EngineTravel {
  const n = nodes.length;
  const index: Record<string, number> = {};
  nodes.forEach((node, i) => {
    index[node.key] = i;
  });

  const minutesByDay: Float64Array[] = [];
  const legsByDay: (EffectiveLeg | null)[][] = [];

  for (let d = 0; d < D; d++) {
    const minutes = new Float64Array(n * n);
    const legs: (EffectiveLeg | null)[] = new Array(n * n).fill(null);
    const matrix = matrices[d] ?? {};
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        if (a === b) continue;
        const leg = matrix[nodes[a].stopId]?.[nodes[b].stopId];
        if (leg) {
          legs[a * n + b] = leg;
          minutes[a * n + b] = effectiveMinutes(leg, settings);
        } else {
          minutes[a * n + b] = estimateMinutes(nodes[a].location, nodes[b].location, settings);
        }
      }
    }
    minutesByDay.push(minutes);
    legsByDay.push(legs);
  }

  return { n, index, minutesByDay, legsByDay };
}

/** Straight-line stand-in for a pair the day's matrix does not contain. See
 * ESTIMATE_DRIVE_SPEEDUP — this never reaches a returned plan. */
function estimateMinutes(a: LatLng, b: LatLng, settings: Settings): Minutes {
  const walk = walkMinutes(a, b, settings);
  if (isWalkEligible(walk, settings)) return walk;
  return walk / ESTIMATE_DRIVE_SPEEDUP + settings.driveOverheadMin;
}
