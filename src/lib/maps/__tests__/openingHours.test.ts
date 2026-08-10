// E3 — golden tests against FIVE captured real Google payloads
// (__fixtures__/hours/*.json), plus the weekday-convention round-trip and the
// over-midnight split (synthesized: none of the five captures happen to
// contain a genuine over-midnight period — see that describe block for why).
//
// Every expected array below is HAND-DERIVED from the fixture JSON's actual
// content — not computed by calling the parser under test, and NOT assumed
// from the fixture's filename. That distinction matters here: reading the
// fixtures closely, `monday-closed-museum.json`'s captured payload is, in
// fact, open every day including Monday (a real Google Places capture can
// simply not match what its filename suggests it should demonstrate), while
// `split-shift-restaurant.json` is the one that turns out to be closed
// Mondays AND Sundays. `over-midnight-bar.json`'s capture has `hours: null`
// — the real "absent hours" case the E3 plan calls out. Trusting the
// filename instead of the JSON here would have shipped wrong goldens.

import {
  googleWeekdayToIso,
  intersectHoursWithWeekday,
  isValidWeeklyHoursShape,
  isoWeekdayToGoogle,
  parseGoogleHours,
} from "../openingHours";
import type { WeeklyHours, Window } from "../../constraints/types";

import mondayClosedMuseum from "../__fixtures__/hours/monday-closed-museum.json";
import splitShiftRestaurant from "../__fixtures__/hours/split-shift-restaurant.json";
import open24h from "../__fixtures__/hours/open-24h.json";
import overMidnightBar from "../__fixtures__/hours/over-midnight-bar.json";
import lastEntryAttraction from "../__fixtures__/hours/last-entry-attraction.json";

const win = (startMin: number, endMin: number): Window => ({ startMin, endMin });
const EMPTY: Window[] = [];

describe("parseGoogleHours — golden fixtures", () => {
  it("monday-closed-museum.json (actually: National Gallery Singapore, open every day 10:00-19:00 incl. Monday)", () => {
    const parsed = parseGoogleHours(mondayClosedMuseum.hours);
    const everyDay = win(600, 1140); // 10:00-19:00
    const expected: WeeklyHours = {
      byWeekday: [
        [everyDay], // Mon
        [everyDay], // Tue
        [everyDay], // Wed
        [everyDay], // Thu
        [everyDay], // Fri
        [everyDay], // Sat
        [everyDay], // Sun
      ],
    };
    expect(parsed).toEqual(expected);
  });

  it("split-shift-restaurant.json (Burnt Ends: closed Mon+Sun, split lunch/dinner Thu-Sat, dinner-only Tue-Wed)", () => {
    const parsed = parseGoogleHours(splitShiftRestaurant.hours);
    const lunch = win(720, 870); // 12:00-14:30
    const dinner = win(1080, 1380); // 18:00-23:00
    const expected: WeeklyHours = {
      byWeekday: [
        EMPTY, // Mon — closed
        [dinner], // Tue
        [dinner], // Wed
        [lunch, dinner], // Thu
        [lunch, dinner], // Fri
        [lunch, dinner], // Sat
        EMPTY, // Sun — closed
      ],
    };
    expect(parsed).toEqual(expected);
  });

  it("open-24h.json (Mustafa Centre: single no-close period -> all 7 days [0,1440))", () => {
    const parsed = parseGoogleHours(open24h.hours);
    const allDay = [win(0, 1440)];
    const expected: WeeklyHours = {
      byWeekday: [allDay, allDay, allDay, allDay, allDay, allDay, allDay],
    };
    expect(parsed).toEqual(expected);
  });

  it("over-midnight-bar.json (28 Hongkong St: hours is null — the real absent case) -> null", () => {
    expect(overMidnightBar.hours).toBeNull(); // sanity: this really is the absent-payload fixture
    expect(parseGoogleHours(overMidnightBar.hours)).toBeNull();
  });

  it("last-entry-attraction.json (Flower Dome, open every day 09:00-21:00 — no distinct last-entry field in the raw payload)", () => {
    const parsed = parseGoogleHours(lastEntryAttraction.hours);
    const everyDay = [win(540, 1260)]; // 09:00-21:00
    const expected: WeeklyHours = {
      byWeekday: [everyDay, everyDay, everyDay, everyDay, everyDay, everyDay, everyDay],
    };
    expect(parsed).toEqual(expected);
    // Confirms the documented decision in openingHours.ts: lastEntryMin is
    // never populated by this parser (Google's regularOpeningHours carries no
    // such field), even for a fixture named for that scenario.
    expect(parsed?.lastEntryMin).toBeUndefined();
  });
});

