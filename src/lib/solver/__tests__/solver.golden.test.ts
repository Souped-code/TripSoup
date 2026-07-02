// P2 done-check: jest goldens — known segments produce known optimal orders,
// hand-computed schedules, and a structured infeasibility report.

import { optimize } from "../solver";
import { DEFAULT_SETTINGS } from "../../maps/types";
import type { EffectiveLeg, EffectiveMatrix, SolverStop } from "../types";
import { FIXTURE_STOPS, fixtureDriveMinutes } from "../../maps/fixtureCity";
import { buildEffectiveMatrix, effectiveMinutes } from "../effectiveMatrix";

const S = DEFAULT_SETTINGS; // driveOverheadMin 10

const drive = (min: number): EffectiveLeg => ({
  mode: "drive",
  walkMin: null,
  driveMin: min,
  chosenBy: "auto",
});

// Symmetric drive-only effective matrix from pair list.
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

describe("hand-computed goldens", () => {
  // Stops on a line X - A - B - C. Raw drive: adjacent 1, skip 5, full 9.
  // Effective (+10 overhead): adjacent 11, skip 15, full 19.
  const LINE = matrixOf({ "X-A": 1, "A-B": 1, "B-C": 1, "X-B": 5, "A-C": 5, "X-C": 9 });

  it("line from a start anchor: optimal order follows the line, schedule exact", () => {
    const result = optimize(
      {
        startAtMin: 540, // 9:00, departing anchor X
        startStopId: "X",
        endByMin: 1200,
        endStopId: null,
        stops: stops(["A", 30], ["B", 30], ["C", 30]),
      },
      LINE,
      S
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.order).toEqual(["A", "B", "C"]);
    expect(result.quality).toBe("optimal");
    // hand-computed: 540 +11 -> A(551..581) +11 -> B(592..622) +11 -> C(633..663)
    expect(result.schedule).toEqual([
      { stopId: "A", arriveMin: 551, departMin: 581 },
      { stopId: "B", arriveMin: 592, departMin: 622 },
      { stopId: "C", arriveMin: 633, departMin: 663 },
    ]);
    expect(result.totalTravelMin).toBe(33);
  });

  // X start anchor, Y end anchor. Raw: X-A 1, X-B 5, A-B 1, A-Y 5, B-Y 1, X-Y 9.
  const CORRIDOR = matrixOf({ "X-A": 1, "X-B": 5, "A-B": 1, "A-Y": 5, "B-Y": 1, "X-Y": 9 });

  it("segment between two anchors: optimal order and end-anchor arrival respected", () => {
    const result = optimize(
      {
        startAtMin: 540,
        startStopId: "X",
        endByMin: 700, // anchor Y starts at 700
        endStopId: "Y",
        stops: stops(["A", 30], ["B", 30]),
      },
      CORRIDOR,
      S
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // [A,B]: 11 + 11 + 11 = 33  vs  [B,A]: 15 + 11 + 15 = 41
    expect(result.order).toEqual(["A", "B"]);
    // 540 +11 A(551..581) +11 B(592..622) +11 -> arrive Y 633 <= 700
    expect(result.totalTravelMin).toBe(33);
    expect(result.schedule[1].departMin + 11).toBeLessThanOrEqual(700);
  });

  it("infeasible: names the violated end-anchor constraint and by how much", () => {
    const result = optimize(
      {
        startAtMin: 540,
        startStopId: "X",
        endByMin: 600, // best possible arrival is 633
        endStopId: "Y",
        stops: stops(["A", 30], ["B", 30]),
      },
      CORRIDOR,
      S
    );
    expect(result.status).toBe("infeasible");
    if (result.status !== "infeasible") return;
    expect(result.constraint).toBe("anchor-start:Y");
    expect(result.violatedByMin).toBe(33); // 633 - 600, the least-violating ordering
    expect(result.message).toContain("Y");
  });

  it("infeasible against the day window when there is no end anchor", () => {
    const result = optimize(
      {
        startAtMin: 540,
        startStopId: "X",
        endByMin: 570, // A alone: arrive 551, depart 581 > 570
        endStopId: null,
        stops: stops(["A", 30]),
      },
      LINE,
      S
    );
    expect(result.status).toBe("infeasible");
    if (result.status !== "infeasible") return;
    expect(result.constraint).toBe("day-window");
    expect(result.violatedByMin).toBe(11); // 581 - 570
  });

  it("tie broken lexicographically by stop id", () => {
    // No anchors, symmetric matrix: [A,B] and [B,A] cost the same.
    const result = optimize(
      {
        startAtMin: 540,
        startStopId: null,
        endByMin: 1200,
        endStopId: null,
        stops: stops(["B", 30], ["A", 30]), // deliberately out of order
      },
      matrixOf({ "A-B": 5 }),
      S
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.order).toEqual(["A", "B"]);
  });

  it("empty segment between two anchors: feasibility is just the boundary leg", () => {
    const ok = optimize(
      { startAtMin: 540, startStopId: "X", endByMin: 700, endStopId: "Y", stops: [] },
      CORRIDOR,
      S
    );
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") expect(ok.totalTravelMin).toBe(19); // X-Y raw 9 + overhead

    const bad = optimize(
      { startAtMin: 540, startStopId: "X", endByMin: 550, endStopId: "Y", stops: [] },
      CORRIDOR,
      S
    );
    expect(bad.status).toBe("infeasible");
  });
});

describe("fixture-city golden (differential)", () => {
  // Real fixture stops + real fixture matrix; the expected order is computed by
  // an INDEPENDENT in-test brute force over effective times, so this catches
  // solver-internal mistakes without being tautological.
  it("solver order equals independent brute-force optimum from fx-01", () => {
    const ids = ["fx-02", "fx-03", "fx-04", "fx-09"];
    const all = ["fx-01", ...ids];
    const byId = new Map(FIXTURE_STOPS.map((s) => [s.id, s]));
    const driveMatrix: Record<string, Record<string, number>> = {};
    const locations: Record<string, { lat: number; lng: number }> = {};
    for (const a of all) {
      driveMatrix[a] = {};
      locations[a] = byId.get(a)!.location;
      for (const b of all) driveMatrix[a][b] = fixtureDriveMinutes(byId.get(a)!, byId.get(b)!);
    }
    const eff = buildEffectiveMatrix(driveMatrix, locations, S);

    // independent brute force
    const perms = (xs: string[]): string[][] =>
      xs.length <= 1
        ? [xs]
        : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
    const travelOf = (order: string[]) => {
      let total = 0;
      let prev = "fx-01";
      for (const id of order) {
        total += effectiveMinutes(eff[prev][id], S);
        prev = id;
      }
      return total;
    };
    const bruteBest = perms([...ids].sort()).reduce((best, p) =>
      travelOf(p) < travelOf(best) ? p : best
    );

    const result = optimize(
      {
        startAtMin: 540,
        startStopId: "fx-01",
        endByMin: 1440,
        endStopId: null,
        stops: ids.map((id) => ({ id, durationMin: 45 })),
      },
      eff,
      S
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.totalTravelMin).toBeCloseTo(travelOf(bruteBest), 10);
    expect(result.order).toEqual(bruteBest);
  });
});
