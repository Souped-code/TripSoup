// E6a — runs the SAME `alnsEngine.solve` planEngine.ts's in-process path
// calls, but on a `worker_thread`, so its `onProgress` ticks reach the
// caller LIVE (relayed as they're posted) instead of being captured-then-
// replayed after a synchronous call returns. See planEngine.ts's
// SolveWithPreparedOptions doc comment ("they cannot arrive live mid-call…")
// — this file is the fix that comment promised, and pipeline.ts's solve
// stage (restructured alongside this) is what actually streams them.
//
// ONE WORKER PER SOLVE. No pool: a serverless function invocation is
// short-lived, so a pool would either leak (nothing reclaims an idle worker
// between invocations — Vercel can freeze/recycle the whole process any
// time) or need lifecycle management this file has no mandate to build.
// Every worker constructed here is terminated exactly once, on every exit
// path (success, error, hard-timeout).
//
// Server-only by the same convention as planEngine.ts/config.ts (Node
// built-ins throughout — never imported by client code).

import { Worker } from "node:worker_threads";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { alnsEngine } from "../engine";
import type { EngineProblem, EngineSolution, SolveOptions } from "../engine";
import type { WorkerInitData, WorkerMessage, WorkerSolveOptions } from "./protocol";

const BUNDLE_REL_PATH = "src/lib/engineWorker/worker.generated.cjs";
const BUILD_SCRIPT_REL_PATH = "src/lib/engineWorker/build.mjs";

/**
 * Where the worker script lives. See build.mjs's header for the full "what
 * actually works under next build" writeup — short version: the bundle is a
 * plain, dependency-free CommonJS file on disk, and its path is handed to
 * `new Worker()` as a bare string computed at RUNTIME (never wrapped in a
 * `require()`/`import()` call), so bundlers (webpack, under Next.js) have
 * nothing to statically analyse or rewrite — `new Worker(pathString)` is
 * just an ordinary function call as far as webpack is concerned, exactly
 * like passing a path to `fs.readFile`.
 *
 * `process.cwd()` (not `__dirname`/`import.meta.url`) is the anchor
 * deliberately: it survives Next's webpack module-id rewriting for bundled
 * server code, and matches the project root in every environment this must
 * run in (Next dev server, `next start`, a Vercel Node.js Function, and a
 * plain `tsx` process) — all four run with cwd = the project root.
 * `next.config.mjs`'s `outputFileTracingIncludes` is what makes Vercel
 * actually ship this file into the deployed function's filesystem (a
 * `new Worker(str)` call is invisible to Next's automatic file-tracing,
 * which only follows `require`/`import` graphs).
 */
function bundlePath(): string {
  const p = path.join(process.cwd(), BUNDLE_REL_PATH);
  if (!fs.existsSync(p)) {
    // Dev/test convenience ONLY: build on demand so a fresh checkout's first
    // `next dev` (or the tsx real-process proof script) doesn't need a
    // separate manual step. A real deploy's `npm run build` already ran
    // build.mjs via the `prebuild` npm hook (package.json) before this code
    // path could ever be reached — and Vercel's function filesystem is
    // READ-ONLY at runtime, so if it somehow WERE reached in prod, this
    // throws a legible error instead of silently doing nothing (exactly the
    // failure mode the design calls for: legible, not silent).
    execFileSync(process.execPath, [path.join(process.cwd(), BUILD_SCRIPT_REL_PATH)], {
      stdio: "inherit",
    });
  }
  return p;
}

/**
 * Spawns ONE worker running `alnsEngine.solve(problem, opts)`, relays its
 * progress LIVE via `opts.onProgress`, resolves with the solution.
 *
 * Hard-bounded at `(opts.hardStopMs ?? opts.timeBudgetMs * 3) + 5s` grace —
 * belt-and-braces ON TOP of the engine's own internal `hardStopMs` net (see
 * search.ts): that net is cooperative (checked every 128 iterations, inside
 * the worker's own single-threaded loop), this one is not — `worker.
 * terminate()` is a real OS-level kill, the backstop for a hang the
 * cooperative check can never reach (e.g. stuck in construction before the
 * iteration loop even starts). On firing, REJECTS with a legible error —
 * callers that already try/catch a solve (planEngine.ts's day-scoped path,
 * via planStore.ts's solveIncremental) degrade to a rejected day exactly as
 * they do for any other solve failure; nothing new to wire there.
 */
