// E3 — advisory opening-hours warnings, unit-tested directly against the
// pure functions (no async solve needed to exercise the branches). See
// src/lib/__tests__/planStore.test.ts for an end-to-end savePlanned test.

import { applyHoursAdvisories, hoursNoteFor } from "../hoursAdvisory";
import type { DayPlan, PlanEntry } from "../../schedule/types";
import type { TripDoc } from "../../store/types";
import type { WeeklyHours } from "../../constraints/types";

// 2026-03-16 is a real, verified Monday (ISO weekday index 0).
const A_MONDAY = "2026-03-16";
// 2026-03-17 is the following Tuesday (ISO weekday index 1).
const A_TUESDAY = "2026-03-17";

const CLOSED_MONDAYS: WeeklyHours = {
  byWeekday: [
    [], // Mon
    [{ startMin: 540, endMin: 1020 }], // Tue 09:00-17:00
    [{ startMin: 540, endMin: 1020 }], // Wed
    [{ startMin: 540, endMin: 1020 }], // Thu
    [{ startMin: 540, endMin: 1020 }], // Fri
    [{ startMin: 540, endMin: 1020 }], // Sat
    [{ startMin: 540, endMin: 1020 }], // Sun
  ],
};

const entry = (stopId: string, startMin: number, departMin: number): PlanEntry => ({
  stopId,
  kind: "flexible",
  arriveMin: startMin,
  startMin,
  departMin,
  waitMin: 0,
});

type OkDayPlan = Extract<DayPlan, { status: "ok" }>;

const okPlan = (entries: PlanEntry[]): OkDayPlan => ({
  status: "ok",
  order: entries.map((e) => e.stopId),
  entries,
  legs: [],
  quality: "optimal",
  totalTravelMin: 0,
  daySlackMin: 0,
});

function docWithStop(
  date: string,
  opts: { dayLabel?: string; hours?: WeeklyHours; startMin?: number; departMin?: number } = {}
): TripDoc {
  return {
    tripId: "t-hours",
    days: [
      {
        date,
        ...(opts.dayLabel !== undefined ? { dayLabel: opts.dayLabel } : {}),
        dayStartMin: 540,
        dayEndMin: 1320,
        stops: [
          {
            id: "stop-1",
            name: "Guildhall Museum",
            location: { lat: 0, lng: 0 },
            durationMin: 60,
            ...(opts.hours ? { hours: opts.hours } : {}),
          },
        ],
      },
    ],
    settings: { walkMax: 10, driveOverheadMin: 10 },
    legOverrides: [],
  };
}

describe("applyHoursAdvisories", () => {
  it("adds a marginNote when the stop is closed on the day's actual weekday", () => {
    const doc = docWithStop(A_MONDAY, { hours: CLOSED_MONDAYS });
    const plan = okPlan([entry("stop-1", 600, 660)]);
    const [result] = applyHoursAdvisories(doc, [plan]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.marginNotes).toEqual([
      "Heads up — Guildhall Museum looks closed on Mondays.",
    ]);
  });

  it("adds no note when the visit fits comfortably inside the day's hours", () => {
    const doc = docWithStop(A_TUESDAY, { hours: CLOSED_MONDAYS });
    const plan = okPlan([entry("stop-1", 600, 660)]); // 10:00-11:00, well inside 09:00-17:00
    const result = applyHoursAdvisories(doc, [plan]);
    expect(result[0]).toBe(plan); // same reference — genuinely unchanged
    expect((result[0] as { marginNotes?: string[] }).marginNotes).toBeUndefined();
  });

  it("skips the check entirely when the day carries a dayLabel (M1.5 placeholder date)", () => {
    const doc = docWithStop(A_MONDAY, { dayLabel: "Day 1", hours: CLOSED_MONDAYS });
    const plan = okPlan([entry("stop-1", 600, 660)]);
    const result = applyHoursAdvisories(doc, [plan]);
    expect(result[0]).toBe(plan); // untouched
  });

  it("leaves a stop with no hours entirely alone", () => {
    const doc = docWithStop(A_MONDAY); // no hours field at all
    const plan = okPlan([entry("stop-1", 600, 660)]);
    const result = applyHoursAdvisories(doc, [plan]);
    expect(result[0]).toBe(plan);
  });

  it("never touches an infeasible or rejected plan's status", () => {
    const doc = docWithStop(A_MONDAY, { hours: CLOSED_MONDAYS });
    const infeasible: DayPlan = {
      status: "infeasible",
      constraint: "anchor-start:stop-1",
      violatedByMin: 5,
      message: "whatever",
    };
    const [result] = applyHoursAdvisories(doc, [infeasible]);
    expect(result).toBe(infeasible);
  });

  it("appends to any pre-existing marginNotes rather than replacing them", () => {
    const doc = docWithStop(A_MONDAY, { hours: CLOSED_MONDAYS });
    const plan: OkDayPlan = { ...okPlan([entry("stop-1", 600, 660)]), marginNotes: ["existing note"] };
    const [result] = applyHoursAdvisories(doc, [plan]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.marginNotes).toEqual([
      "existing note",
      "Heads up — Guildhall Museum looks closed on Mondays.",
    ]);
  });
});

