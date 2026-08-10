// E5a golden: opening hours are LOAD-BEARING on the solve, not an advisory.
//
// E3 landed the parser and a post-hoc margin note; the CURRENT engine still
// orders a day purely by travel and only afterwards notices a museum was shut.
// This file pins the behaviour that replaces it — and pins it as a GOLDEN, with
// every minute written out, rather than a snapshot: a change to the schedule
// math has to be argued for in a diff, not accepted with `-u`.
//
// THE SETUP (hand-built so the forcing is provable by hand, not by luck):
//
//   fx-01 Market Hall     51.4500,-2.6000  access 2   30 min   no hours
//   fx-12 University Quad 51.4610,-2.6020  access 1   45 min   OPEN 09:00-10:00
//   fx-18 City Zoo        51.4760,-2.5880  access 3   40 min   no hours
//
// They lie on a line: Market Hall south, University Quad in the middle, Zoo far
// north. Effective (drive + 10 min overhead) minutes, from the fixture city's
// own metric formula:
//
//        01 <-> 12 : 16      12 <-> 18 : 18      01 <-> 18 : 22
//
// so the travel-optimal order is the geometric chain 01 -> 12 -> 18 at 34 min,
// which is exactly what the OLD engine returns. But the Quad shuts at 10:00 and
// takes 45 minutes, so it can only be visited FIRST — and visiting the middle of
// a chain first costs a detour: 12 -> 01 -> 18 is 38 minutes.
//
// The new engine pays those 4 minutes. That trade — 4 minutes of travel to not
// arrive at a closed door — is the entire point of E5.

import { compileFromDoc } from "../../constraints/compile";
import { planDay } from "../../schedule/schedule";
import { buildProblem } from "../problem";
import { isLaunchMode, isOldClassDay } from "../exhaustive";
import { solveWithAlns } from "../alnsEngine";
import {
  docOf,
  everyDay,
  legacyDay,
  matricesFor,
  settingsOf,
  tripStop,
  withHours,
} from "../__fixtures__/tripFixtures";

const OPTS = { seed: 4242, timeBudgetMs: 2000, iterCap: 3000 };

// 2026-07-07 is a Tuesday; the hours below are the same on every weekday, so the
// golden does not silently depend on which one.
const forcedDay = () => ({
  date: "2026-07-07",
  dayStartMin: 9 * 60,
  dayEndMin: 20 * 60,
  stops: [
    tripStop("fx-01", 30),
    withHours(tripStop("fx-12", 45), everyDay(9 * 60, 10 * 60)),
    tripStop("fx-18", 40),
  ],
});

describe("E5a golden: opening hours force a non-travel-optimal order", () => {
  it("leaves the old constraint class the moment hours bind", async () => {
    const doc = docOf([forcedDay()]);
    const problem = buildProblem(doc, compileFromDoc(doc), await matricesFor(doc));
    expect(isOldClassDay(problem, 0, isLaunchMode(problem))).toBe(false);
  });

  it("the OLD engine would visit the Quad after it closes", async () => {
    const doc = docOf([forcedDay()]);
    const matrices = await matricesFor(doc);
    const old = planDay(legacyDay(doc, 0), matrices[0], settingsOf(doc));
    expect(old.status).toBe("ok");
    if (old.status !== "ok") return;
    expect(old.order).toEqual(["fx-01", "fx-12", "fx-18"]);
    expect(old.totalTravelMin).toBe(34);
    // 09:00 + 30 + 16 = 09:46 arrival at a place that shuts at 10:00 and needs 45.
    expect(old.entries[1].startMin).toBe(586);
    expect(old.entries[1].departMin).toBe(631); // 10:31 — half an hour past closing
  });

  it("the NEW engine reorders, and the schedule is exactly this", async () => {
    const doc = docOf([forcedDay()]);
    const problem = buildProblem(doc, compileFromDoc(doc), await matricesFor(doc));
    const solution = solveWithAlns(problem, OPTS);
    const plan = solution.days[0];
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;

    expect(plan.order).toEqual(["fx-12", "fx-01", "fx-18"]);
    expect(plan.quality).toBe("heuristic"); // honest: this is not the old class
    expect(plan.totalTravelMin).toBe(38); // 4 min more than the travel optimum
    expect(plan.daySlackMin).toBe(1200 - 693);
    expect(plan.entries).toEqual([
      { stopId: "fx-12", kind: "flexible", arriveMin: 540, startMin: 540, departMin: 585, waitMin: 0 },
      { stopId: "fx-01", kind: "flexible", arriveMin: 601, startMin: 601, departMin: 631, waitMin: 0 },
      { stopId: "fx-18", kind: "flexible", arriveMin: 653, startMin: 653, departMin: 693, waitMin: 0 },
    ]);
    expect(plan.legs).toEqual([
      {
        fromId: "fx-12",
        toId: "fx-01",
        mode: "drive",
        walkMin: null,
        driveMin: 6,
        effectiveMin: 16,
        chosenBy: "auto",
        departMin: 585,
        arriveMin: 601,
      },
      {
        fromId: "fx-01",
        toId: "fx-18",
        mode: "drive",
        walkMin: null,
        driveMin: 12,
        effectiveMin: 22,
        chosenBy: "auto",
        departMin: 631,
        arriveMin: 653,
      },
    ]);

    // Everything fits, so there is nothing to trade off.
    expect(solution.conflicts).toEqual([]);
    expect(solution.proposals).toEqual([]);
    expect(solution.objectiveBreakdown).toEqual({
      travelMin: 38,
      waitMin: 0,
      dropPenalty: 0,
      compressionPenalty: 0,
      softViolations: 0,
    });
  });

  it("lastEntryMin caps the START, not the departure", async () => {
    // Open 09:00-18:00 but last entry 10:00: a 120-minute visit may START at
    // 10:00 and run to 12:00, which is legal precisely because lastEntry does
    // not constrain the departure.
    const doc = docOf([
      {
        date: "2026-07-07",
        dayStartMin: 9 * 60,
        dayEndMin: 20 * 60,
        stops: [
          tripStop("fx-01", 30),
          withHours(tripStop("fx-12", 120), everyDay(9 * 60, 18 * 60, 10 * 60)),
        ],
      },
    ]);
    const problem = buildProblem(doc, compileFromDoc(doc), await matricesFor(doc));
    const plan = solveWithAlns(problem, OPTS).days[0];
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    const quad = plan.entries.find((e) => e.stopId === "fx-12")!;
    expect(quad.startMin).toBeLessThanOrEqual(600);
    expect(quad.departMin).toBe(quad.startMin + 120); // runs past last entry, legally
    expect(plan.entries.map((e) => e.stopId)).toEqual(["fx-12", "fx-01"]);
  });
});
