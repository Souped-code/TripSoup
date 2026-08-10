// E1 spike — generator/evaluator self-check. Run via `npx tsx spike/selfcheck.ts`.
//
// Three things must hold before either module is trusted as the benchmark's
// measurement backbone: every generated instance's planted solution is
// actually feasible under the shared evaluator, generation is deterministic
// from its seed (benchmark artifacts are cached by seed), and the conflict
// path actually produces a detectably infeasible instance. This script
// checks all three across the full size × days × density grid and exits
// non-zero the moment any of them don't hold.

import { evaluate } from "./evaluator";
import { generate, type Density } from "./generator";

const SIZES = [12, 25, 40];
const DAYS = [1, 5, 7];
const DENSITIES: Density[] = ["sparse", "medium", "dense"];
const SEEDS = [1, 2, 3, 4, 5];

let failures = 0;
function fail(msg: string): void {
  failures++;
  console.error(`FAIL: ${msg}`);
}

for (const stops of SIZES) {
  for (const days of DAYS) {
    for (const density of DENSITIES) {
      for (const seed of SEEDS) {
        const label = `size=${stops} days=${days} density=${density} seed=${seed}`;
        try {
          const { problem, planted } = generate({ seed, stops, days, density });
          const result = evaluate(problem, planted);
          if (!result.feasible) {
            fail(`${label}: planted solution infeasible — ${JSON.stringify(result.violations)}`);
            continue;
          }

          // Determinism: same seed/spec must reproduce byte-identical output.
          const repeat = generate({ seed, stops, days, density });
          if (JSON.stringify({ problem, planted }) !== JSON.stringify(repeat)) {
            fail(`${label}: generate() is not deterministic for a fixed seed`);
            continue;
          }

          console.log(`OK ${label} score=${result.score.toFixed(2)}`);
        } catch (err) {
          fail(`${label}: threw ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}

// Conflict path: planted must come back INfeasible with >=1 violation.
const CONFLICT_CASES: Array<{ seed: number; stops: number; days: number; density: Density }> = [
  { seed: 101, stops: 25, days: 5, density: "dense" },
  { seed: 202, stops: 12, days: 1, density: "sparse" },
  { seed: 303, stops: 40, days: 7, density: "medium" },
];

for (const spec of CONFLICT_CASES) {
  const label = `conflict stops=${spec.stops} days=${spec.days} density=${spec.density} seed=${spec.seed}`;
  try {
    const { problem, planted } = generate({ ...spec, conflicts: 2 });
    const result = evaluate(problem, planted);
    if (result.feasible || result.violations.length === 0) {
      fail(`${label}: expected infeasible planted with >=1 violation, got feasible=${result.feasible}`);
      continue;
    }
    console.log(`OK ${label} violations=${result.violations.length}`);
  } catch (err) {
    fail(`${label}: threw ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll selfcheck cells passed.");
