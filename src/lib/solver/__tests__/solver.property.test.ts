// P2 done-check: property tests — anchors never move, every stop appears
// exactly once, determinism across 100 runs (and input-order invariance).

import fc from "fast-check";
import { optimize } from "../solver";
import { effectiveMinutes } from "../effectiveMatrix";
import { DEFAULT_SETTINGS } from "../../maps/types";
import type { EffectiveLeg, EffectiveMatrix, Segment, SolverStop } from "../types";

const S = DEFAULT_SETTINGS;

// Arbitrary: a segment with n flexible stops (ids s0..s{n-1} plus optional
// boundary anchors) and a full random drive-only effective matrix.
type Instance = { segment: Segment; matrix: EffectiveMatrix };

const instanceArb = (minStops: number, maxStops: number): fc.Arbitrary<Instance> =>
  fc
    .record({
      n: fc.integer({ min: minStops, max: maxStops }),
      hasStartAnchor: fc.boolean(),
      hasEndAnchor: fc.boolean(),
      durations: fc.array(fc.integer({ min: 10, max: 60 }), {
        minLength: maxStops,
        maxLength: maxStops,
      }),
      driveSeed: fc.array(fc.integer({ min: 1, max: 30 }), {
        minLength: (maxStops + 2) ** 2,
        maxLength: (maxStops + 2) ** 2,
      }),
      endBudget: fc.integer({ min: 0, max: 900 }),
    })
    .map(({ n, hasStartAnchor, hasEndAnchor, durations, driveSeed, endBudget }) => {
      const stopIds = Array.from({ length: n }, (_, i) => `s${i}`);
      const allIds = [...stopIds, "START", "END"];
      const leg = (min: number): EffectiveLeg => ({
        mode: "drive",
        walkMin: null,
        driveMin: min,
        chosenBy: "auto",
      });
      const matrix: EffectiveMatrix = {};
      allIds.forEach((a, i) => {
        matrix[a] = {};
        allIds.forEach((b, j) => {
          if (a !== b) matrix[a][b] = leg(driveSeed[i * (maxStops + 2) + j]);
        });
      });
      const stops: SolverStop[] = stopIds.map((id, i) => ({ id, durationMin: durations[i] }));
      const segment: Segment = {
        startAtMin: 540,
        startStopId: hasStartAnchor ? "START" : null,
        endByMin: 540 + endBudget,
        endStopId: hasEndAnchor ? "END" : null,
        stops,
      };
      return { segment, matrix };
    });

describe("solver properties (exhaustive regime, n <= 5)", () => {
  it("every stop appears exactly once in any ok order", () => {
    fc.assert(
      fc.property(instanceArb(1, 5), ({ segment, matrix }) => {
        const r = optimize(segment, matrix, S);
        if (r.status !== "ok") return true;
        const expected = segment.stops.map((s) => s.id).sort();
        expect([...r.order].sort()).toEqual(expected);
        expect(r.schedule.map((e) => e.stopId)).toEqual(r.order);
        return true;
      }),
      { numRuns: 100 }
    );
  });

  it("anchors never move: schedule starts at the boundary and ends inside it", () => {
    fc.assert(
      fc.property(instanceArb(1, 5), ({ segment, matrix }) => {
        const r = optimize(segment, matrix, S);
        if (r.status !== "ok") return true;
        // start boundary honoured
        const first = r.schedule[0];
        if (segment.startStopId === null) {
          expect(first.arriveMin).toBe(segment.startAtMin);
        } else {
          const inbound = effectiveMinutes(matrix[segment.startStopId][first.stopId], S);
          expect(first.arriveMin).toBe(segment.startAtMin + inbound);
        }
        // internal arithmetic consistent
        for (let i = 0; i < r.schedule.length; i++) {
          const e = r.schedule[i];
          const stop = segment.stops.find((s) => s.id === e.stopId)!;
          expect(e.departMin).toBe(e.arriveMin + stop.durationMin);
          if (i > 0) {
            const legMin = effectiveMinutes(matrix[r.schedule[i - 1].stopId][e.stopId], S);
            expect(e.arriveMin).toBe(r.schedule[i - 1].departMin + legMin);
          }
        }
        // end boundary honoured
        const last = r.schedule[r.schedule.length - 1];
        const endArrival =
          segment.endStopId === null
            ? last.departMin
            : last.departMin + effectiveMinutes(matrix[last.stopId][segment.endStopId], S);
        expect(endArrival).toBeLessThanOrEqual(segment.endByMin);
        return true;
      }),
      { numRuns: 100 }
    );
  });

  it("infeasible results name a constraint and a positive violation", () => {
    fc.assert(
      fc.property(instanceArb(1, 5), ({ segment, matrix }) => {
        const r = optimize(segment, matrix, S);
        if (r.status !== "infeasible") return true;
        expect(r.constraint).toMatch(/^(anchor-start:|day-window$)/);
        expect(r.violatedByMin).toBeGreaterThan(0);
        return true;
      }),
      { numRuns: 100 }
    );
  });

  it("input stop-array order never affects the result", () => {
    fc.assert(
      fc.property(
        instanceArb(2, 5).chain((inst) =>
          fc
            .shuffledSubarray(inst.segment.stops, {
              minLength: inst.segment.stops.length,
              maxLength: inst.segment.stops.length,
            })
            .map((shuffled) => ({ inst, shuffled }))
        ),
        ({ inst, shuffled }) => {
          const a = optimize(inst.segment, inst.matrix, S);
          const b = optimize({ ...inst.segment, stops: shuffled }, inst.matrix, S);
          expect(b).toEqual(a);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe("determinism across 100 runs (spec-literal)", () => {
  it("same input, same output, 100 consecutive runs — exhaustive regime", () => {
    const sample = fc.sample(instanceArb(4, 5), { numRuns: 1, seed: 42 })[0];
    const first = optimize(sample.segment, sample.matrix, S);
    for (let i = 0; i < 100; i++) {
      expect(optimize(sample.segment, sample.matrix, S)).toEqual(first);
    }
  });

  it("same input, same output, 100 consecutive runs — heuristic regime", () => {
    const sample = fc.sample(instanceArb(11, 11), { numRuns: 1, seed: 7 })[0];
    const first = optimize(sample.segment, sample.matrix, S);
    expect(first.status === "ok" ? first.quality : "").toBe("heuristic");
    for (let i = 0; i < 100; i++) {
      expect(optimize(sample.segment, sample.matrix, S)).toEqual(first);
    }
  });
});

describe("solver properties (heuristic regime, n = 10..12)", () => {
  it("every stop exactly once, boundaries honoured, labelled heuristic", () => {
    fc.assert(
      fc.property(instanceArb(10, 12), ({ segment, matrix }) => {
        const r = optimize(segment, matrix, S);
        if (r.status !== "ok") return true;
        expect(r.quality).toBe("heuristic");
        expect([...r.order].sort()).toEqual(segment.stops.map((s) => s.id).sort());
        const last = r.schedule[r.schedule.length - 1];
        const endArrival =
          segment.endStopId === null
            ? last.departMin
            : last.departMin + effectiveMinutes(matrix[last.stopId][segment.endStopId], S);
        expect(endArrival).toBeLessThanOrEqual(segment.endByMin);
        return true;
      }),
      { numRuns: 25 }
    );
  });
});
