// E3 — parses Google Places API (New) `regularOpeningHours` payloads
// (resolvePlaces.ts's `Stop.openingHours: unknown`) into this repo's
// WeeklyHours shape (src/lib/constraints/types.ts). Golden-tested against
// FIVE captured real payloads in __fixtures__/hours/ — see
// __tests__/openingHours.test.ts for exactly which shapes were observed in
// the wild (including one whose filename suggests a semantic its captured
// JSON does not actually have, and one whose hours are simply absent —
// real-world payload variance is the point of this module).
//
// ---------------------------------------------------------------------------
// THE CONVENTION MISMATCH (read this before touching anything below)
// ---------------------------------------------------------------------------
// Google's `open.day` / `close.day` are 0=Sunday..6=Saturday. This repo's
// WeeklyHours.byWeekday is 0=Monday..6=Sunday (ISO), matching every other
// day-index in src/lib/constraints/types.ts. Converting the wrong direction
// silently shifts every trip's hours by a day — the worst silent bug this
// milestone could ship. googleWeekdayToIso/isoWeekdayToGoogle below are the
// ONLY place this conversion happens; every caller (this file, hoursAdvisory)
// must go through them, and their round-trip is explicitly unit-tested.
//
// ---------------------------------------------------------------------------
// NEVER THROWS
// ---------------------------------------------------------------------------
// parseGoogleHours returns null for anything it cannot confidently read —
// absent (null/undefined), the wrong shape, or a periods array that yields
// nothing usable. A single malformed payload must never take down a resolve.
//
// ---------------------------------------------------------------------------
// E5 TODO — timezone v1 (see the roadmap's E3 section)
// ---------------------------------------------------------------------------
// This module has no concept of the place's UTC offset — hours are treated as
// place-local minutes, and schedule math throughout the app is naive local
// minutes, so a SINGLE-timezone trip is internally consistent by
// construction. A trip that crosses timezones is NOT detected here. E5 owns:
// capturing utcOffsetMinutes at resolve time, and downgrading hours checks to
// advisory-only (+ an explicit margin note) the instant a solve spans more
// than one offset. Until then, a mixed-timezone trip's hours advisories are
// silently place-local-correct-but-potentially-misleading relative to the
// traveller's actual clock — acceptable for v1 per the roadmap, not fixed
// here.

import type { Minutes, WeeklyHours, Window } from "../constraints/types";

// ---------------------------------------------------------------------------
// Weekday convention conversion — THE thing that must never be gotten wrong.
// ---------------------------------------------------------------------------

/** Google's 0=Sunday..6=Saturday -> this repo's 0=Monday..6=Sunday (ISO). */
export function googleWeekdayToIso(googleDay: number): number {
  const g = ((googleDay % 7) + 7) % 7; // defensive wrap for out-of-range input
  return (g + 6) % 7;
}

/** The inverse of googleWeekdayToIso — this repo's ISO index -> Google's. */
export function isoWeekdayToGoogle(isoDay: number): number {
  const i = ((isoDay % 7) + 7) % 7;
  return (i + 1) % 7;
}

// ---------------------------------------------------------------------------
// Raw period reading
// ---------------------------------------------------------------------------

type RawTimeOfDay = { day: number; hour: number; minute: number };

function isFiniteInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n);
}

/** Reads one `open`/`close` sub-object. Handles the Places API (New) shape
 * (`{day,hour,minute}`, all numbers — the only shape in the captured corpus)
 * and defensively falls back to the legacy Places API's `{day,time:"HHMM"}`
 * string shape, in case an older payload ever reaches here. Returns null for
 * anything else, rather than throwing or guessing. */
function readTimeOfDay(raw: unknown): RawTimeOfDay | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!isFiniteInt(o.day) || o.day < 0 || o.day > 6) return null;

  if (isFiniteInt(o.hour) && isFiniteInt(o.minute)) {
    if (o.hour < 0 || o.hour > 23 || o.minute < 0 || o.minute > 59) return null;
    return { day: o.day, hour: o.hour, minute: o.minute };
  }
  if (typeof o.time === "string" && /^\d{4}$/.test(o.time)) {
    const hour = parseInt(o.time.slice(0, 2), 10);
    const minute = parseInt(o.time.slice(2), 10);
    if (hour > 23 || minute > 59) return null;
    return { day: o.day, hour, minute };
  }
  return null;
}

function minutesOf(t: RawTimeOfDay): Minutes {
  return t.hour * 60 + t.minute;
}

// ---------------------------------------------------------------------------
// parseGoogleHours
// ---------------------------------------------------------------------------

