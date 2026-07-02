// Compute a day's plan from a trip document. Server-side only.
// Ordering comes from the solver on the AUTO effective matrix (§2: the
// solver's choice sets the ordering); persisted user toggles then re-time the
// fixed order (never re-order). Deterministic solver means recomputing a plan
// from the document always reproduces it — plans are not persisted.

import { getMapsProvider } from "./config";
import { DEFAULT_SETTINGS, type Settings } from "./maps/types";
import { buildEffectiveMatrix } from "./solver/effectiveMatrix";
import { applyLegModes, planDay, rescheduleDay } from "./schedule/schedule";
import type { Day, DayPlan } from "./schedule/types";
import type { TripDoc } from "./store/types";

export function settingsOf(doc: TripDoc): Settings {
  return {
    ...DEFAULT_SETTINGS,
    walkMax: doc.settings.walkMax,
    driveOverheadMin: doc.settings.driveOverheadMin,
  };
}

export async function planTripDay(doc: TripDoc, dayIndex: number): Promise<DayPlan> {
  const tripDay = doc.days[dayIndex];
  if (!tripDay) throw new Error(`no day at index ${dayIndex}`);
  const settings = settingsOf(doc);

  const day: Day = {
    date: tripDay.date,
    dayStartMin: tripDay.dayStartMin,
    dayEndMin: tripDay.dayEndMin,
    stops: tripDay.stops.map((s) => ({
      id: s.id,
      name: s.name,
      durationMin: s.durationMin,
      anchor: s.anchor,
    })),
  };
  if (day.stops.length === 0) {
    return {
      status: "ok",
      order: [],
      entries: [],
      legs: [],
      quality: "optimal",
      totalTravelMin: 0,
      daySlackMin: tripDay.dayEndMin - tripDay.dayStartMin,
    };
  }

  const provider = getMapsProvider();
  const driveMatrix = await provider.getTravelMatrix(
    tripDay.stops.map((s) => ({ id: s.id, location: s.location })),
    "driving"
  );
  const locations = Object.fromEntries(tripDay.stops.map((s) => [s.id, s.location]));
  const auto = buildEffectiveMatrix(driveMatrix, locations, settings);

  const plan = planDay(day, auto, settings);
  if (plan.status !== "ok") return plan;

  const overrides = doc.legOverrides.filter((o) => o.dayIndex === dayIndex);
  if (overrides.length === 0) return plan;

  // Drop overrides that no longer correspond to a leg of the chosen order or
  // are no longer eligible (stops changed since the toggle) — §8: validate at
  // the boundary, surface the rest.
  const legPairs = new Set(plan.legs.map((l) => `${l.fromId}|${l.toId}`));
  const applicable = overrides.filter(
    (o) => legPairs.has(`${o.fromId}|${o.toId}`) && (o.mode === "drive" || auto[o.fromId][o.toId].walkMin !== null)
  );
  if (applicable.length === 0) return plan;

  const toggled = applyLegModes(auto, applicable);
  return rescheduleDay(day, plan.order, toggled, settings, plan.quality);
}
