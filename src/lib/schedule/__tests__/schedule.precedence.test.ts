// D2.1b done-check: day-level precedence routing. Within-segment pairs are
// solved by the solver; cross-segment same-day pairs are validated post-assembly
// and surface a structured infeasibility; cross-day pairs become margin notes
// and the plan still succeeds.

import { planDay } from "../schedule";
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

function matrixOf(pairs: Record<string, number>): EffectiveMatrix {
  const m: EffectiveMatrix = {};
  for (const [key, min] of Object.entries(pairs)) {
    const [a, b] = key.split("-");
    (m[a] ??= {})[b] = drive(min);
    (m[b] ??= {})[a] = drive(min);
  }
  return m;
}

describe("within-segment precedence is solved by the solver", () => {
  // No anchors -> one segment. Effective: A-B 12, B-C 12, A-C 18. Unconstrained
  // optimum is [A,B,C] (24). Requiring C before A yields [C,B,A] (also 24).
  const MATRIX = matrixOf({ "A-B": 2, "B-C": 2, "A-C": 8 });
  const DAY: Day = {
    date: "2026-07-10",
    dayStartMin: 540,
    dayEndMin: 1320,
    stops: [
      { id: "A", name: "Alpha", durationMin: 30 },
      { id: "B", name: "Bravo", durationMin: 30 },
      { id: "C", name: "Charlie", durationMin: 30 },
    ],
  };

  it("no precedence: default optimum", () => {
    const plan = planDay(DAY, MATRIX, S);
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    expect(plan.order).toEqual(["A", "B", "C"]);
  });

  it("precedence C before A reorders within the segment", () => {
    const plan = planDay(
      { ...DAY, precedence: [{ beforeId: "C", afterId: "A" }] },
      MATRIX,
      S
    );
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    expect(plan.order).toEqual(["C", "B", "A"]);
    expect(plan.order.indexOf("C")).toBeLessThan(plan.order.indexOf("A"));
    expect(plan.marginNotes).toBeUndefined();
  });
});

describe("cross-segment same-day precedence is validated post-assembly", () => {
  // A (before anchor) | L anchor @12:00 | B (after anchor). The anchor forces
  // A before B, so a wish for B before A cannot be honoured.
  const MATRIX = matrixOf({ "A-L": 2, "L-B": 2, "A-B": 2 });
  const DAY: Day = {
    date: "2026-07-10",
    dayStartMin: 540,
    dayEndMin: 1320,
    stops: [
      { id: "A", name: "Alpha", durationMin: 45 },
      { id: "L", name: "Lunch", durationMin: 60, anchor: { startMin: 720 } },
      { id: "B", name: "Bravo", durationMin: 45 },
    ],
  };

  it("without the wish the day plans fine", () => {
    const plan = planDay(DAY, MATRIX, S);
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    expect(plan.order).toEqual(["A", "L", "B"]);
  });

  it("B before A straddles the anchor and reports structured precedence infeasibility", () => {
    const plan = planDay(
      { ...DAY, precedence: [{ beforeId: "B", afterId: "A" }] },
      MATRIX,
      S
    );
    expect(plan.status).toBe("infeasible");
    if (plan.status !== "infeasible") return;
    expect(plan.constraint).toBe("precedence:B->A");
    expect(plan.violatedByMin).toBe(0);
    expect(plan.message).toContain("Bravo");
    expect(plan.message).toContain("Alpha");
    expect(plan.message).toMatch(/moving the stop or the anchor/i);
  });

  it("the satisfiable direction (A before B) plans fine across the anchor", () => {
    const plan = planDay(
      { ...DAY, precedence: [{ beforeId: "A", afterId: "B" }] },
      MATRIX,
      S
    );
    expect(plan.status).toBe("ok");
  });
});

describe("cross-day / unknown precedence is a margin note, plan still succeeds", () => {
  const MATRIX = matrixOf({ "A-B": 2 });
  const DAY: Day = {
    date: "2026-07-10",
    dayStartMin: 540,
    dayEndMin: 1320,
    stops: [
      { id: "A", name: "Alpha", durationMin: 30 },
      { id: "B", name: "Bravo", durationMin: 30 },
    ],
  };

  it("a pair referencing an off-day stop surfaces as a margin note", () => {
    const plan = planDay(
      { ...DAY, precedence: [{ beforeId: "A", afterId: "Z" }] },
      MATRIX,
      S
    );
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    expect(plan.order).toEqual(["A", "B"]);
    expect(plan.marginNotes).toHaveLength(1);
    expect(plan.marginNotes![0]).toContain("Alpha");
    expect(plan.marginNotes![0]).toMatch(/another day/i);
  });
});
