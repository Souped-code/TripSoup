// P3 done-check: arrive/depart arithmetic against hand-computed goldens;
// slack computation; heuristic label propagates. Plus the §2 toggle path:
// re-times downstream without re-ordering, with a fresh feasibility check.

import { applyLegModes, planDay, rescheduleDay } from "../schedule";
import { DEFAULT_SETTINGS } from "../../maps/types";
import type { EffectiveLeg, EffectiveMatrix } from "../../solver/types";
import type { Day } from "../types";

const S = DEFAULT_SETTINGS; // overhead 10

const drive = (min: number): EffectiveLeg => ({
  mode: "drive",
  walkMin: null,
  driveMin: min,
  chosenBy: "auto",
});

function matrixOf(pairs: Record<string, EffectiveLeg>): EffectiveMatrix {
  const m: EffectiveMatrix = {};
  for (const [key, leg] of Object.entries(pairs)) {
    const [a, b] = key.split("-");
    (m[a] ??= {})[b] = { ...leg };
    (m[b] ??= {})[a] = { ...leg };
  }
  return m;
}

describe("planDay — hand-computed full-day golden", () => {
  // Day 9:00-22:00. List: A, B, [L lunch @12:00 x60], C, D, [S show @19:00 x90].
  // Raw drive minutes (effective = +10): A-B 2, B-L 3, A-L 6, L-C 2, C-D 2,
  // D-S 3, L-D 6, C-S 6, L-S 10, all others 20.
  const MATRIX = matrixOf({
    "A-B": drive(2),
    "B-L": drive(3),
    "A-L": drive(6),
    "L-C": drive(2),
    "C-D": drive(2),
    "D-S": drive(3),
    "L-D": drive(6),
    "C-S": drive(6),
    "L-S": drive(10),
    "A-C": drive(20),
    "A-D": drive(20),
    "A-S": drive(20),
    "B-C": drive(20),
    "B-D": drive(20),
    "B-S": drive(20),
  });

  const DAY: Day = {
    date: "2026-07-10",
    dayStartMin: 540,
    dayEndMin: 1320,
    stops: [
      { id: "A", name: "Stop A", durationMin: 45 },
      { id: "B", name: "Stop B", durationMin: 60 },
      { id: "L", name: "Lunch", durationMin: 60, anchor: { startMin: 720 } },
      { id: "C", name: "Stop C", durationMin: 30 },
      { id: "D", name: "Stop D", durationMin: 45 },
      { id: "S", name: "Show", durationMin: 90, anchor: { startMin: 1140 } },
    ],
  };

  const plan = planDay(DAY, MATRIX, S);

  it("chooses the optimal order in each segment and keeps anchors in place", () => {
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    // seg1: [A,B] (travel 12+13=25) beats [B,A] (12+16=28)
    // seg2: [C,D] (12+12+13=37) beats [D,C] (16+12+16=44)
    expect(plan.order).toEqual(["A", "B", "L", "C", "D", "S"]);
    expect(plan.quality).toBe("optimal");
    expect(plan.totalTravelMin).toBe(62); // 12+13+12+12+13
  });

  it("arrive/start/depart/wait per stop match hand arithmetic exactly", () => {
    if (plan.status !== "ok") return;
    expect(plan.entries).toEqual([
      { stopId: "A", kind: "flexible", arriveMin: 540, startMin: 540, departMin: 585, waitMin: 0 },
      { stopId: "B", kind: "flexible", arriveMin: 597, startMin: 597, departMin: 657, waitMin: 0 },
      { stopId: "L", kind: "anchor", arriveMin: 670, startMin: 720, departMin: 780, waitMin: 50 },
      { stopId: "C", kind: "flexible", arriveMin: 792, startMin: 792, departMin: 822, waitMin: 0 },
      { stopId: "D", kind: "flexible", arriveMin: 834, startMin: 834, departMin: 879, waitMin: 0 },
      { stopId: "S", kind: "anchor", arriveMin: 892, startMin: 1140, departMin: 1230, waitMin: 248 },
    ]);
  });

  it("legs carry durations and depart/arrive; slack at anchors and day end", () => {
    if (plan.status !== "ok") return;
    expect(plan.legs).toHaveLength(5);
    expect(plan.legs[0]).toMatchObject({ fromId: "A", toId: "B", effectiveMin: 12, departMin: 585, arriveMin: 597 });
    expect(plan.legs[1]).toMatchObject({ fromId: "B", toId: "L", effectiveMin: 13 });
    expect(plan.daySlackMin).toBe(90); // 1320 - 1230
  });

  it("day window infeasibility is reported, not truncated", () => {
    const tight = planDay({ ...DAY, dayEndMin: 1200 }, MATRIX, S); // show ends 1230
    expect(tight.status).toBe("infeasible");
    if (tight.status !== "infeasible") return;
    expect(tight.constraint).toBe("day-window");
    expect(tight.violatedByMin).toBe(30);
  });

  it("anchor that cannot be reached in time names itself", () => {
    const early = planDay(
      {
        ...DAY,
        stops: DAY.stops.map((s) => (s.id === "L" ? { ...s, anchor: { startMin: 560 } } : s)),
      },
      MATRIX,
      S
    );
    expect(early.status).toBe("infeasible");
    if (early.status !== "infeasible") return;
    expect(early.constraint).toBe("anchor-start:L");
  });
});