describe("hoursNoteFor — wording branches", () => {
  const open = [{ startMin: 540, endMin: 1020 }]; // 09:00-17:00

  it("closed all day (empty open array)", () => {
    expect(hoursNoteFor("Guildhall Museum", 0, 600, 660, [])).toBe(
      "Heads up — Guildhall Museum looks closed on Mondays."
    );
  });

  it("fits entirely inside the window -> null", () => {
    expect(hoursNoteFor("Flower Dome", 1, 600, 660, open)).toBeNull();
  });

  it("arrival at/after the day's last close -> 'closes at HH:MM, before you'd arrive'", () => {
    expect(hoursNoteFor("Castle Keep", 2, 1100, 1160, open)).toBe(
      "Heads up — Castle Keep closes at 17:00, before you'd arrive."
    );
  });

  it("both start and depart before the first opening -> 'doesn't open until HH:MM'", () => {
    expect(hoursNoteFor("Mustafa Centre", 3, 400, 500, open)).toBe(
      "Heads up — Mustafa Centre doesn't open until 09:00."
    );
  });

  it("starts inside a window but departs past its close -> 'closes at HH:MM, before your visit ends'", () => {
    expect(hoursNoteFor("Burnt Ends", 4, 990, 1050, open)).toBe(
      "Heads up — Burnt Ends closes at 17:00, before your visit ends."
    );
  });
});

// F7 (E5b audit must-not) — lastEntryMin/closedDates are HARD-enforced by the
// engine (problem.ts's hoursFromDoc) but the parser never emits them
// (openingHours.ts's doc comment); a hand-crafted PUT is the only way either
// becomes real today, and the note must exist the day it does.
describe("hoursNoteFor — F7: lastEntryMin / closedDates", () => {
  const open = [{ startMin: 540, endMin: 1020 }]; // 09:00-17:00

  it("closedToday overrides everything else, even a comfortably-fitting visit", () => {
    expect(hoursNoteFor("Flower Dome", 1, 600, 660, open, { closedToday: true })).toBe(
      "Heads up — Flower Dome is closed that date."
    );
  });

  it("a visit that fits the byWeekday window but starts after lastEntryMin still gets a note", () => {
    // 15:30 start, well inside 09:00-17:00 by the old byWeekday-only check —
    // this is exactly the class of breach that used to produce ZERO note.
    expect(hoursNoteFor("Castle Keep", 2, 930, 960, open, { lastEntryMin: 900 })).toBe(
      "Heads up — Castle Keep's last entry is 15:00 — you'd arrive after."
    );
  });

  it("a visit starting at/before lastEntryMin is unaffected", () => {
    expect(hoursNoteFor("Castle Keep", 2, 850, 900, open, { lastEntryMin: 900 })).toBeNull();
  });

  it("closed-all-day still wins over an (irrelevant) lastEntryMin", () => {
    expect(hoursNoteFor("Guildhall Museum", 0, 600, 660, [], { lastEntryMin: 900 })).toBe(
      "Heads up — Guildhall Museum looks closed on Mondays."
    );
  });
});

describe("applyHoursAdvisories — F7: lastEntryMin / closedDates threaded from stop.hours", () => {
  it("flags a visit inside the weekday window but past lastEntryMin", () => {
    const hours: WeeklyHours = { ...CLOSED_MONDAYS, lastEntryMin: 900 };
    // Tuesday, 09:00-17:00, lastEntry 15:00 — visit starts 15:30 (930), fits
    // byWeekday-only but breaches lastEntryMin.
    const doc = docWithStop(A_TUESDAY, { hours });
    const plan = okPlan([entry("stop-1", 930, 960)]);
    const [result] = applyHoursAdvisories(doc, [plan]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.marginNotes).toEqual([
      "Heads up — Guildhall Museum's last entry is 15:00 — you'd arrive after.",
    ]);
  });

  it("flags a visit on a date listed in closedDates even though byWeekday says open", () => {
    const hours: WeeklyHours = { ...CLOSED_MONDAYS, closedDates: [A_TUESDAY] };
    const doc = docWithStop(A_TUESDAY, { hours });
    const plan = okPlan([entry("stop-1", 600, 660)]); // comfortably inside 09:00-17:00
    const [result] = applyHoursAdvisories(doc, [plan]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.marginNotes).toEqual(["Heads up — Guildhall Museum is closed that date."]);
  });
});