describe("parseGoogleHours — weekday convention (the mismatch the E3 plan warns about)", () => {
  it("googleWeekdayToIso: Google's Monday(1) -> ISO index 0, Sunday(0) -> ISO index 6", () => {
    expect(googleWeekdayToIso(1)).toBe(0); // Monday
    expect(googleWeekdayToIso(2)).toBe(1); // Tuesday
    expect(googleWeekdayToIso(3)).toBe(2); // Wednesday
    expect(googleWeekdayToIso(4)).toBe(3); // Thursday
    expect(googleWeekdayToIso(5)).toBe(4); // Friday
    expect(googleWeekdayToIso(6)).toBe(5); // Saturday
    expect(googleWeekdayToIso(0)).toBe(6); // Sunday
  });

  it("isoWeekdayToGoogle is the exact inverse", () => {
    expect(isoWeekdayToGoogle(0)).toBe(1); // Monday
    expect(isoWeekdayToGoogle(6)).toBe(0); // Sunday
  });

  it("round-trips in both directions for every day of the week", () => {
    for (let g = 0; g <= 6; g++) {
      expect(isoWeekdayToGoogle(googleWeekdayToIso(g))).toBe(g);
    }
    for (let iso = 0; iso <= 6; iso++) {
      expect(googleWeekdayToIso(isoWeekdayToGoogle(iso))).toBe(iso);
    }
  });
});

describe("parseGoogleHours — over-midnight split (synthesized)", () => {
  // None of the five captured fixtures happen to contain a real over-midnight
  // period (over-midnight-bar.json's actual capture has hours:null instead —
  // see the golden test above), so this golden is hand-built to exercise the
  // split behaviour the E3 plan specifies: a bar open Friday 22:00 through
  // Saturday 02:00 -> [22:00,24:00) on Friday + [00:00,02:00) on Saturday.
  it("splits a Friday-22:00-to-Saturday-02:00 period across both days", () => {
    const raw = {
      periods: [
        {
          open: { day: 5, hour: 22, minute: 0 }, // Friday (Google)
          close: { day: 6, hour: 2, minute: 0 }, // Saturday (Google)
        },
      ],
    };
    const parsed = parseGoogleHours(raw);
    const fridayIso = googleWeekdayToIso(5); // 4
    const saturdayIso = googleWeekdayToIso(6); // 5
    expect(fridayIso).toBe(4);
    expect(saturdayIso).toBe(5);
    expect(parsed?.byWeekday[fridayIso]).toEqual([win(1320, 1440)]);
    expect(parsed?.byWeekday[saturdayIso]).toEqual([win(0, 120)]);
    // every other day stayed closed
    for (let i = 0; i < 7; i++) {
      if (i === fridayIso || i === saturdayIso) continue;
      expect(parsed?.byWeekday[i]).toEqual([]);
    }
  });

  it("defensively wraps a same-day close<=open pair to the next day instead of fabricating a negative window", () => {
    const raw = {
      periods: [{ open: { day: 2, hour: 22, minute: 0 }, close: { day: 2, hour: 2, minute: 0 } }],
    };
    const parsed = parseGoogleHours(raw);
    const openIso = googleWeekdayToIso(2);
    const closeIso = (openIso + 1) % 7;
    expect(parsed?.byWeekday[openIso]).toEqual([win(1320, 1440)]);
    expect(parsed?.byWeekday[closeIso]).toEqual([win(0, 120)]);
  });
});

describe("parseGoogleHours — split shifts (multiple periods per day)", () => {
  it("keeps both intervals for a day with a lunch and dinner service, sorted by start time", () => {
    const raw = {
      periods: [
        { open: { day: 4, hour: 18, minute: 0 }, close: { day: 4, hour: 23, minute: 0 } }, // dinner listed first
        { open: { day: 4, hour: 12, minute: 0 }, close: { day: 4, hour: 14, minute: 30 } }, // lunch listed second
      ],
    };
    const parsed = parseGoogleHours(raw);
    const iso = googleWeekdayToIso(4); // Thursday
    expect(parsed?.byWeekday[iso]).toEqual([win(720, 870), win(1080, 1380)]);
  });
});

