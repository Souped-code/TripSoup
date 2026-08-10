// E5b MUST-DO 5 (E5a audit handoff): "decide quality-regression harness vs
// spike baselines (own or waive)." Owned here.
//
// Three seeded 25-stop-occurrence fixture docs, solved at a FIXED
// (seed, iterCap) — never a wall-clock budget, so this can never flake on a
// loaded CI box (same rationale as src/lib/engine/__tests__/determinism.test.ts)
// — and scored with the engine's OWN objective (src/lib/engine/evaluate.ts's
// weights, exported via src/lib/engine/index.ts). The three pinned baselines
// below were captured from a real run of this exact test against the engine
// as it stood at E5b (commit noted in STATE.md's E5b entry); a tolerance
// TIGHTER than the 5% ceiling the roadmap allows (1%) absorbs
// floating-point-ordering noise across machines/Node versions without
// silently accepting a real quality regression. A future INTENTIONAL engine
// change that moves these scores must update the pinned numbers here,
// consciously — that is the whole point of a regression harness.
//
// This is a QUALITY guard on solve OUTPUT, not a behavioural/API test — it
// imports only the engine's public surface (src/lib/engine/index.ts) plus its
// own test-support fixtures (src/lib/engine/__fixtures__/tripFixtures.ts,
// already used the same way by every other engine test), never anything
// under src/lib/engine/ that index.ts doesn't itself export.

import { solveWithAlns, WEIGHT_TRAVEL, WEIGHT_WAIT, type EngineProblem } from "../engine";
import {
  ALL_FIXTURE_IDS,
  docOf,
  everyDay,
  problemFor,
  tripStop,
  tripStopWithHours,
  withHours,
} from "../engine/__fixtures__/tripFixtures";
import type { TripDay } from "../store/types";

const SEED = 20260810;
// Generous and fixed — see determinism.test.ts's header for why a pinned
// iterCap (not a wall-clock budget) is what makes a score reproducible byte
// for byte across machines.
const ITER_CAP = 60_000;

function scoreOf(breakdown: {
  travelMin: number;
  waitMin: number;
  dropPenalty: number;
  compressionPenalty: number;
  softViolations: number;
}): number {
  return (
    breakdown.travelMin * WEIGHT_TRAVEL +
    breakdown.waitMin * WEIGHT_WAIT +
    breakdown.dropPenalty +
    breakdown.compressionPenalty +
    breakdown.softViolations
  );
}

function idAt(cursor: number): string {
  return ALL_FIXTURE_IDS[cursor % ALL_FIXTURE_IDS.length];
}

// ---------------------------------------------------------------------------
// Fixture A — 5 days x 5 stops, a handful of anchors, one hours-bound stop
// per day. Moderate density, moderate constraint mix.
// ---------------------------------------------------------------------------
async function fixtureA(): Promise<EngineProblem> {
  const days: TripDay[] = [];
  let cursor = 0;
  for (let d = 0; d < 5; d++) {
    const stops = [];
    for (let k = 0; k < 5; k++) {
      const id = idAt(cursor);
      const duration = 30 + ((cursor * 11) % 4) * 15;
      cursor++;
      if (k === 0) {
        stops.push(withHours(tripStop(id, duration), everyDay(9 * 60, 18 * 60)));
      } else if (k === 2) {
        stops.push(tripStop(id, duration, 13 * 60 + d * 10));
      } else {
        stops.push(tripStop(id, duration));
      }
    }
    days.push({
      date: `2026-09-0${d + 1}`,
      dayStartMin: 9 * 60,
      dayEndMin: 20 * 60,
      stops,
    });
  }
  const doc = docOf(days, "quality-fixture-a");
  return problemFor(doc);
}

// ---------------------------------------------------------------------------
// Fixture B — 3 days (9/8/8 = 25), denser per-day, one precedence pair per
// day, tighter day windows.
// ---------------------------------------------------------------------------
async function fixtureB(): Promise<EngineProblem> {
  const counts = [9, 8, 8];
  const days: TripDay[] = [];
  let cursor = 100; // different slice of the fixture-id cycle than A/C
  for (let d = 0; d < counts.length; d++) {
    const stops = [];
    for (let k = 0; k < counts[d]; k++) {
      const id = idAt(cursor);
      const duration = 25 + ((cursor * 13) % 5) * 10;
      cursor++;
      stops.push(k === 1 ? tripStop(id, duration, 11 * 60 + d * 15) : tripStop(id, duration));
    }
    days.push({
      date: `2026-09-1${d + 1}`,
      dayStartMin: 9 * 60,
      dayEndMin: 19 * 60,
      stops,
      precedence: [{ beforeId: stops[0].id, afterId: stops[stops.length - 1].id }],
    });
  }
  const doc = docOf(days, "quality-fixture-b");
  return problemFor(doc);
}

// ---------------------------------------------------------------------------
// Fixture C — 7 days, sparser (25 total: 4/4/4/3/4/3/3), real fixture-city
// hours on every third stop, no anchors — the "wide and shallow" shape.
// ---------------------------------------------------------------------------
async function fixtureC(): Promise<EngineProblem> {
  const counts = [4, 4, 4, 3, 4, 3, 3];
  const days: TripDay[] = [];
  let cursor = 3;
  for (let d = 0; d < counts.length; d++) {
    const stops = [];
    for (let k = 0; k < counts[d]; k++) {
      const id = idAt(cursor);
      const duration = 40 + ((cursor * 17) % 3) * 20;
      cursor++;
      stops.push(k % 3 === 0 ? tripStopWithHours(id, duration) : tripStop(id, duration));
    }
    days.push({
      date: `2026-10-0${d + 1}`,
      dayStartMin: 9 * 60,
      dayEndMin: 21 * 60,
      stops,
    });
  }
  const doc = docOf(days, "quality-fixture-c");
  return problemFor(doc);
}

// Pinned from a real, twice-repeated run of this exact test at E5b (same
// numbers both times, confirming determinism before pinning — see
// STATE.md's E5b entry for the commit these were captured against).
const FIXTURES: Array<{ name: string; build: () => Promise<EngineProblem>; baselineScore: number }> = [
  { name: "A (5x5, anchors + one hours-bound stop/day)", build: fixtureA, baselineScore: 240.62855526476727 },
  { name: "B (9/8/8, dense + daily precedence)", build: fixtureB, baselineScore: 483.99631870490754 },
  { name: "C (7 days sparse, real fixture-city hours)", build: fixtureC, baselineScore: 234.61841657127619 },
];

describe("engine quality regression (E5b MUST-DO 5)", () => {
  it.each(FIXTURES)("$name stays within 1% of its pinned baseline score", async ({ build, baselineScore }) => {
    const problem = await build();
    expect(problem.nodes.length).toBe(25);

    const solution = solveWithAlns(problem, { seed: SEED, timeBudgetMs: Infinity, iterCap: ITER_CAP });
    const score = scoreOf(solution.objectiveBreakdown);

    // Tolerance is 1% — tighter than the 5% ceiling the roadmap allows — to
    // absorb only floating-point-ordering noise across machines/Node
    // versions, never a real quality regression. An INTENTIONAL engine
    // change that moves these scores must update baselineScore above,
    // consciously (that is the point of pinning actual values).
    expect(score).toBeGreaterThanOrEqual(baselineScore * 0.99);
    expect(score).toBeLessThanOrEqual(baselineScore * 1.01);
  });
});