describe("validation surface", () => {
  const M = matrixOf({ "A-B": drive(2) });
  const base: Day = {
    date: "2026-07-10",
    dayStartMin: 540,
    dayEndMin: 1320,
    stops: [
      { id: "A", name: "A", durationMin: 30, anchor: { startMin: 900 } },
      { id: "B", name: "B", durationMin: 30, anchor: { startMin: 600 } },
    ],
  };

  it("anchors out of chronological order -> structured infeasibility, actionable", () => {
    const r = planDay(base, M, S);
    expect(r.status).toBe("infeasible");
    if (r.status !== "infeasible") return;
    expect(r.constraint).toBe("anchor-order:B");
    expect(r.message).toMatch(/reorder/i);
  });

  it("anchor outside the day window is named", () => {
    const r = planDay(
      {
        ...base,
        stops: [{ id: "A", name: "A", durationMin: 30, anchor: { startMin: 1400 } }],
      },
      M,
      S
    );
    expect(r.status).toBe("infeasible");
    if (r.status !== "infeasible") return;
    expect(r.constraint).toBe("anchor-outside-day:A");
  });
});

describe("heuristic label propagates (P3 done-check)", () => {
  it("a day whose segment exceeds maxExhaustive is labelled heuristic", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `s${String(i).padStart(2, "0")}`);
    const matrix: EffectiveMatrix = {};
    ids.forEach((a, i) => {
      matrix[a] = {};
      ids.forEach((b, j) => {
        if (a !== b) matrix[a][b] = drive(((i * 7 + j * 13) % 23) + 1);
      });
    });
    const day: Day = {
      date: "2026-07-11",
      dayStartMin: 0,
      dayEndMin: 100000,
      stops: ids.map((id) => ({ id, name: id, durationMin: 10 })),
    };
    const plan = planDay(day, matrix, S);
    expect(plan.status).toBe("ok");
    if (plan.status === "ok") expect(plan.quality).toBe("heuristic");
  });
});

describe("per-leg toggle: re-times downstream without re-ordering (§2)", () => {
  // A-B walk-eligible: walk 9 vs drive 2 + 10 = 12 -> auto picks walk.
  const eligible: EffectiveLeg = { mode: "walk", walkMin: 9, driveMin: 2, chosenBy: "auto" };
  const M = matrixOf({ "A-B": eligible });
  const day: Day = {
    date: "2026-07-12",
    dayStartMin: 540,
    dayEndMin: 800,
    stops: [
      { id: "A", name: "A", durationMin: 45 },
      { id: "B", name: "B", durationMin: 60 },
    ],
  };

  it("auto plan walks the eligible leg", () => {
    const plan = planDay(day, M, S);
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    expect(plan.order).toEqual(["A", "B"]);
    expect(plan.legs[0]).toMatchObject({ mode: "walk", effectiveMin: 9, chosenBy: "auto" });
    expect(plan.entries[1]).toMatchObject({ arriveMin: 594, departMin: 654 });
  });

  it("toggling to drive shifts downstream times, keeps the order, marks chosenBy user", () => {
    const plan = planDay(day, M, S);
    if (plan.status !== "ok") return;
    const toggled = applyLegModes(M, [{ fromId: "A", toId: "B", mode: "drive" }]);
    const rescheduled = rescheduleDay(day, plan.order, toggled, S);
    expect(rescheduled.status).toBe("ok");
    if (rescheduled.status !== "ok") return;
    expect(rescheduled.order).toEqual(plan.order); // no re-ordering
    expect(rescheduled.legs[0]).toMatchObject({
      mode: "drive",
      effectiveMin: 12, // 2 + overhead 10
      chosenBy: "user",
      walkMin: 9, // both times still offered
    });
    expect(rescheduled.entries[1]).toMatchObject({ arriveMin: 597, departMin: 657 }); // +3
  });

  it("a toggle that breaks feasibility resurfaces as a report", () => {
    const tightDay = { ...day, dayEndMin: 655 }; // walk: ends 654 ok; drive: 657 over
    const plan = planDay(tightDay, M, S);
    expect(plan.status).toBe("ok");
    const toggled = applyLegModes(M, [{ fromId: "A", toId: "B", mode: "drive" }]);
    if (plan.status !== "ok") return;
    const rescheduled = rescheduleDay(tightDay, plan.order, toggled, S);
    expect(rescheduled.status).toBe("infeasible");
    if (rescheduled.status !== "infeasible") return;
    expect(rescheduled.constraint).toBe("day-window");
    expect(rescheduled.violatedByMin).toBe(2);
  });

  it("toggling an ineligible leg to walk is refused loudly", () => {
    const M2 = matrixOf({ "A-B": drive(20) });
    expect(() => applyLegModes(M2, [{ fromId: "A", toId: "B", mode: "walk" }])).toThrow(
      /not walk-eligible/
    );
  });

  it("applyLegModes does not mutate the input matrix", () => {
    const before = JSON.stringify(M);
    applyLegModes(M, [{ fromId: "A", toId: "B", mode: "drive" }]);
    expect(JSON.stringify(M)).toBe(before);
  });
});
