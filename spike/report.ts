// E1 report — reads cached artifacts and prints the metric table plus the
// PRE-REGISTERED verdict. The rule was fixed in the Chris-approved plan BEFORE
// any measurement ran (spike integrity — the rule cannot chase the data):
//
//   CP-SAT ships ONLY if, on the VERDICT cell (dense-40x7 @30s):
//     (i)  it finds a feasible solution in >= 10 percentage points more
//          instances than ALNS, OR
//     (ii) its mean score (over instances where BOTH are feasible) beats
//          ALNS's by >= 15%,
//   AND its p95 wall time fits the 30s budget (round-trip allowance included).
//   Otherwise — ties, mixed evidence, or CP-SAT latency overrun — TS ALNS
//   ships. The loser survives behind the E5 SolverEngine port either way.
//
// Usage: npx tsx spike/report.ts

import * as fs from "fs";
import * as path from "path";
import type { Artifact } from "./run";

const ART = path.join(__dirname, "artifacts");

type Row = Artifact & { score: number }; // null re-inflated to Infinity on load

function load(): Row[] {
  return fs
    .readdirSync(ART)
    .filter((f) => f.endsWith(".json") && !f.startsWith("xval-"))
    .map((f) => {
      const raw = JSON.parse(fs.readFileSync(path.join(ART, f), "utf8"));
      return { ...raw, score: raw.score === null ? Infinity : raw.score } as Row;
    });
}

const pct = (n: number, d: number): string => (d === 0 ? "—" : `${((100 * n) / d).toFixed(0)}%`);
const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

function main(): void {
  const rows = load();
  if (rows.length === 0) {
    console.log("no artifacts — run spike/run.ts first");
    process.exit(1);
  }

  const cells = [...new Set(rows.map((r) => r.cell))].sort();
  console.log("cell | solver | n | feasible | mean score (both-feasible) | p50 wall | p95 wall");
  console.log("-".repeat(100));

  for (const cell of cells) {
    const inCell = rows.filter((r) => r.cell === cell);
    const seedsBothFeasible = new Set(
      [...new Set(inCell.map((r) => r.seed))].filter((s) =>
        (["alns", "cpsat"] as const).every((sv) => inCell.find((r) => r.seed === s && r.solver === sv)?.feasible)
      )
    );
    for (const solver of ["alns", "cpsat"] as const) {
      const rs = inCell.filter((r) => r.solver === solver);
      if (rs.length === 0) continue;
      const feas = rs.filter((r) => r.feasible);
      const both = rs.filter((r) => seedsBothFeasible.has(r.seed));
      const walls = rs.filter((r) => r.wallMs >= 0).map((r) => r.wallMs / 1000);
      console.log(
        `${cell} | ${solver} | ${rs.length} | ${pct(feas.length, rs.length)} | ` +
          `${both.length ? mean(both.map((r) => r.score)).toFixed(1) : "—"} | ` +
          `${quantile(walls, 0.5).toFixed(1)}s | ${quantile(walls, 0.95).toFixed(1)}s`
      );
    }
  }

  // ------------------------------------------------------------- the verdict
  const v = rows.filter((r) => r.cell.startsWith("VERDICT"));
  const va = v.filter((r) => r.solver === "alns");
  const vc = v.filter((r) => r.solver === "cpsat");
  if (va.length === 0 || vc.length === 0) {
    console.log("\nVERDICT: incomplete — verdict cell not fully measured yet.");
    return;
  }
  const feasA = va.filter((r) => r.feasible).length / va.length;
  const feasC = vc.filter((r) => r.feasible).length / vc.length;
  const bothSeeds = [...new Set(v.map((r) => r.seed))].filter(
    (s) => va.find((r) => r.seed === s)?.feasible && vc.find((r) => r.seed === s)?.feasible
  );
  const meanA = bothSeeds.length ? mean(bothSeeds.map((s) => va.find((r) => r.seed === s)!.score)) : NaN;
  const meanC = bothSeeds.length ? mean(bothSeeds.map((s) => vc.find((r) => r.seed === s)!.score)) : NaN;
  const p95C = quantile(vc.filter((r) => r.wallMs >= 0).map((r) => r.wallMs / 1000), 0.95);

  const condFeas = feasC - feasA >= 0.10;
  const condScore = bothSeeds.length > 0 && meanC <= meanA * 0.85;
  const condLatency = p95C <= 32; // 30s budget + 2s round-trip allowance

  console.log(`\nVERDICT CELL: feasibility alns=${(100 * feasA).toFixed(0)}% cpsat=${(100 * feasC).toFixed(0)}% (need +10pp: ${condFeas})`);
  console.log(`  mean score (n=${bothSeeds.length} both-feasible): alns=${meanA.toFixed(1)} cpsat=${meanC.toFixed(1)} (need cpsat <= 85% of alns: ${condScore})`);
  console.log(`  cpsat p95 wall=${p95C.toFixed(1)}s (need <=32s: ${condLatency})`);
  console.log(
    `\nVERDICT: ${(condFeas || condScore) && condLatency ? "CP-SAT ships (worker on VPS) — decision rule satisfied" : "TS ALNS ships — decision rule not met (tie/mixed/latency -> TS by pre-registration)"}`
  );
}

main();
