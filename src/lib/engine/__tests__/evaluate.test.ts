// E5a — the objective's semantics, asserted directly against hand-built
// schedules. These are the E1 spike's learnings, promoted; each one was learned
// the expensive way and each one is easy to "simplify" back into a bug.

import { compileFromDoc, mergePatches } from "../../constraints/compile";
import { evaluate, WEIGHT_COMPRESSION, WEIGHT_TRAVEL, WEIGHT_WAIT } from "../evaluate";
import { solveWithAlns } from "../alnsEngine";
import type { EngineProblem, EngineSchedule } from "../types";
import {
  docOf,
  everyDay,
  problemFor,
  tripStop,
  withHours,
} from "../__fixtures__/tripFixtures";

const visit = (key: string, dayIndex: number, arriveMin: number, startMin: number, departMin: number) => ({
  key,
  dayIndex,
  arriveMin,
  startMin,
  departMin,
});

async function twoStopProblem(hoursFor?: {
  startMin: number;
  endMin: number;
  lastEntryMin?: number;
}): Promise<EngineProblem> {
  const second = tripStop("fx-12", 60);
  const doc = docOf([
    {
      date: "2026-07-07",
      dayStartMin: 9 * 60,
      dayEndMin: 20 * 60,
      stops: [
        tripStop("fx-01", 30),
        hoursFor
          ? withHours(
              second,
              everyDay(hoursFor.startMin, hoursFor.endMin, hoursFor.lastEntryMin)
            )
          : second,
      ],
    },
  ]);
  return problemFor(doc);
}

describe("E5a objective: hours", () => {
  it("a visit must fit entirely inside ONE open interval — never across a split shift", async () => {
    const doc = docOf([
      {
        date: "2026-07-07",
        dayStartMin: 9 * 60,
        dayEndMin: 22 * 60,
        stops: [
          withHours(tripStop("fx-01", 30), {
            byWeekday: Array.from({ length: 7 }, () => [
              { startMin: 600, endMin: 780 }, // 10:00-13:00
              { startMin: 1140, endMin: 1320 }, // 19:00-22:00
            ]),
          }),
        ],
      },
    ]);
    const problem = await problemFor(doc);

    const inside: EngineSchedule = { visits: [visit("fx-01", 0, 600, 600, 630)], dropped: [] };
    expect(evaluate(problem, inside).violations.filter((v) => v.code === "hours")).toHaveLength(0);

    // 12:50-13:20 starts inside the matinee and ends after it closes.
    const straddling: EngineSchedule = { visits: [visit("fx-01", 0, 770, 770, 800)], dropped: [] };
    const hours = evaluate(problem, straddling).violations.filter((v) => v.code === "hours");
    expect(hours).toHaveLength(1);
    expect(hours[0].hard).toBe(true);
    expect(hours[0].byMin).toBe(20); // shift 20 min earlier and it fits
  });

  it("lastEntryMin caps the START, not the departure", async () => {
    const problem = await twoStopProblem({ startMin: 540, endMin: 1080, lastEntryMin: 600 });
    const ok: EngineSchedule = {
      visits: [visit("fx-01", 0, 540, 540, 570), visit("fx-12", 0, 586, 600, 660)],
      dropped: [],
    };
    expect(evaluate(problem, ok).violations.filter((v) => v.code === "hours")).toHaveLength(0);

    const late: EngineSchedule = {
      visits: [visit("fx-01", 0, 540, 540, 570), visit("fx-12", 0, 586, 601, 661)],
      dropped: [],
    };
    expect(evaluate(problem, late).violations.filter((v) => v.code === "hours")).toHaveLength(1);
  });
});

describe("E5a objective: wait, travel and compression", () => {
  it("wait is the idle gap AFTER travel, and travel comes from the matrix", async () => {
    const problem = await twoStopProblem();
    const travel = problem.travel.minutesByDay[0][problem.travel.index["fx-01"] * 2 + 1];
    const schedule: EngineSchedule = {
      visits: [
        visit("fx-01", 0, 540, 540, 570),
        visit("fx-12", 0, 570 + travel, 700, 760),
      ],
      dropped: [],
    };
    const e = evaluate(problem, schedule);
    expect(e.breakdown.travelMin).toBe(travel);
    expect(e.breakdown.waitMin).toBe(700 - 570 - travel);
    expect(e.score).toBeCloseTo(
      WEIGHT_TRAVEL * e.breakdown.travelMin + WEIGHT_WAIT * e.breakdown.waitMin,
      9
    );
  });

  it("compression is charged per minute under typicalMin", async () => {
    const doc = docOf([
      {
        date: "2026-07-07",
        dayStartMin: 9 * 60,
        dayEndMin: 20 * 60,
        stops: [tripStop("fx-01", 60)],
      },
    ]);
    const set = mergePatches(compileFromDoc(doc), {
      stops: {
        "fx-01": {
          duration: {
            value: { minMin: 30, typicalMin: 60, maxMin: 90 },
            provenance: { source: "user" },
            hardness: "hard",
          },
        },
      },
    });
    const problem = await problemFor(doc, undefined, set);
    const trimmed: EngineSchedule = { visits: [visit("fx-01", 0, 540, 540, 580)], dropped: [] };
    const e = evaluate(problem, trimmed);
    expect(e.breakdown.compressionPenalty).toBe(WEIGHT_COMPRESSION * 20);
    expect(e.feasible).toBe(true); // 40 min is inside [30, 90]
  });
});

