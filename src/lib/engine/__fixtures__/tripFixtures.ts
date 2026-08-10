// E5a test support. Lives in __fixtures__ (not __tests__) so jest does not try
// to run it as a suite. Fixture city only — no network, no key, no spend.

import { compileFromDoc } from "../../constraints/compile";
import type { ConstraintSet, WeeklyHours } from "../../constraints/types";
import { createFixtureAdapter } from "../../maps/fixtureAdapter";
import { FIXTURE_STOPS } from "../../maps/fixtureCity";
import { parseGoogleHours } from "../../maps/openingHours";
import { DEFAULT_SETTINGS, type Settings } from "../../maps/types";
import { buildEffectiveMatrix } from "../../solver/effectiveMatrix";
import type { EffectiveMatrix } from "../../solver/types";
import type { Day } from "../../schedule/types";
import type { TripDay, TripDoc, TripStop } from "../../store/types";
import { buildProblem, type BuildProblemOptions } from "../problem";
import type { EngineProblem } from "../types";

/** Fixture stops that carry NO opening hours — i.e. the OLD constraint class.
 * A stop with hours is, by construction, outside it. */
export const NO_HOURS_IDS = FIXTURE_STOPS.filter((s) => !s.hours).map((s) => s.id);
export const ALL_FIXTURE_IDS = FIXTURE_STOPS.map((s) => s.id);

export function tripStop(id: string, durationMin: number, anchorStartMin?: number): TripStop {
  const f = FIXTURE_STOPS.find((s) => s.id === id);
  if (!f) throw new Error(`no fixture stop ${id}`);
  return {
    id: f.id,
    name: f.name,
    location: f.location,
    durationMin,
    ...(anchorStartMin === undefined ? {} : { anchor: { startMin: anchorStartMin } }),
  };
}

/** A fixture stop WITH its E3 opening hours parsed onto it, the way the pipeline
 * attaches them in production. */
export function tripStopWithHours(
  id: string,
  durationMin: number,
  anchorStartMin?: number
): TripStop {
  const f = FIXTURE_STOPS.find((s) => s.id === id);
  if (!f) throw new Error(`no fixture stop ${id}`);
  const hours = f.hours ? parseGoogleHours(f.hours) : null;
  return {
    ...tripStop(id, durationMin, anchorStartMin),
    ...(hours ? { hours } : {}),
  };
}

/** Same open interval every weekday — the simplest hand-built WeeklyHours. */
export function everyDay(startMin: number, endMin: number, lastEntryMin?: number): WeeklyHours {
  const row = [{ startMin, endMin }];
  return {
    byWeekday: [row, row, row, row, row, row, row],
    ...(lastEntryMin === undefined ? {} : { lastEntryMin }),
  };
}

/** Open on every weekday EXCEPT `closedIsoWeekday` (0 = Monday). */
export function closedOn(closedIsoWeekday: number, startMin: number, endMin: number): WeeklyHours {
  return {
    byWeekday: [0, 1, 2, 3, 4, 5, 6].map((wd) =>
      wd === closedIsoWeekday ? [] : [{ startMin, endMin }]
    ),
  };
}

export function withHours(stop: TripStop, hours: WeeklyHours): TripStop {
  return { ...stop, hours };
}

export function docOf(days: TripDay[], tripId = "engine-test"): TripDoc {
  return {
    tripId,
    days,
    settings: { walkMax: 10, driveOverheadMin: 10 },
    legOverrides: [],
  };
}

export function settingsOf(doc: TripDoc): Settings {
  return {
    ...DEFAULT_SETTINGS,
    walkMax: doc.settings.walkMax,
    driveOverheadMin: doc.settings.driveOverheadMin,
  };
}

/** The AUTO effective matrix per day — the SAME construction planService does
 * (fixture provider drive matrix -> buildEffectiveMatrix). */
export async function matricesFor(doc: TripDoc): Promise<EffectiveMatrix[]> {
  const provider = createFixtureAdapter();
  const settings = settingsOf(doc);
  const out: EffectiveMatrix[] = [];
  for (const day of doc.days) {
    if (day.stops.length === 0) {
      out.push({});
      continue;
    }
    const drive = await provider.getTravelMatrix(
      day.stops.map((s) => ({ id: s.id, location: s.location })),
      "driving"
    );
    const locations = Object.fromEntries(day.stops.map((s) => [s.id, s.location]));
    out.push(buildEffectiveMatrix(drive, locations, settings));
  }
  return out;
}

export async function problemFor(
  doc: TripDoc,
  opts?: BuildProblemOptions,
  set?: ConstraintSet
): Promise<EngineProblem> {
  return buildProblem(doc, set ?? compileFromDoc(doc), await matricesFor(doc), opts);
}

/** The old solver's `Day` view of a trip day — what `planDay` consumes. */
export function legacyDay(doc: TripDoc, dayIndex: number): Day {
  const d = doc.days[dayIndex];
  return {
    date: d.date,
    dayStartMin: d.dayStartMin,
    dayEndMin: d.dayEndMin,
    stops: d.stops.map((s) => ({
      id: s.id,
      name: s.name,
      durationMin: s.durationMin,
      ...(s.anchor ? { anchor: s.anchor } : {}),
    })),
    ...(d.precedence ? { precedence: d.precedence } : {}),
  };
}