describe("parseGoogleHours — never throws, absent/malformed -> null", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "not an object"],
    ["an array", [1, 2, 3]],
    ["an empty object", {}],
    ["periods not an array", { periods: "nope" }],
    ["an empty periods array", { periods: [] }],
    ["periods full of garbage entries", { periods: [null, 42, "x", {}, { open: "nope" }] }],
    ["a period with an out-of-range day", { periods: [{ open: { day: 9, hour: 0, minute: 0 }, close: { day: 9, hour: 1, minute: 0 } }] }],
    ["a period with an out-of-range hour", { periods: [{ open: { day: 1, hour: 25, minute: 0 }, close: { day: 1, hour: 26, minute: 0 } }] }],
  ])("%s -> null, does not throw", (_label, input) => {
    expect(() => parseGoogleHours(input)).not.toThrow();
    expect(parseGoogleHours(input)).toBeNull();
  });

  it("a multi-period list where one period has no close is skipped, not treated as 24h", () => {
    const raw = {
      periods: [
        { open: { day: 1, hour: 9, minute: 0 } }, // no close — ambiguous in a multi-period list
        { open: { day: 2, hour: 9, minute: 0 }, close: { day: 2, hour: 17, minute: 0 } },
      ],
    };
    const parsed = parseGoogleHours(raw);
    expect(parsed?.byWeekday[googleWeekdayToIso(1)]).toEqual([]); // the no-close period was skipped
    expect(parsed?.byWeekday[googleWeekdayToIso(2)]).toEqual([win(540, 1020)]);
  });

  it("falls back to the legacy {day,time:'HHMM'} shape defensively", () => {
    const raw = {
      periods: [{ open: { day: 1, time: "0900" }, close: { day: 1, time: "1700" } }],
    };
    const parsed = parseGoogleHours(raw);
    expect(parsed?.byWeekday[googleWeekdayToIso(1)]).toEqual([win(540, 1020)]);
  });
});

describe("intersectHoursWithWeekday", () => {
  const hours: WeeklyHours = {
    byWeekday: [[win(600, 1140)], [], [win(720, 870), win(1080, 1380)], [], [], [], []],
  };

  it("returns the exact intervals for a valid ISO weekday index", () => {
    expect(intersectHoursWithWeekday(hours, 0)).toEqual([win(600, 1140)]);
    expect(intersectHoursWithWeekday(hours, 2)).toEqual([win(720, 870), win(1080, 1380)]);
    expect(intersectHoursWithWeekday(hours, 1)).toEqual([]);
  });

  it("returns [] for an out-of-range weekday rather than throwing", () => {
    expect(intersectHoursWithWeekday(hours, -1)).toEqual([]);
    expect(intersectHoursWithWeekday(hours, 7)).toEqual([]);
    expect(intersectHoursWithWeekday(hours, 1.5)).toEqual([]);
  });

  it("returns a copy, not the live array (callers cannot mutate the source hours)", () => {
    const result = intersectHoursWithWeekday(hours, 0);
    result.push(win(0, 1));
    expect(hours.byWeekday[0]).toEqual([win(600, 1140)]);
  });
});

describe("isValidWeeklyHoursShape", () => {
  it("accepts a well-formed WeeklyHours", () => {
    const valid: WeeklyHours = { byWeekday: [[], [], [], [], [], [], []] };
    expect(isValidWeeklyHoursShape(valid)).toBe(true);
    expect(
      isValidWeeklyHoursShape({
        byWeekday: [[win(600, 1140)], [], [], [], [], [], []],
        lastEntryMin: 990,
        closedDates: ["2026-12-25"],
      })
    ).toBe(true);
  });

  it.each([
    ["null", null],
    ["not an object", "nope"],
    ["byWeekday missing", {}],
    ["byWeekday wrong length", { byWeekday: [[], []] }],
    ["byWeekday element not an array", { byWeekday: [null, [], [], [], [], [], []] }],
    [
      "a window with a non-numeric startMin",
      { byWeekday: [[{ startMin: "600", endMin: 1140 }], [], [], [], [], [], []] },
    ],
    [
      "a window missing endMin",
      { byWeekday: [[{ startMin: 600 }], [], [], [], [], [], []] },
    ],
    [
      "lastEntryMin not a number",
      { byWeekday: [[], [], [], [], [], [], []], lastEntryMin: "990" },
    ],
    [
      "closedDates not an array of strings",
      { byWeekday: [[], [], [], [], [], [], []], closedDates: [123] },
    ],
  ])("rejects: %s", (_label, junk) => {
    expect(isValidWeeklyHoursShape(junk)).toBe(false);
  });
});
