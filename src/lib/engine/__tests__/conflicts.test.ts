// E5a golden: the engine NEVER returns a dead end.
//
// Decision 6: "Infeasibility = trade-off proposals. Never silently cut; user
// chooses." The old engine's answer to a Monday-closed museum on a Monday was
// `{status: "infeasible"}` (or, for hours specifically, nothing at all — it
// never read them). This file pins the replacement:
//
//   * a plan still comes back, WITH the impossible stop still in it, marked;
//   * a conflict names the exact constraint (`stops.fx-03.hours`) and whose it
//     is (`provenance.source === "google"` — a fetched fact about the world);
//   * at least one proposal is offered;
//   * and the FULL LOOP closes: that proposal's patch, applied to the TripDoc
//     and re-solved, actually makes the conflict go away.
//
// The last bullet is the one that matters. A proposal that does not survive
// being applied is a lie the UI would render as a button.

import { compileFromDoc, mergePatches } from "../../constraints/compile";
import type { ConstraintSet } from "../../constraints/types";
import { planDay } from "../../schedule/schedule";
import { isoWeekdayOfDay } from "../problem";
import { applyConstraintPatch, applyDocPatch } from "../patch";
import { solveWithAlns } from "../alnsEngine";
import type { EngineSolution, SolveOptions } from "../types";
import type { TripDoc } from "../../store/types";
import {
  docOf,
  everyDay,
  legacyDay,
  matricesFor,
  problemFor,
  settingsOf,
  tripStop,
  tripStopWithHours,
  withHours,
} from "../__fixtures__/tripFixtures";

const OPTS: SolveOptions = { seed: 909, timeBudgetMs: 1500, iterCap: 3000 };

const MONDAY = "2026-07-06";
const TUESDAY = "2026-07-07";

async function solve(doc: TripDoc, set?: ConstraintSet): Promise<EngineSolution> {
  return solveWithAlns(await problemFor(doc, undefined, set), OPTS);
}