describe("E5a objective: pace", () => {
  it("maxActiveMin is the day SPAN (last departure - first arrival), not summed durations", async () => {
    const problem = await twoStopProblem();
    // Two 30/60-minute visits, but eleven hours apart: 90 minutes of visiting,
    // 660 minutes of day. The span is what the budget is about.
    const stretched: EngineSchedule = {
      visits: [visit("fx-01", 0, 540, 540, 570), visit("fx-12", 0, 1130, 1140, 1200)],
      dropped: [],
    };
    const pace = evaluate(problem, stretched).violations.filter((v) => v.code === "pace-active");
    expect(pace).toHaveLength(1);
    expect(pace[0].byMin).toBe(1200 - 540 - 600); // 660 span vs the balanced 600
    // Soft by default (a preset WE derived), so it is priced, not infeasible.
    expect(pace[0].hard).toBe(false);
    expect(evaluate(problem, stretched).feasible).toBe(true);
    expect(evaluate(problem, stretched).breakdown.softViolations).toBe(50);
  });

  it("minGapMin is only a rule when the pace constraint is HARD", async () => {
    const doc = docOf([
      {
        date: "2026-07-07",
        dayStartMin: 9 * 60,
        dayEndMin: 21 * 60,
        stops: [tripStop("fx-01", 30), tripStop("fx-02", 30), tripStop("fx-04", 30)],
      },
    ]);
    const opts = { seed: 3, timeBudgetMs: 500, iterCap: 500 };

    // Derived-soft pace (what compileFromDoc emits): the schedule packs, exactly
    // as the old engine did — a default we invented must not repace a trip.
    const soft = solveWithAlns(await problemFor(doc), opts).days[0];
    expect(soft.status).toBe("ok");
    if (soft.status !== "ok") return;
    for (const leg of soft.legs) {
      const to = soft.entries.find((e) => e.stopId === leg.toId)!;
      expect(to.startMin).toBe(leg.arriveMin);
    }

    // A HARD pace budget: 10 minutes of breathing room appear between stops.
    const hardSet = mergePatches(compileFromDoc(doc), {
      days: {
        0: {
          paceBudget: {
            value: { maxActiveMin: 600, maxEffortPoints: 12 },
            provenance: { source: "user" },
            hardness: "hard",
          },
        },
      },
    });
    const hard = solveWithAlns(await problemFor(doc, undefined, hardSet), opts).days[0];
    expect(hard.status).toBe("ok");
    if (hard.status !== "ok") return;
    for (let i = 1; i < hard.entries.length; i++) {
      const gap = hard.entries[i].startMin - hard.entries[i - 1].departMin;
      expect(gap).toBeGreaterThanOrEqual(hard.legs[i - 1].effectiveMin + 10);
    }
  });
});

describe("E5a objective: blocks and priorities", () => {
  it("a meal block forbids a START inside [start, end) — travel may cross it", async () => {
    const doc = docOf([
      {
        date: "2026-07-07",
        dayStartMin: 9 * 60,
        dayEndMin: 20 * 60,
        stops: [tripStop("fx-01", 30)],
      },
    ]);
    const set = mergePatches(compileFromDoc(doc), {
      days: {
        0: {
          mealBlocks: [
            {
              id: "lunch",
              value: { startMin: 720, endMin: 780 },
              provenance: { source: "user" },
              hardness: "hard",
            },
          ],
        },
      },
    });
    const problem = await problemFor(doc, undefined, set);

    const insideBlock: EngineSchedule = { visits: [visit("fx-01", 0, 720, 720, 750)], dropped: [] };
    expect(
      evaluate(problem, insideBlock).violations.filter((v) => v.code === "meal-block")
    ).toHaveLength(1);

    // Starting exactly at the block's END is legal — half-open.
    const atEnd: EngineSchedule = { visits: [visit("fx-01", 0, 780, 780, 810)], dropped: [] };
    expect(
      evaluate(problem, atEnd).violations.filter((v) => v.code === "meal-block")
    ).toHaveLength(0);

    // A visit already in progress may run through it.
    const spanning: EngineSchedule = { visits: [visit("fx-01", 0, 700, 700, 760)], dropped: [] };
    expect(
      evaluate(problem, spanning).violations.filter((v) => v.code === "meal-block")
    ).toHaveLength(0);
  });

  it("a dropped hard-`must` is infeasible; a dropped `could` is priced", async () => {
    const problem = await twoStopProblem();
    const dropMust: EngineSchedule = {
      visits: [visit("fx-01", 0, 540, 540, 570)],
      dropped: ["fx-12"],
    };
    const e = evaluate(problem, dropMust);
    expect(e.feasible).toBe(false);
    expect(e.violations.filter((v) => v.code === "dropped-must")).toHaveLength(1);
    expect(e.breakdown.dropPenalty).toBe(0); // a must is not priced — it is a breach
  });
});
