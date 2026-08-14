// Closed-day auto-relocation (Chris, 2026-08-14) — planEngine's
// autoRelocateClosedDayStops + annotateAutoMoves. Proven two ways: through the
// REAL whole-trip path (planStore.recookTrip over the fixture city, where
// Guildhall Museum fx-03 is closed on Mondays and 2026-03-16 is a verified
// Monday — same scenario e2e/tradeoffs.spec.ts is built on), and unit-level
// for the guards a full solve can't cheaply stage (dismissals, missing
// proposals). The e2e tradeoffs suite keeps its cards because its trips are
// SINGLE-day — no open day to move to — which is itself the "no moveDay
// proposal → card, not auto-move" branch.

import fs from "fs";
import os from "os";
import path from "path";
import { recookTrip } from "../planStore";
import {
  annotateAutoMoves,
  autoRelocateClosedDayStops,
  type EnginePlanResult,
} from "../planEngine";
import type { TripDoc, TripStop } from "../store/types";
import type { Conflict, Proposal } from "../engine";
import type { DayPlan } from "../schedule/types";
import { FIXTURE_STOPS } from "../maps/fixtureCity";
import { parseGoogleHours } from "../maps/openingHours";

const stop = (id: string, extra: Partial<TripStop> = {}): TripStop => {
  const f = FIXTURE_STOPS.find((s) => s.id === id)!;
  const hours = f.hours ? parseGoogleHours(f.hours) : null;
  return {
    id: f.id,
    name: f.name,
    location: f.location,
    durationMin: 60,
    ...(hours ? { hours } : {}),
    ...extra,
  };
};

// Day 0 = Monday 2026-03-16 (Guildhall closed), day 1 = Tuesday (open).
const twoDayDoc = (tripId: string, guildhallExtra: Partial<TripStop> = {}): TripDoc => ({
  tripId,
  days: [
    {
      date: "2026-03-16",
      dayStartMin: 540,
      dayEndMin: 1320,
      stops: [stop("fx-01"), stop("fx-03", guildhallExtra)],
    },
    { date: "2026-03-17", dayStartMin: 540, dayEndMin: 1320, stops: [stop("fx-02")] },
  ],
  settings: { walkMax: 10, driveOverheadMin: 10 },
  legOverrides: [],
});

const notesOf = (plan: DayPlan): string =>
  plan.status === "ok" ? (plan.marginNotes ?? []).join(" | ") : "";

describe("closed-day auto-relocation", () => {
  let tmpDir: string;
  let prevMapsProvider: string | undefined;
  let prevTripsDir: string | undefined;

  beforeEach(() => {
    prevMapsProvider = process.env.MAPS_PROVIDER;
    prevTripsDir = process.env.TRIPS_DIR;
    process.env.MAPS_PROVIDER = "fixture";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autorelocate-test-"));
    process.env.TRIPS_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevMapsProvider === undefined) delete process.env.MAPS_PROVIDER;
    else process.env.MAPS_PROVIDER = prevMapsProvider;
    if (prevTripsDir === undefined) delete process.env.TRIPS_DIR;
    else process.env.TRIPS_DIR = prevTripsDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("recookTrip auto-moves an unanchored Monday-closed stop to the open day and says so", async () => {
    const saved = await recookTrip(twoDayDoc("t-automove"));

    // Day membership actually changed and was persisted.
    expect(saved.days[0].stops.map((s) => s.id)).toEqual(["fx-01"]);
    expect(saved.days[1].stops.map((s) => s.id)).toContain("fx-03");

    // Both days carry the heads-up, in journal voice.
    const planDays = saved.plan!.days;
    expect(notesOf(planDays[0])).toContain("Gracie moved Guildhall Museum to day 2");
    expect(notesOf(planDays[0])).toContain("closed on Mondays");
    expect(notesOf(planDays[1])).toContain("moved here from day 1");

    // The closed-day conflict is genuinely resolved, not hidden.
    expect((saved.plan!.conflicts ?? []).some((c) => c.closedDay)).toBe(false);
  });

  it("an anchored (booked) closed-day stop stays put and keeps its conflict", async () => {
    const saved = await recookTrip(twoDayDoc("t-anchored", { anchor: { startMin: 720 } }));

    expect(saved.days[0].stops.map((s) => s.id)).toContain("fx-03");
    expect(
      (saved.plan!.conflicts ?? []).some((c) => c.code === "hours" && c.closedDay)
    ).toBe(true);
    expect(notesOf(saved.plan!.days[0])).not.toContain("Gracie moved");
  });

  it("selection respects dismissals and requires a moveDay proposal (pure)", () => {
    const doc = twoDayDoc("t-unit");
    const conflict: Conflict = {
      id: "hours|0|days[0].stops[1]|k1",
      code: "hours",
      closedDay: true,
      dayIndex: 0,
      stopIds: ["k1"],
      violatedByMin: 0,
      constraintRef: { path: "days[0].stops[1]", provenance: { source: "google" } },
      message: "closed",
    };
    const proposal: Proposal = {
      id: "moveDay:moveStop|0|1|fx-03",
      kind: "moveDay",
      patch: { op: "moveStop", fromDayIndex: 0, toDayIndex: 1, stopId: "fx-03" },
      resolves: [conflict.id],
      costDeltaMin: 3,
      message: "Move Guildhall Museum to day 2.",
    };
    const result = (proposals: Proposal[]): EnginePlanResult => ({
      days: [],
      conflicts: [conflict],
      proposals,
      softViolations: [],
      engineMeta: { name: "test", version: "0", seed: 1 },
    });

    // No moveDay proposal (single-day trips, exhausted MOVE_DAY_LIMIT…) → card.
    expect(autoRelocateClosedDayStops(doc, result([]))).toBeNull();

    // A dismissal on the conflict means the user said "leave it" — honoured.
    const dismissedDoc: TripDoc = {
      ...doc,
      dismissedProposals: [{ id: conflict.id, dayHash: "whatever" }],
    };
    expect(autoRelocateClosedDayStops(dismissedDoc, result([proposal]))).toBeNull();

    // Otherwise: the doc moves, the move is recorded.
    const out = autoRelocateClosedDayStops(doc, result([proposal]))!;
    expect(out.moves).toEqual([
      {
        stopId: "fx-03",
        stopName: "Guildhall Museum",
        fromDayIndex: 0,
        toDayIndex: 1,
        closedOn: "Mondays",
      },
    ]);
    expect(out.doc.days[0].stops.some((s) => s.id === "fx-03")).toBe(false);
    expect(out.doc.days[1].stops.some((s) => s.id === "fx-03")).toBe(true);
    // Input doc untouched (pure).
    expect(doc.days[0].stops.some((s) => s.id === "fx-03")).toBe(true);
  });

  it("annotateAutoMoves notes origin and destination, leaves non-ok days alone", () => {
    const ok = (): DayPlan => ({
      status: "ok",
      order: [],
      entries: [],
      legs: [],
      quality: "heuristic",
      totalTravelMin: 0,
      daySlackMin: 0,
    });
    const rejected: DayPlan = { status: "rejected", message: "nope" };
    const out = annotateAutoMoves(
      [ok(), rejected, ok()],
      [{ stopId: "s", stopName: "Guildhall Museum", fromDayIndex: 0, toDayIndex: 2, closedOn: "Mondays" }]
    );
    expect(notesOf(out[0])).toContain("moved Guildhall Museum to day 3");
    expect(out[1]).toEqual(rejected);
    expect(notesOf(out[2])).toContain("moved here from day 1");
  });
});
