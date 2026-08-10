// E5a — the problem builder. Three things are load-bearing here and each one
// has been a bug somewhere in this codebase already:
//
//  1. KEYING. Nodes must be keyed by `stopKeys(doc)` — the SAME function that
//     keys ConstraintSet.stops. The E2 audit's MAJOR was a cross-day repeat
//     visit collapsing onto its first occurrence, silently losing the later
//     visit's anchor and pinning it to the wrong day.
//  2. WEEKDAY. A day whose date is an M1.5 `dayLabel` placeholder has NO
//     weekday, so hours must say nothing about it. Deriving one anyway would be
//     a confident lie on exactly the trips where hours matter least.
//  3. TRAVEL. §2 decide-then-offer is LOCKED and decided upstream: the engine
//     reads the AUTO matrix's chosen mode and its effective minutes, and both
//     times survive onto the leg for the UI's toggle.

import { compileFromDoc, stopKeys } from "../../constraints/compile";
import { buildEffectiveMatrix, effectiveMinutes } from "../../solver/effectiveMatrix";
import { buildProblem, isoWeekdayOfDay, PACE_BUDGETS } from "../problem";
import { solveWithAlns } from "../alnsEngine";
import {
  docOf,
  everyDay,
  matricesFor,
  problemFor,
  settingsOf,
  tripStop,
  tripStopWithHours,
  withHours,
} from "../__fixtures__/tripFixtures";

describe("E5a buildProblem: keying", () => {
  it("uses stopKeys — a cross-day repeat visit is TWO nodes, each pinned to its own day", async () => {
    const doc = docOf([
      {
        date: "2026-07-07",
        dayStartMin: 9 * 60,
        dayEndMin: 18 * 60,
        stops: [tripStop("fx-10", 45), tripStop("fx-01", 30)],
      },
      {
        date: "2026-07-08",
        dayStartMin: 9 * 60,
        dayEndMin: 18 * 60,
        stops: [tripStop("fx-10", 60, 11 * 60), tripStop("fx-02", 30)],
      },
    ]);

    expect(stopKeys(doc)).toEqual([
      ["fx-10", "fx-01"],
      ["fx-10@d1", "fx-02"],
    ]);

    const set = compileFromDoc(doc);
    const problem = buildProblem(doc, set, await matricesFor(doc));
    expect(problem.nodes.map((n) => n.key)).toEqual(["fx-10", "fx-01", "fx-10@d1", "fx-02"]);
    // Every node key is a key of the ConstraintSet: the two sides cannot diverge.
    for (const node of problem.nodes) expect(set.stops[node.key]).toBeDefined();

    const first = problem.nodes.find((n) => n.key === "fx-10")!;
    const second = problem.nodes.find((n) => n.key === "fx-10@d1")!;
    expect(first.stopId).toBe("fx-10");
    expect(second.stopId).toBe("fx-10"); // the matrix + DayPlan identity is the bare id
    expect(first.pinnedDay!.value).toBe(0);
    expect(second.pinnedDay!.value).toBe(1);
    // The LATER occurrence's own anchor and duration survive.
    expect(first.isAnchor).toBe(false);
    expect(second.isAnchor).toBe(true);
    expect(second.window!.value).toEqual({ startMin: 660, endMin: 660 });
    expect(first.duration.value.typicalMin).toBe(45);
    expect(second.duration.value.typicalMin).toBe(60);

    // ...and both survive into the plan, on their own days.
    const solution = solveWithAlns(problem, { seed: 1, timeBudgetMs: 0, iterCap: 1 });
    expect(solution.assignment).toEqual({
      "fx-10": 0,
      "fx-01": 0,
      "fx-10@d1": 1,
      "fx-02": 1,
    });
  });
});