/**
 * Google's `regularOpeningHours` (the object itself — `{openNow, periods,
 * weekdayDescriptions, ...}`, exactly what resolvePlaces.ts stores as
 * `Stop.openingHours`) -> WeeklyHours, or null when the input is absent or
 * cannot be confidently read.
 *
 * Handles, per the E3 plan:
 *  - normal single-interval-per-day periods
 *  - split shifts (multiple periods for the same weekday — e.g. lunch +
 *    dinner service)
 *  - 24h ("open always"): Google's documented shape is a SINGLE period whose
 *    `open` is present and whose `close` is absent entirely. Handled
 *    regardless of which day/time the lone `open` names (the only honest
 *    reading of "one period, no close at all" is "never closes"), and
 *    defensively accepts either a genuinely-missing `close` key or an
 *    explicit `close: null` as the same signal.
 *  - over-midnight periods (`close.day !== open.day`): split into
 *    `[openMin, 1440)` on the open day and `[0, closeMin)` on the close day.
 *  - malformed/absent input, or a periods array that yields nothing usable:
 *    null.
 *
 * Does NOT populate `lastEntryMin` — Google's `regularOpeningHours` carries
 * no distinct "last entry" field (confirmed against the captured corpus,
 * including the fixture literally named for that case); a real "last entry"
 * signal would need a different Places field this milestone does not fetch.
 * Left undefined rather than guessed.
 */
export function parseGoogleHours(raw: unknown): WeeklyHours | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return null;

  const periods = (raw as Record<string, unknown>).periods;
  if (!Array.isArray(periods) || periods.length === 0) return null;

  // 24h special case — see the doc comment above. Exactly one period, an
  // open time, and NO usable close.
  if (periods.length === 1) {
    const p = periods[0];
    if (p && typeof p === "object") {
      const rec = p as Record<string, unknown>;
      const open = readTimeOfDay(rec.open);
      const hasClose =
        Object.prototype.hasOwnProperty.call(rec, "close") && rec.close != null;
      if (open && !hasClose) {
        const allDay: Window[] = [{ startMin: 0, endMin: 1440 }];
        return { byWeekday: [allDay, allDay, allDay, allDay, allDay, allDay, allDay] };
      }
    }
  }

  const byWeekday: Window[][] = [[], [], [], [], [], [], []];
  let anyValid = false;

  for (const rawPeriod of periods) {
    if (!rawPeriod || typeof rawPeriod !== "object") continue;
    const p = rawPeriod as Record<string, unknown>;

    const open = readTimeOfDay(p.open);
    if (!open) continue; // no usable open time — skip this period, keep going

    // A no-close period inside a MULTI-period list is ambiguous (the
    // documented 24h shape is handled above as a dedicated single-period
    // case) — skip rather than guess at an unbounded window.
    if (p.close == null) continue;
    const close = readTimeOfDay(p.close);
    if (!close) continue;

    const openIso = googleWeekdayToIso(open.day);
    let closeIso = googleWeekdayToIso(close.day);
    const openMin = minutesOf(open);
    let closeMin = minutesOf(close);

    if (closeIso === openIso && closeMin <= openMin) {
      // Same reported day but close <= open: a wrap not reflected in
      // `close.day` (defensive safety net — never observed in the captured
      // corpus, but the alternative is silently fabricating a
      // negative-length window).
      closeIso = (openIso + 1) % 7;
    }

    if (closeIso === openIso) {
      byWeekday[openIso].push({ startMin: openMin, endMin: closeMin });
    } else {
      // Over-midnight: split into [open, 1440) on the open day and
      // [0, close) on the close day, per the E3 plan.
      byWeekday[openIso].push({ startMin: openMin, endMin: 1440 });
      byWeekday[closeIso].push({ startMin: 0, endMin: closeMin });
    }
    anyValid = true;
  }

  if (!anyValid) return null; // a periods array existed but nothing in it was usable

  for (const day of byWeekday) day.sort((a, b) => a.startMin - b.startMin);

  return { byWeekday };
}

// ---------------------------------------------------------------------------
// intersectHoursWithWeekday
// ---------------------------------------------------------------------------

/** The open intervals for one ISO weekday (0=Monday..6=Sunday — the SAME
 * convention as WeeklyHours.byWeekday itself; callers holding a Google-
 * convention day must convert with googleWeekdayToIso first). Out-of-range
 * input returns an empty (closed) array rather than throwing. */
export function intersectHoursWithWeekday(hours: WeeklyHours, weekday: number): Window[] {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return [];
  return [...(hours.byWeekday[weekday] ?? [])];
}

// ---------------------------------------------------------------------------
// Runtime shape validation — used by app/api/trips/[id]/route.ts's
// malformed() so a hand-crafted or corrupted TripStop.hours is rejected at
// the PUT boundary rather than silently misread downstream.
// ---------------------------------------------------------------------------

export function isValidWeeklyHoursShape(value: unknown): value is WeeklyHours {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;

  if (!Array.isArray(v.byWeekday) || v.byWeekday.length !== 7) return false;
  for (const day of v.byWeekday) {
    if (!Array.isArray(day)) return false;
    for (const w of day) {
      if (!w || typeof w !== "object") return false;
      const win = w as Record<string, unknown>;
      if (typeof win.startMin !== "number" || !Number.isFinite(win.startMin)) return false;
      if (typeof win.endMin !== "number" || !Number.isFinite(win.endMin)) return false;
    }
  }

  if (
    v.lastEntryMin !== undefined &&
    (typeof v.lastEntryMin !== "number" || !Number.isFinite(v.lastEntryMin))
  ) {
    return false;
  }
  if (v.closedDates !== undefined) {
    if (!Array.isArray(v.closedDates) || v.closedDates.some((d) => typeof d !== "string")) {
      return false;
    }
  }

  return true;
}
