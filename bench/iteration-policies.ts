// Which ALNS iteration policy matches the old 20 s-budget cap at a fraction of
// the time? Randomized fixture-city corpus (no keys). Usage: npx tsx bench/iteration-policies.ts
// Result 2026-10-23 is recorded in docs/IMPROVEMENT-PLAN-2026-10.md (L3).
import { solveWithAlns, WEIGHT_TRAVEL, WEIGHT_WAIT, type EngineProblem } from "../src/lib/engine";
import { iterCapFor } from "../src/lib/planEngine";
import { ALL_FIXTURE_IDS, docOf, everyDay, problemFor, tripStop, tripStopWithHours, withHours } from "../src/lib/engine/__fixtures__/tripFixtures";
import { createRng } from "../src/lib/util/rng";
import type { TripDay, TripStop } from "../src/lib/store/types";

const scoreOf = (b: any) => b.travelMin * WEIGHT_TRAVEL + b.waitMin * WEIGHT_WAIT + b.dropPenalty + b.compressionPenalty + b.softViolations;

function randomDay(rng: ReturnType<typeof createRng>, n: number, date: string, used: Set<string>): TripDay {
  const pool = ALL_FIXTURE_IDS.filter((id) => !used.has(id));
  const ids = [...pool].sort(() => rng.next() - 0.5).slice(0, n);
  ids.forEach((id) => used.add(id));
  const anchors = Math.floor(rng.next() * 3); // 0-2
  const tight = rng.next() < 0.3;
  const stops: TripStop[] = ids.map((id, k) => {
    const dur = 20 + Math.floor(rng.next() * 8) * 15;
    if (k < anchors) return tripStop(id, dur, 600 + k * 240 + Math.floor(rng.next() * 4) * 30);
    const r = rng.next();
    if (r < 0.5) return tripStopWithHours(id, dur);
    if (r < 0.65) return withHours(tripStop(id, dur), everyDay(540 + Math.floor(rng.next() * 4) * 60, 900 + Math.floor(rng.next() * 6) * 60));
    return tripStop(id, dur);
  });
  const day: TripDay = { date, dayStartMin: 540, dayEndMin: tight ? 1020 : 1260, stops };
  if (n >= 4 && rng.next() < 0.3) day.precedence = [{ beforeId: stops[n - 1].id, afterId: stops[n - 2].id }];
  return day;
}

(async () => {
  const corpus: Array<[string, EngineProblem]> = [];
  for (let i = 0; i < 40; i++) {
    const rng = createRng(1000 + i);
    const n = 4 + (i % 11); // 4..14
    corpus.push([`day${i} n=${n}`, await problemFor(docOf([randomDay(rng, n, "2026-07-07", new Set())], `r${i}`))]);
  }
  for (let i = 0; i < 6; i++) {
    const rng = createRng(5000 + i);
    const D = 3 + (i % 2); const used = new Set<string>(); const days: TripDay[] = [];
    for (let d = 0; d < D; d++) days.push(randomDay(rng, 3 + Math.floor(rng.next() * 3), `2026-07-${String(6 + d).padStart(2, "0")}`, used));
    corpus.push([`trip${i} ${D}d`, await problemFor(docOf(days, `t${i}`))]);
  }
  type Policy = { name: string; run: (p: EngineProblem, seed: number) => number };
  const solve = (p: EngineProblem, seed: number, iterCap: number) => scoreOf(solveWithAlns(p, { seed, timeBudgetMs: Infinity, iterCap }).objectiveBreakdown);
  const policies: Policy[] = [
    { name: "prod(20s formula)", run: (p, s) => solve(p, s, iterCapFor(p.nodes.length, 20_000)) },
    { name: "fixed 5k", run: (p, s) => solve(p, s, 5_000) },
    { name: "fixed 10k", run: (p, s) => solve(p, s, 10_000) },
    { name: "fixed 20k", run: (p, s) => solve(p, s, 20_000) },
    { name: "best-of-3 x 5k", run: (p, s) => Math.min(solve(p, s, 5_000), solve(p, s * 7919 + 1, 5_000), solve(p, s * 104729 + 2, 5_000)) },
  ];
  const SEEDS = [1, 2];
  const res: Record<string, { gaps: number[]; ms: number[] }> = Object.fromEntries(policies.map((p) => [p.name, { gaps: [], ms: [] }]));
  let i = 0;
  for (const [, p] of corpus) {
    i++;
    const scores: Record<string, number[]> = {};
    for (const pol of policies) {
      scores[pol.name] = [];
      for (const seed of SEEDS) { const t = Date.now(); scores[pol.name].push(pol.run(p, seed)); res[pol.name].ms.push(Date.now() - t); }
    }
    const best = Math.min(...Object.values(scores).flat());
    for (const pol of policies) for (const s of scores[pol.name]) res[pol.name].gaps.push(best === 0 ? (s === 0 ? 0 : 100) : ((s - best) / best) * 100);
    if (i % 10 === 0) console.error(`${i}/${corpus.length}`);
  }
  const q = (a: number[], f: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))];
  console.log(`corpus: ${corpus.length} problems x ${SEEDS.length} seeds`);
  console.log("policy             | mean gap% | p95 gap% | worst gap% | #runs >0.5% | median ms | p95 ms | max ms");
  for (const pol of policies) {
    const r = res[pol.name]; const mean = r.gaps.reduce((a, b) => a + b, 0) / r.gaps.length;
    console.log(`${pol.name.padEnd(18)} | ${mean.toFixed(3).padStart(9)} | ${q(r.gaps, 0.95).toFixed(2).padStart(8)} | ${Math.max(...r.gaps).toFixed(2).padStart(10)} | ${String(r.gaps.filter((g) => g > 0.5).length).padStart(11)} | ${String(q(r.ms, 0.5)).padStart(9)} | ${String(q(r.ms, 0.95)).padStart(6)} | ${Math.max(...r.ms)}`);
  }
})();
