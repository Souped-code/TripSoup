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

// A manualOrder is honored only if it is an exact permutation of the day's stop
// ids — same size, same set, no duplicates, no unknowns. Anything else (a stale
// order from before the stop list changed) returns null → solver resumes.
function validManualOrder(
  manualOrder: string[] | undefined,
  stops: { id: string }[]
): string[] | null {
  if (!manualOrder || manualOrder.length !== stops.length || stops.length === 0) return null;
  const ids = new Set(stops.map((s) => s.id));
  const seen = new Set<string>();
  for (const id of manualOrder) {
    if (!ids.has(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return manualOrder;
}

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
    precedence: tripDay.precedence,
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

  // Manual order (D2.3, audit finding 12): when the user has pinned an order via
  // drag-reorder, skip the solver entirely and retime THAT exact order. Only a
  // valid permutation of this day's stop ids is honored — a stale/partial
  // manualOrder (stops added or removed since) is ignored and the solver resumes
  // ownership, rather than silently planning a wrong subset.
  const manualOrder = validManualOrder(tripDay.manualOrder, day.stops);
  const plan = manualOrder
    ? rescheduleDay(day, manualOrder, auto, settings, "manual")
    : planDay(day, auto, settings);
  if (plan.status !== "ok") return plan; // e.g. a manual order that breaks an anchor → infeasible

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
  const retimed = rescheduleDay(day, plan.order, toggled, settings, plan.quality);
  // Re-timing walks the same order, so any margin notes still apply — carry them.
  if (retimed.status === "ok" && plan.marginNotes) {
    return { ...retimed, marginNotes: plan.marginNotes };
  }
  return retimed;
}
