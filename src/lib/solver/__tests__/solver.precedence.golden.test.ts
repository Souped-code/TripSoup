// D2.1b done-check: precedence goldens — exhaustive respects a pair, forces a
// non-default order, reports a cycle by its closing pair, and reports precedence
// that is incompatible with an anchor's timing. Plus a heuristic-regime golden.

import { optimize } from "../solver";
import { DEFAULT_SETTINGS } from "../../maps/types";
import type { EffectiveLeg, EffectiveMatrix, SolverStop } from "../types";

const S = DEFAULT_SETTINGS; // driveOverheadMin 10, maxExhaustive 9

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

const stops = (...defs: [string, number][]): SolverStop[] =>
  defs.map(([id, durationMin]) => ({ id, durationMin }));

describe("exhaustive precedence goldens", () => {
  it("respects a simple pair: a symmetric tie is broken by precedence, not lex order", () => {
    // Without precedence the A-B tie resolves to [A,B]; precedence B->A flips it.
    const result = optimize(
      {
        startAtMin: 540,
        startStopId: null,
        endByMin: 1200,
        endStopId: null,
        stops: stops(["A", 30], ["B", 30]),
      },
      matrixOf({ "A-B": 5 }),
      S,
      [{ beforeId: "B", afterId: "A" }]
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.order).toEqual(["B", "A"]);
    expect(result.quality).toBe("optimal");
  });

  it("forces a specific non-default order (C before A on a line from anchor X)", () => {
    // Line X-A-B-C. Effective: adjacent 11, skip 15, full 19. Unconstrained
    // optimum is [A,B,C] (33). Requiring C before A, the cheapest satisfying
    // order is [B,C,A] (15+11+15 = 41), reached before [C,B,A] in enumeration.
    const LINE = matrixOf({ "X-A": 1, "A-B": 1, "B-C": 1, "X-B": 5, "A-C": 5, "X-C": 9 });
    const result = optimize(
      {
        startAtMin: 540,
        startStopId: "X",
        endByMin: 1200,
        endStopId: null,
        stops: stops(["A", 30], ["B", 30], ["C", 30]),
      },
      LINE,
      S,
      [{ beforeId: "C", afterId: "A" }]
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.order).toEqual(["B", "C", "A"]);
    expect(result.totalTravelMin).toBe(41);
  });

  it("a cycle is infeasible and names the pair that closes it", () => {
    const result = optimize(
      {
        startAtMin: 540,
        startStopId: null,
        endByMin: 1200,
        endStopId: null,
        stops: stops(["A", 30], ["B", 30], ["C", 30]),
      },
      matrixOf({ "A-B": 5, "B-C": 5, "A-C": 5 }),
      S,
      [
        { beforeId: "A", afterId: "B" },
        { beforeId: "B", afterId: "C" },
        { beforeId: "C", afterId: "A" },
      ]
    );
    expect(result.status).toBe("infeasible");
    if (result.status !== "infeasible") return;
    expect(result.constraint).toBe("precedence:C->A");
    expect(result.violatedByMin).toBe(0);
    expect(result.message).toContain("C");
    expect(result.message).toContain("A");
  });

  it("precedence incompatible with the end anchor's timing names the pair", () => {
    // Corridor X..Y. [A,B] arrives Y at 633; [B,A] at 641. With endByMin 637,
    // only [A,B] fits — but precedence demands B before A, so no satisfying
    // order is feasible: precedence is the cause, not the raw time window.
    const CORRIDOR = matrixOf({ "X-A": 1, "X-B": 5, "A-B": 1, "A-Y": 5, "B-Y": 1, "X-Y": 9 });
    const result = optimize(
      {
        startAtMin: 540,
        startStopId: "X",
        endByMin: 637,
        endStopId: "Y",
        stops: stops(["A", 30], ["B", 30]),
      },
      CORRIDOR,
      S,
      [{ beforeId: "B", afterId: "A" }]
    );
    expect(result.status).toBe("infeasible");
    if (result.status !== "infeasible") return;
    expect(result.constraint).toBe("precedence:B->A");
    expect(result.violatedByMin).toBe(0);
    expect(result.message).toContain("B");
    expect(result.message).toContain("A");
  });

  it("without the anchor squeeze the same pair solves fine (control)", () => {
    const CORRIDOR = matrixOf({ "X-A": 1, "X-B": 5, "A-B": 1, "A-Y": 5, "B-Y": 1, "X-Y": 9 });
    const result = optimize(
      {
        startAtMin: 540,
        startStopId: "X",
        endByMin: 700,
        endStopId: "Y",
        stops: stops(["A", 30], ["B", 30]),
      },
      CORRIDOR,
      S,
      [{ beforeId: "B", afterId: "A" }]
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.order).toEqual(["B", "A"]);
  });
});

describe("heuristic-regime precedence golden (n > maxExhaustive)", () => {
  // 10 flexible stops -> heuristic path. Deterministic pseudo-random matrix.
  function instance(n: number): { matrix: EffectiveMatrix; ids: string[] } {
    const ids = Array.from({ length: n }, (_, i) => `s${String(i).padStart(2, "0")}`);
    const matrix: EffectiveMatrix = {};
    ids.forEach((a, i) => {
      matrix[a] = {};
      ids.forEach((b, j) => {
        if (a !== b) matrix[a][b] = drive(((i * 7 + j * 13) % 23) + 1);
      });
    });
    return { matrix, ids };
  }

  it("respects precedence and is labelled heuristic", () => {
    const { matrix, ids } = instance(10);
    const pair = { beforeId: "s09", afterId: "s00" }; // force last id before first id
    const result = optimize(
      {
        startAtMin: 0,
        startStopId: null,
        endByMin: 100000,
        endStopId: null,
        stops: ids.map((id) => ({ id, durationMin: 10 })),
      },
      matrix,
      S,
      [pair]
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.quality).toBe("heuristic");
    expect(result.order.indexOf("s09")).toBeLessThan(result.order.indexOf("s00"));
    // determinism: same input, same output
    const again = optimize(
      {
        startAtMin: 0,
        startStopId: null,
        endByMin: 100000,
        endStopId: null,
        stops: ids.map((id) => ({ id, durationMin: 10 })),
      },
      matrix,
      S,
      [pair]
    );
    expect(again).toEqual(result);
  });
});