export function solveInWorker(problem: EngineProblem, opts: SolveOptions): Promise<EngineSolution> {
  const { onProgress, signal: _signal, ...rest } = opts;
  const workerOpts: WorkerSolveOptions = rest;
  const rawNetMs = (opts.hardStopMs ?? opts.timeBudgetMs * 3) + 5_000;
  // Every REAL caller (planEngine.ts's two call sites) always passes a finite
  // `timeBudgetMs` (engineBudgetMs() never returns Infinity), so `rawNetMs`
  // is finite in production. It can still be non-finite from a direct caller
  // that deliberately passes `timeBudgetMs: Infinity` with no `hardStopMs`
  // (the engine's own SolveOptions doc comment explicitly allows this — "no
  // wall-clock cut"; this bit an early version of this file's own real-
  // process proof script). `setTimeout(fn, Infinity)` does NOT mean "never
  // fire" — Node clamps a non-finite/overflowing delay to ~1ms, firing
  // almost immediately, which is the opposite of what an infinite budget
  // asks for. When that happens, skip the outer timer entirely and rely on
  // the engine's OWN hardStopMs (still passed to the worker verbatim) as the
  // only net — never on a caller-observable finite number this file made up.
  const netMs = Number.isFinite(rawNetMs) ? rawNetMs : null;

  return new Promise((resolve, reject) => {
    let settled = false;
    const initData: WorkerInitData = { problem, opts: workerOpts };
    const worker = new Worker(bundlePath(), { workerData: initData });

    const timer =
      netMs === null
        ? null
        : setTimeout(() => {
            finish(() =>
              reject(
                new Error(
                  `Engine worker exceeded its hard stop (${netMs}ms, including a 5s grace over the ` +
                    `engine's own net) and was terminated.`
                )
              )
            );
          }, netMs);

    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
      // Fire-and-forget: nothing here needs to await OS-level thread
      // teardown. "No pooling" (see header) means every worker — success,
      // error, or timeout — is terminated exactly once, right here.
      void worker.terminate();
    }

    worker.on("message", (msg: WorkerMessage) => {
      if (msg.type === "progress") {
        onProgress?.({ pct: msg.pct, bestScore: msg.bestScore, phase: msg.phase });
        return;
      }
      if (msg.type === "done") {
        finish(() => resolve(msg.solution));
        return;
      }
      // msg.type === "error" — the worker caught its own throw and reported
      // it legibly (workerEntry.ts's try/catch) rather than crashing silently.
      finish(() => reject(new Error(msg.message)));
    });

    // A crash the worker's own try/catch didn't reach (e.g. it never
    // finished loading — a genuinely broken bundle) — Node's own error path.
    worker.on("error", (err) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    });

    // A non-zero exit with no prior "done"/"error" message means the thread
    // died some OTHER way (e.g. an uncaught rejection outside workerEntry's
    // own guard, or the process being killed out from under it). `settled`
    // guards this from double-rejecting after a normal "done"/"error" exit
    // (code 0 is the ordinary case there).
    worker.on("exit", (code) => {
      if (code !== 0) {
        finish(() =>
          reject(new Error(`Engine worker exited with code ${code} before returning a solution.`))
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// runSolve — the choice planEngine.ts's two `alnsEngine.solve` call sites
// (solveWithPreparedMatrices, solveDayWithEngine) now go through.
// ---------------------------------------------------------------------------

function engineInWorkerEnabled(): boolean {
  // worker_threads + ts-jest do not mix: ts-jest's module registry/transform
  // cache is not worker-safe, and jest already runs its OWN worker pool per
  // test file — nesting a real OS thread inside that is a documented source
  // of hangs and flaky teardown. The synchronous in-process path stays the
  // source of truth for every unit test; this mirrors planEngine.ts's
  // `engineBudgetMs()` JEST_WORKER_ID gate (jest sets this on every worker
  // automatically, so no test file needs to opt in/out itself).
  if (process.env.JEST_WORKER_ID !== undefined) return false;
  const raw = process.env.ENGINE_IN_WORKER;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  // No explicit override: default ON in production (`next build` + `next
  // start`/Vercel — NODE_ENV=production is set by Next's own CLI either
  // way), default OFF under the `next dev` server specifically.
  //
  // This is a MEASURED finding, not a guess (design point 5 — "if worker
  // mode under the Next dev server proves unstable, fall back default OFF
  // with a documented reason"): worker mode ON under `next dev`, run through
  // e2e/trip.spec.ts's full sequential suite (playwright.config.ts,
  // workers:1) with a clean `.trips-e2e` each time, failed 2 of 2 completed
  // full-suite runs (different individual tests each time — "walkMax" and/or
  // "infeasible case", never the same failure twice) while the SAME test run
  // in ISOLATION (just that one test) passed 3/3, and the SAME full sequence
  // with worker mode OFF passed 2/2. That shape — flakes only across a
  // SEQUENCE of requests, never alone — points at `next dev`'s own per-
  // request on-demand compilation/HMR overhead compounding with a genuine
  // worker thread's independently-scheduled timing, not a defect in this
  // file's own message handling (which the mocked-Worker unit tests in
  // __tests__/host.test.ts exercise directly and which passed every time).
  // Verified STABLE instead: solveInWorker in isolation via a plain `tsx`
  // process (no Next involved at all), and a real HTTP request against the
  // ACTUAL `next build` + `next start` production server (worker spawned,
  // solved, and returned a correct plan — see STATE.md's E6a entry for the
  // full transcript). Production is exactly where this matters — a
  // serverless function invocation is one request, never a sequence sharing
  // a warm dev-compile pipeline — so defaulting OFF only for `next dev`
  // trades nothing prod cares about for e2e's stability.
  return process.env.NODE_ENV === "production";
}

/**
 * planEngine.ts's ONLY way to reach `alnsEngine.solve` (E6a). Chooses the
 * worker path or the synchronous in-process path per `engineInWorkerEnabled`
 * above; either way it is the literal SAME `alnsEngine.solve` running (one
 * relayed via postMessage, one called directly) — quality/determinism cannot
 * diverge between the two modes, only WHEN progress ticks arrive can.
 */
export async function runSolve(problem: EngineProblem, opts: SolveOptions): Promise<EngineSolution> {
  if (engineInWorkerEnabled()) return solveInWorker(problem, opts);
  return alnsEngine.solve(problem, opts);
}
