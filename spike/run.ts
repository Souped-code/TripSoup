// E1 race harness — runs both contenders over the benchmark cells and caches
// one artifact per (cell, budget, seed, solver) under spike/artifacts/. Written
// by the ORCHESTRATOR (not a contender's author) so the measurement can't
// inherit either solver's assumptions. Resumable: an existing artifact is
// never re-run — delete a file (or the dir) to force a fresh measurement.
//
// Cell selection: the plan's full grid (sizes×days×densities×budgets×20 seeds
// ×2 solvers ≈ 2,160 solves) is 10+ hours of wall clock on one machine. The
// pre-registered DECISION RULE reads exactly one cell — dense-40×7 @30s — so
// that cell gets the full 20 seeds, and three secondary cells (latency + easy/
// mid sanity) get 10 seeds each. Anything beyond that is spend without a
// decision it could change.
//
// Usage: npx tsx spike/run.ts [--only verdict|secondary] [--solver alns|cpsat]

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { generate } from "./generator";
import { evaluate } from "./evaluator";
import { solveAlns } from "./alns";
import type { SpikeProblem, SpikeSolution } from "./ir";

type Cell = {
  name: string;
  stops: number;
  days: number;
  density: "sparse" | "medium" | "dense";
  budgetMs: number;
  seeds: number[];
};

const seeds = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

// The verdict cell FIRST (it alone feeds the decision rule), then secondaries.
export const CELLS: Cell[] = [
  { name: "VERDICT dense-40x7@30s", stops: 40, days: 7, density: "dense", budgetMs: 30_000, seeds: seeds(20) },
  { name: "dense-40x7@10s", stops: 40, days: 7, density: "dense", budgetMs: 10_000, seeds: seeds(10) },
  { name: "medium-25x5@10s", stops: 25, days: 5, density: "medium", budgetMs: 10_000, seeds: seeds(10) },
  { name: "sparse-12x1@10s", stops: 12, days: 1, density: "sparse", budgetMs: 10_000, seeds: seeds(10) },
];

const ART = path.join(__dirname, "artifacts");

export type Artifact = {
  cell: string;
  solver: "alns" | "cpsat";
  seed: number;
  budgetMs: number;
  feasible: boolean;
  score: number; // Infinity encoded as null in JSON — see save/load
  plantedScore: number;
  wallMs: number;
  violations: string[]; // codes only, for the report's failure taxonomy
  solverStatus?: string; // cpsat only
};

function artFile(cell: Cell, solver: string, seed: number): string {
  const slug = `${cell.stops}x${cell.days}-${cell.density}-${cell.budgetMs}ms-s${seed}-${solver}`;
  return path.join(ART, `${slug}.json`);
}

function saveArtifact(file: string, a: Artifact): void {
  fs.writeFileSync(file, JSON.stringify({ ...a, score: Number.isFinite(a.score) ? a.score : null }));
}

function runCpsat(problem: SpikeProblem, budgetMs: number, seed: number): { sol: SpikeSolution; wallMs: number; status: string } {
  const t0 = Date.now();
  // Budget passed to the solver; the harness allows 3x + 30s before declaring
  // a hang (CP-SAT model build time is outside its own internal budget).
  const out = execFileSync("python", [path.join(__dirname, "cpsat", "solve.py"), "--budget-ms", String(budgetMs), "--seed", String(seed)], {
    input: JSON.stringify(problem),
    maxBuffer: 64 * 1024 * 1024,
    timeout: budgetMs * 3 + 30_000,
  }).toString();
  const parsed = JSON.parse(out) as { visits: SpikeSolution["visits"]; dropped: string[]; solverStatus: string };
  return { sol: { visits: parsed.visits, dropped: parsed.dropped }, wallMs: Date.now() - t0, status: parsed.solverStatus };
}

async function main(): Promise<void> {
  fs.mkdirSync(ART, { recursive: true });
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const solverFilter = process.argv.includes("--solver") ? process.argv[process.argv.indexOf("--solver") + 1] : null;

  const cells = CELLS.filter((c) => (only === "verdict" ? c.name.startsWith("VERDICT") : only === "secondary" ? !c.name.startsWith("VERDICT") : true));

  for (const cell of cells) {
    for (const seed of cell.seeds) {
      // Same instance for both solvers — the race is on identical problems.
      const { problem, planted } = generate({ seed, stops: cell.stops, days: cell.days, density: cell.density });
      const plantedScore = evaluate(problem, planted).score;

      for (const solver of ["alns", "cpsat"] as const) {
        if (solverFilter && solver !== solverFilter) continue;
        const file = artFile(cell, solver, seed);
        if (fs.existsSync(file)) continue; // resumable

        let sol: SpikeSolution;
        let wallMs: number;
        let status: string | undefined;
        try {
          if (solver === "alns") {
            const t0 = Date.now();
            sol = solveAlns(problem, { seed, timeBudgetMs: cell.budgetMs });
            wallMs = Date.now() - t0;
          } else {
            const r = runCpsat(problem, cell.budgetMs, seed);
            sol = r.sol;
            wallMs = r.wallMs;
            status = r.status;
          }
        } catch (e) {
          // A crashed/hung solve is a REAL data point (feasibility rate), not
          // a harness failure — record it and move on.
          saveArtifact(file, {
            cell: cell.name, solver, seed, budgetMs: cell.budgetMs, feasible: false,
            score: Infinity, plantedScore, wallMs: -1,
            violations: ["solver-crash: " + (e instanceof Error ? e.message.slice(0, 120) : String(e))],
          });
          console.log(`CRASH ${cell.name} s${seed} ${solver}`);
          continue;
        }

        const ev = evaluate(problem, sol);
        saveArtifact(file, {
          cell: cell.name, solver, seed, budgetMs: cell.budgetMs, feasible: ev.feasible,
          score: ev.score, plantedScore, wallMs,
          violations: ev.feasible ? [] : [...new Set(ev.violations.map((v) => v.code))],
          ...(status ? { solverStatus: status } : {}),
        });
        console.log(
          `${cell.name} s${seed} ${solver}: feasible=${ev.feasible} score=${Number.isFinite(ev.score) ? ev.score.toFixed(0) : "inf"} wall=${(wallMs / 1000).toFixed(1)}s planted=${plantedScore.toFixed(0)}`
        );
      }
    }
  }
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
