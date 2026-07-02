// P2 done-check: cap behaviour at 9 / 10 / 15 / 16 stops (§2 method-by-size;
// thresholds are settings values, behaviours are spec).

import { optimize } from "../solver";
import { DEFAULT_SETTINGS } from "../../maps/types";
import type { EffectiveLeg, EffectiveMatrix, Segment } from "../types";

const S = DEFAULT_SETTINGS; // maxExhaustive 9, maxHeuristic 15

// Deterministic pseudo-random full matrix over n stop ids (no anchors, so the
// 9-stop exhaustive case stays fast: first leg is free).
function instanceOf(n: number): { segment: Segment; matrix: EffectiveMatrix } {
  const ids = Array.from({ length: n }, (_, i) => `s${String(i).padStart(2, "0")}`);
  const matrix: EffectiveMatrix = {};
  ids.forEach((a, i) => {
    matrix[a] = {};
    ids.forEach((b, j) => {
      if (a === b) return;
      const leg: EffectiveLeg = {
        mode: "drive",
        walkMin: null,
        driveMin: ((i * 7 + j * 13) % 23) + 1,
        chosenBy: "auto",
      };
      matrix[a][b] = leg;
    });
  });
  return {
    segment: {
      startAtMin: 0,
      startStopId: null,
      endByMin: 100000,
      endStopId: null,
      stops: ids.map((id) => ({ id, durationMin: 10 })),
    },
    matrix,
  };
}

describe("cap behaviour (§2)", () => {
  it("9 stops -> exhaustive, quality optimal", () => {
    const { segment, matrix } = instanceOf(9);
    const r = optimize(segment, matrix, S);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.quality).toBe("optimal");
  });

  it("10 stops -> heuristic, and the label says so", () => {
    const { segment, matrix } = instanceOf(10);
    const r = optimize(segment, matrix, S);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.quality).toBe("heuristic");
  });

  it("15 stops -> still heuristic (upper bound inclusive)", () => {
    const { segment, matrix } = instanceOf(15);
    const r = optimize(segment, matrix, S);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.quality).toBe("heuristic");
  });

  it("16 stops -> rejected with an actionable error", () => {
    const { segment, matrix } = instanceOf(16);
    const r = optimize(segment, matrix, S);
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") {
      expect(r.message).toContain("16");
      expect(r.message).toMatch(/split the segment or add an anchor/i);
    }
  });

  it("thresholds are settings, not constants: maxExhaustive 3 flips a 4-stop segment to heuristic", () => {
    const { segment, matrix } = instanceOf(4);
    const r = optimize(segment, matrix, { ...S, maxExhaustive: 3 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.quality).toBe("heuristic");
  });
});