describe("E5a: an impossible constraint yields a plan, a conflict and a way out", () => {
  it("the fixture dates really are the weekdays this file assumes", () => {
    expect(isoWeekdayOfDay({ date: MONDAY })).toBe(0); // 0 = Monday (ISO)
    expect(isoWeekdayOfDay({ date: TUESDAY })).toBe(1);
  });

  it("a Monday-closed must-stop on a Monday: plan returned, conflict cited, proposal applies", async () => {
    // fx-03 Guildhall Museum carries the fixture city's REAL Google payload
    // (closed Mondays, else 09:00-17:00), parsed by the production parser.
    const doc = docOf([
      {
        date: MONDAY,
        dayStartMin: 9 * 60,
        dayEndMin: 18 * 60,
        stops: [tripStop("fx-01", 30), tripStopWithHours("fx-03", 60), tripStop("fx-02", 30)],
      },
    ]);

    const solution = await solve(doc);

    // 1. A plan came back, and the impossible stop is still IN it.
    const plan = solution.days[0];
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    expect(plan.order).toContain("fx-03");
    expect(solution.assignment["fx-03"]).toBe(0);

    // 2. The conflict names the constraint and its provenance.
    const hoursConflicts = solution.conflicts.filter((c) => c.code === "hours");
    expect(hoursConflicts).toHaveLength(1);
    const conflict = hoursConflicts[0];
    expect(conflict.stopIds).toEqual(["fx-03"]);
    expect(conflict.dayIndex).toBe(0);
    expect(conflict.constraintRef.path).toBe("stops.fx-03.hours");
    expect(conflict.constraintRef.provenance.source).toBe("google");
    // Closed ALL day: no shift of the visit helps, and the engine says so
    // rather than inventing a number.
    expect(conflict.violatedByMin).toBe(0);

    // The advisory channel finally carries it (E6 renders the structured card).
    expect(plan.marginNotes ?? []).toContain(conflict.message);

    // 3. At least one proposal, and each one claims to resolve something.
    expect(solution.proposals.length).toBeGreaterThanOrEqual(1);
    for (const p of solution.proposals) expect(p.resolves.length).toBeGreaterThan(0);

    // 4. THE FULL LOOP. Every proposal that claims this conflict really closes it.
    const forThis = solution.proposals.filter((p) => p.resolves.includes(conflict.id));
    expect(forThis.length).toBeGreaterThanOrEqual(1);
    for (const proposal of forThis) {
      const patched = applyDocPatch(doc, proposal.patch);
      expect(patched).not.toBe(doc);
      const after = await solve(patched);
      expect(after.conflicts.map((c) => c.id)).not.toContain(conflict.id);
      expect(after.conflicts.filter((c) => c.code === "hours")).toHaveLength(0);
    }
  }, 120_000);

  it("with an open day available, moveDay is PROPOSED and never applied", async () => {
    const doc = docOf([
      {
        date: MONDAY,
        dayStartMin: 9 * 60,
        dayEndMin: 18 * 60,
        stops: [tripStop("fx-01", 30), tripStopWithHours("fx-03", 60)],
      },
      {
        date: TUESDAY,
        dayStartMin: 9 * 60,
        dayEndMin: 18 * 60,
        stops: [tripStop("fx-02", 30)],
      },
    ]);

    const solution = await solve(doc);
    const conflict = solution.conflicts.find((c) => c.code === "hours");
    expect(conflict).toBeDefined();

    const moveDay = solution.proposals.filter((p) => p.kind === "moveDay");
    expect(moveDay.length).toBeGreaterThanOrEqual(1);
    const move = moveDay.find((p) => p.resolves.includes(conflict!.id));
    expect(move).toBeDefined();
    expect(move!.patch).toEqual({
      op: "moveStop",
      fromDayIndex: 0,
      toDayIndex: 1,
      stopId: "fx-03",
    });

    // LAUNCH MODE: hard pins are the paste's decision. The engine offers the
    // move; it does not take it.
    expect(solution.assignment["fx-03"]).toBe(0);
    expect(solution.days[0].status === "ok" && solution.days[0].order).toContain("fx-03");

    // ...and taking it works.
    const after = await solve(applyDocPatch(doc, move!.patch));
    expect(after.conflicts.filter((c) => c.code === "hours")).toHaveLength(0);
    expect(after.assignment["fx-03"]).toBe(1);
  }, 120_000);

  it("a booked time the day cannot reach becomes an anchor conflict with a shiftWindow way out", async () => {
    // Two bookings 65 minutes apart with a 60-minute visit and 22 minutes of
    // driving between them. The old engine's answer to this is
    // `{status:"infeasible", constraint:"anchor-start:fx-01"}` and no plan at
    // all; here the day is still in the OLD constraint class (nothing but a day
    // window and point anchors), so the exhaustive floor owns it — and it
    // returns a plan with the breach named.
    const doc = docOf([
      {
        date: TUESDAY,
        dayStartMin: 9 * 60,
        dayEndMin: 20 * 60,
        stops: [
          tripStop("fx-18", 60, 9 * 60 + 30), // 09:30 - 10:30
          tripStop("fx-01", 30, 10 * 60 + 35), // booked 10:35, reachable 10:52
        ],
      },
    ]);

    // The oracle agrees on the size of the miss.
    const oracle = planDay(legacyDay(doc, 0), (await matricesFor(doc))[0], settingsOf(doc));
    expect(oracle.status).toBe("infeasible");
    if (oracle.status === "infeasible") {
      expect(oracle.constraint).toBe("anchor-start:fx-01");
      expect(oracle.violatedByMin).toBe(17);
    }

    const solution = await solve(doc);
    const conflict = solution.conflicts.find((c) => c.code === "anchor-start");
    expect(conflict).toBeDefined();
    expect(conflict!.stopIds).toEqual(["fx-01"]);
    expect(conflict!.constraintRef.path).toBe("stops.fx-01.window");
    expect(conflict!.constraintRef.provenance.source).toBe("legacy");
    expect(conflict!.violatedByMin).toBe(17);
    expect(solution.days[0].status === "ok" && solution.days[0].quality).toBe("optimal");

    // The plan still contains the stop, at the earliest time it can actually be
    // reached — never a negative wait, never a dropped booking.
    const plan = solution.days[0];
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    for (const e of plan.entries) expect(e.waitMin).toBeGreaterThanOrEqual(0);

    const shift = solution.proposals.find(
      (p) => p.kind === "shiftWindow" && p.resolves.includes(conflict!.id)
    );
    expect(shift).toBeDefined();
    expect(shift!.patch).toEqual({
      op: "setAnchor",
      dayIndex: 0,
      stopId: "fx-01",
      startMin: 10 * 60 + 35 + 17,
    });
    const after = await solve(applyDocPatch(doc, shift!.patch));
    expect(after.conflicts.map((c) => c.id)).not.toContain(conflict!.id);
  }, 120_000);

  it("a HARD pace the day cannot keep yields relaxPace, and relaxing it works", async () => {
    // Five hour-and-a-half visits: 450 minutes of visiting plus travel, against
    // a `relaxed` budget of 480 minutes of day SPAN and 8 effort points.
    const doc = docOf([
      {
        date: TUESDAY,
        dayStartMin: 9 * 60,
        dayEndMin: 21 * 60,
        stops: [
          tripStop("fx-01", 90),
          tripStop("fx-02", 90),
          tripStop("fx-04", 90),
          tripStop("fx-11", 90),
          tripStop("fx-16", 90),
        ],
      },
    ]);
    // A pace the USER asserted, HARD — not the derived default.
    const set: ConstraintSet = {
      ...compileFromDoc(doc),
      trip: {
        pacePreset: { value: "relaxed", provenance: { source: "user" }, hardness: "hard" },
      },
    };

    const solution = await solve(doc, set);
    const pace = solution.conflicts.filter(
      (c) => c.code === "pace-active" || c.code === "pace-effort"
    );
    expect(pace.length).toBeGreaterThanOrEqual(1);
    expect(pace[0].constraintRef.path).toBe("trip.pacePreset");
    expect(pace[0].constraintRef.provenance.source).toBe("user");

    const relax = solution.proposals.find((p) => p.kind === "relaxPace");
    expect(relax).toBeDefined();
    expect(relax!.patch).toEqual({ op: "setPacePreset", preset: "packed" });
    expect(relax!.resolves).toEqual(expect.arrayContaining([pace[0].id]));

    // Applying it is a CONSTRAINT-level change (today's doc has nowhere to put a
    // pace), and it really clears the conflict.
    const relaxed = applyConstraintPatch(set, relax!.patch);
    const after = await solve(doc, relaxed);
    expect(after.conflicts.filter((c) => c.code.startsWith("pace-"))).toHaveLength(0);
  }, 120_000);

  it("a duration RANGE offers trimDuration — shorten one visit to save another's booking", async () => {
    // The Quad shuts at 11:00, so it has to be the morning; the Market Hall is
    // booked for 11:00 and is 16 minutes' drive away. At its typical 120 minutes
    // the Quad runs to exactly 11:00 and the booking is missed by the drive. It
    // COULD be a 30-minute visit — but the engine will not shorten someone's day
    // on its own initiative, so it offers.
    const doc = docOf([
      {
        date: TUESDAY,
        dayStartMin: 9 * 60,
        dayEndMin: 20 * 60,
        stops: [
          withHours(tripStop("fx-12", 120), everyDay(9 * 60, 11 * 60)),
          tripStop("fx-01", 30, 11 * 60),
        ],
      },
    ]);
    const set = mergePatches(compileFromDoc(doc), {
      stops: {
        "fx-12": {
          duration: {
            value: { minMin: 30, typicalMin: 120, maxMin: 120 },
            provenance: { source: "user" },
            hardness: "hard",
          },
        },
      },
    });

    const solution = await solve(doc, set);
    const conflict = solution.conflicts.find((c) => c.code === "anchor-start");
    expect(conflict).toBeDefined();
    expect(conflict!.stopIds).toEqual(["fx-01"]);
    expect(conflict!.violatedByMin).toBe(16);

    // The conflict is on the Market Hall; the fix is on the Quad. A proposal
    // engine that only ever offered to change the stop that complained would
    // miss every fix of this shape.
    const trim = solution.proposals.find(
      (p) => p.kind === "trimDuration" && p.resolves.includes(conflict!.id)
    );
    expect(trim).toBeDefined();
    expect(trim!.patch).toEqual({
      op: "setDuration",
      dayIndex: 0,
      stopId: "fx-12",
      durationMin: 30,
    });
    // costDeltaMin is the price in OBJECTIVE units — travel, wait, compression,
    // drops. Here it is exactly zero: the shorter visit simply starts later
    // (the schedule builder right-shifts it to 10:14-10:44) so not one minute of
    // travel or idling changes. The real cost of this trade is 90 minutes less
    // at the Quad, which is in the PATCH, not in the objective — and which is
    // precisely why the engine offers it instead of taking it.
    expect(trim!.costDeltaMin).toBe(0);

    const patchedDoc = applyDocPatch(doc, trim!.patch);
    const patchedSet = mergePatches(compileFromDoc(patchedDoc), {
      stops: {
        "fx-12": {
          duration: {
            value: { minMin: 30, typicalMin: 30, maxMin: 30 },
            provenance: { source: "user" },
            hardness: "hard",
          },
        },
      },
    });
    const after = await solve(patchedDoc, patchedSet);
    expect(after.conflicts.map((c) => c.id)).not.toContain(conflict!.id);
    expect(after.conflicts).toEqual([]);
  }, 120_000);

  it("a dropped `could` stop is a conflict too — a trade the user never authorised", async () => {
    // A day with room for two of the three stops. The third is `could`, priced
    // at 60, so the engine leaves it out rather than blow the day window.
    const doc = docOf([
      {
        date: TUESDAY,
        dayStartMin: 9 * 60,
        dayEndMin: 11 * 60,
        stops: [tripStop("fx-01", 45), tripStop("fx-14", 45), tripStop("fx-20", 45)],
      },
    ]);
    const base = compileFromDoc(doc);
    const set = mergePatches(base, {
      stops: {
        "fx-20": {
          priority: { value: "could", provenance: { source: "user" }, hardness: "hard" },
        },
      },
    });

    const solution = await solve(doc, set);
    expect(solution.assignment["fx-20"]).toBe(-1);
    const dropped = solution.conflicts.filter((c) => c.code === "dropped-stop");
    expect(dropped).toHaveLength(1);
    expect(dropped[0].stopIds).toEqual(["fx-20"]);
    expect(dropped[0].constraintRef.path).toBe("stops.fx-20.priority");
    expect(dropped[0].constraintRef.provenance.source).toBe("user");
    expect(solution.objectiveBreakdown.dropPenalty).toBe(60);
  }, 120_000);
});
