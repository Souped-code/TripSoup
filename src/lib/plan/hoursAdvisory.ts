// E3 — advisory-only opening-hours check on the CURRENT engine. The solver
// itself (src/lib/schedule/schedule.ts) never reads TripStop.hours (E5's
// job — full window-constrained solving); this module only WARNS, after the
// fact, when an already-computed plan lands a visit outside its stop's
// hours. Pure, no I/O, never throws.
//
// Called from TWO places that each freshly compute a full set of day plans
// and must persist them — planStore.savePlanned (every explicit re-plan) and
// pipeline.ts's initial paste flow (the first solve a trip ever gets) — both
// BEFORE handing the plans to persistPlanned/stampPlan. Deliberately NOT
// folded into stampPlan/persistPlanned themselves: planStore.test.ts's
// "stampPlan is pure" test asserts `persistPlanned` stores the given `days`
// array BY REFERENCE, unmodified — this module must stay a step callers opt
// into, not something the storage chokepoint does silently.

import type { DayPlan } from "../schedule/types";
import type { TripDay, TripDoc } from "../store/types";
import type { Window } from "../constraints/types";
import { googleWeekdayToIso, intersectHoursWithWeekday } from "../maps/openingHours";

const ISO_WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

function fmtHM(min: number): string {
  const wrapped = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Parsed at UTC noon — mirrors JournalSidebar.tsx's fmtDayDate — so no local
// timezone can roll the calendar date backward/forward a day before we read
// its weekday off it. getUTCDay() returns 0=Sunday..6=Saturday, the same
// convention Google uses, so it goes through the same conversion helper.
// Returns null for an unparseable date string — an Invalid Date yields
// getUTCDay() = NaN, which would otherwise flow into ISO_WEEKDAY_NAMES[NaN]
// and produce "looks closed on undefineds" in a persisted note (E3 audit,
// minor 2 — reachable only via a hand-crafted PUT, but a nonsense note is a
// nonsense note). Callers skip hours checks for such days, same as dayLabel.
function isoWeekdayOfDate(date: string): number | null {
  const jsDay = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (Number.isNaN(jsDay)) return null;
  return googleWeekdayToIso(jsDay);
}

/** One journal-voice note for a single visit, or null when it fits. Exported
 * for direct unit testing of the wording/branches without needing a full
 * TripDoc + DayPlan. */
export function hoursNoteFor(
  stopName: string,
  weekday: number,
  startMin: number,
  departMin: number,
  open: readonly Window[]
): string | null {
  if (open.length === 0) {
    return `Heads up — ${stopName} looks closed on ${ISO_WEEKDAY_NAMES[weekday]}s.`;
  }
  const fits = open.some((w) => startMin >= w.startMin && departMin <= w.endMin);
  if (fits) return null;

  const lastClose = Math.max(...open.map((w) => w.endMin));
  const firstOpen = Math.min(...open.map((w) => w.startMin));

  if (startMin >= lastClose) {
    return `Heads up — ${stopName} closes at ${fmtHM(lastClose)}, before you'd arrive.`;
  }
  if (departMin <= firstOpen) {
    return `Heads up — ${stopName} doesn't open until ${fmtHM(firstOpen)}.`;
  }
  const containing = open.find((w) => startMin >= w.startMin && startMin < w.endMin);
  if (containing) {
    return `Heads up — ${stopName} closes at ${fmtHM(containing.endMin)}, before your visit ends.`;
  }
  return `Heads up — ${stopName} is closed at the time you're scheduled to be there.`;
}

/** For each ok-status day plan, checks every entry's [startMin, departMin]
 * against its stop's hours intersected with that day's weekday, and appends
 * any resulting advisories to `marginNotes`. Never mutates plan status.
 *
 * The weekday is derived from `day.date` ONLY when the day has no
 * `dayLabel` — a dayLabel means `date` is an INERT placeholder (M1.5: the
 * run's reference-today, not a real trip date), so checking hours against it
 * would be a confident lie about which day of the week the visit falls on.
 * Hours checks are SKIPPED entirely for such a day.
 *
 * Returns the SAME array reference when nothing changed (no doc in this
 * milestone's fixtures/tests relies on that, but it keeps this a true no-op
 * for the overwhelmingly common case of no stop carrying `hours` at all). */
export function applyHoursAdvisories(doc: TripDoc, days: DayPlan[]): DayPlan[] {
  let changed = false;
  const next = days.map((plan, i) => {
    if (plan.status !== "ok") return plan;
    const day: TripDay | undefined = doc.days[i];
    if (!day) return plan;
    if (day.dayLabel !== undefined) return plan; // M1.5 placeholder date — skip

    const weekday = isoWeekdayOfDate(day.date);
    if (weekday === null) return plan; // unparseable date — no weekday, no check
    const stopsById = new Map(day.stops.map((s) => [s.id, s]));
    const notes: string[] = [];
    for (const entry of plan.entries) {
      const stop = stopsById.get(entry.stopId);
      if (!stop?.hours) continue;
      const open = intersectHoursWithWeekday(stop.hours, weekday);
      const note = hoursNoteFor(stop.name, weekday, entry.startMin, entry.departMin, open);
      if (note) notes.push(note);
    }
    if (notes.length === 0) return plan;
    changed = true;
    return { ...plan, marginNotes: [...(plan.marginNotes ?? []), ...notes] };
  });
  return changed ? next : days;
}