describe("E5a buildProblem: weekday and hours", () => {
  it("derives ISO weekdays at UTC noon", () => {
    expect(isoWeekdayOfDay({ date: "2026-07-06" })).toBe(0); // Monday
    expect(isoWeekdayOfDay({ date: "2026-07-12" })).toBe(6); // Sunday
  });

  it("a dayLabel day has NO weekday, and therefore no hours constraints", async () => {
    const doc = docOf([
      {
        date: "2026-08-10",
        dayLabel: "Day 2",
        dayStartMin: 9 * 60,
        dayEndMin: 18 * 60,
        stops: [tripStopWithHours("fx-03", 60), tripStop("fx-01", 30)],
      },
    ]);
    const problem = await problemFor(doc);
    expect(problem.days[0].weekday).toBeNull();
    // fx-03 carries WeeklyHours, but there is no weekday to intersect them
    // with, so the node carries no hours constraint at all (E3's advisory path
    // owns that case, and it skips dayLabel days for the same reason).
    expect(problem.nodes.find((n) => n.key === "fx-03")!.hours).toBeUndefined();
  });

  it("an unparseable date has no weekday either", async () => {
    const doc = docOf([
      {
        date: "not-a-date",
        dayStartMin: 9 * 60,
        dayEndMin: 18 * 60,
        stops: [tripStopWithHours("fx-03", 60)],
      },
    ]);
    const problem = await problemFor(doc);
    expect(problem.days[0].weekday).toBeNull();
    expect(problem.nodes[0].hours).toBeUndefined();
  });

  it("compiles TripStop.hours as a HARD google fact, day by day", async () => {
    const doc = docOf([
      {
        date: "2026-07-06", // Monday — fx-03 is shut
        dayStartMin: 9 * 60,
        dayEndMin: 18 * 60,
        stops: [tripStopWithHours("fx-03", 60)],
      },
      {
        date: "2026-07-07", // Tuesday — 09:00-17:00
        dayStartMin: 9 * 60,
        dayEndMin: 18 * 60,
        stops: [tripStop("fx-01", 30)],
      },
    ]);
    const node = (await problemFor(doc)).nodes[0];
    expect(node.hours).toBeDefined();
    expect(node.hours!.hard).toBe(true);
    expect(node.hours!.ref).toEqual({
      path: "stops.fx-03.hours",
      provenance: { source: "google" },
    });
    expect(node.hours!.value.openByDay[0]).toEqual([]); // closed Mondays
    expect(node.hours!.value.openByDay[1]).toEqual([{ startMin: 540, endMin: 1020 }]);
  });

  it("hoursFromDoc:false restores the pre-E5 behaviour (hours are advisory only)", async () => {
    const doc = docOf([
      {
        date: "2026-07-06",
        dayStartMin: 9 * 60,
        dayEndMin: 18 * 60,
        stops: [tripStopWithHours("fx-03", 60)],
      },
    ]);
    const problem = await problemFor(doc, { hoursFromDoc: false });
    expect(problem.nodes[0].hours).toBeUndefined();
    expect(solveWithAlns(problem, { seed: 1, timeBudgetMs: 0, iterCap: 1 }).conflicts).toEqual([]);
  });

  it("closedDates override the weekday to closed", async () => {
    const doc = docOf([
      {
        date: "2026-07-07",
        dayStartMin: 9 * 60,
        dayEndMin: 18 * 60,
        stops: [
          withHours(tripStop("fx-01", 30), {
            ...everyDay(9 * 60, 17 * 60),
            closedDates: ["2026-07-07"],
          }),
        ],
      },
    ]);
    const problem = await problemFor(doc);
    expect(problem.nodes[0].hours!.value.openByDay[0]).toEqual([]);
  });
});

describe("E5a buildProblem: travel is the AUTO matrix, unmodified", () => {
  it("effective minutes and legs come straight from buildEffectiveMatrix", async () => {
    const doc = docOf([
      {
        date: "2026-07-07",
        dayStartMin: 9 * 60,
        dayEndMin: 20 * 60,
        // fx-01..fx-04 are the walkable old-town cluster: this exercises BOTH
        // modes, so "the engine never re-decides a mode" is a real assertion.
        stops: [tripStop("fx-01", 30), tripStop("fx-02", 30), tripStop("fx-14", 30)],
      },
    ]);
    const matrices = await matricesFor(doc);
    const settings = settingsOf(doc);
    const problem = buildProblem(doc, compileFromDoc(doc), matrices);

    let sawWalk = false;
    let sawDrive = false;
    for (const from of problem.nodes) {
      for (const to of problem.nodes) {
        if (from === to) continue;
        const i = problem.travel.index[from.key];
        const j = problem.travel.index[to.key];
        const leg = matrices[0][from.stopId][to.stopId];
        expect(problem.travel.legsByDay[0][i * problem.travel.n + j]).toBe(leg);
        expect(problem.travel.minutesByDay[0][i * problem.travel.n + j]).toBe(
          effectiveMinutes(leg, settings)
        );
        if (leg.mode === "walk") sawWalk = true;
        else sawDrive = true;
      }
    }
    expect(sawWalk).toBe(true);
    expect(sawDrive).toBe(true);

    // Both times survive onto the emitted legs (the per-leg toggle's raw
    // material), and the engine never claims to have chosen.
    const plan = solveWithAlns(problem, { seed: 1, timeBudgetMs: 0, iterCap: 1 }).days[0];
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    for (const leg of plan.legs) {
      expect(leg.chosenBy).toBe("auto");
      if (leg.mode === "walk") expect(leg.walkMin).not.toBeNull();
      expect(typeof leg.driveMin).toBe("number");
    }
  });

  it("is unaffected by the identity of the matrix builder — it just reads it", () => {
    // A sanity check on the fixture city's own promise: the matrix the engine
    // consumes is exactly `buildEffectiveMatrix`'s output.
    const settings = settingsOf(docOf([]));
    const drive = { a: { a: 0, b: 4 }, b: { a: 4, b: 0 } };
    const locations = { a: { lat: 51.45, lng: -2.6 }, b: { lat: 51.4512, lng: -2.5988 } };
    const matrix = buildEffectiveMatrix(drive, locations, settings);
    expect(matrix.a.b.chosenBy).toBe("auto");
  });
});

describe("E5a buildProblem: pace", () => {
  it("resolves the trip pace preset into per-day budgets", async () => {
    const doc = docOf([
      { date: "2026-07-07", dayStartMin: 9 * 60, dayEndMin: 20 * 60, stops: [tripStop("fx-01", 30)] },
    ]);
    const problem = await problemFor(doc);
    // compileFromDoc derives "balanced", SOFT: a default we invented, not a rule.
    expect(problem.pacePreset.value).toBe("balanced");
    expect(problem.pacePreset.hard).toBe(false);
    expect(problem.days[0].pace.value).toEqual(PACE_BUDGETS.balanced);
    expect(problem.days[0].pace.ref.path).toBe("trip.pacePreset");
  });
});
