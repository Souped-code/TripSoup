// E6a — host.ts's OWN logic (message handling, hard-timeout, exit/error
// paths, and the worker-vs-in-process gate), tested with `node:worker_threads`
// fully MOCKED. Deliberately never spawns a real OS thread: the brief's own
// design note is "worker_threads + ts-jest do not mix" (host.ts's own
// `engineInWorkerEnabled` comment), so a real end-to-end worker run is proven
// separately, outside jest, by the tsx real-process proof script (see
// STATE.md's E6a entry) — this file proves host.ts's OWN code is correct
// given whatever `Worker` does, not that a real `Worker` behaves as this file
// assumes.

import type { EventEmitter } from "node:events";
import { docOf, problemFor, tripStop } from "../../engine/__fixtures__/tripFixtures";
import { alnsEngine, type EngineProblem, type SolveOptions } from "../../engine";

/** Shape of the class `jest.mock`'s factory below actually constructs at
 * runtime — declared as a type only (the real class lives INSIDE the factory
 * so jest's mock-hoisting never has to reach an outer-scope reference). */
type MockWorker = EventEmitter & {
  scriptPath: string;
  options: { workerData: unknown };
  terminate: jest.Mock;
};
type MockWorkerCtor = { instances: MockWorker[] };

jest.mock("node:worker_threads", () => {
  const { EventEmitter: EE } = require("node:events");
  class InnerMockWorker extends EE {
    static instances: InnerMockWorker[] = [];
    terminate = jest.fn(() => Promise.resolve(0));
    constructor(
      public scriptPath: string,
      public options: unknown
    ) {
      super();
      InnerMockWorker.instances.push(this);
    }
  }
  return { Worker: InnerMockWorker };
});

// bundlePath() does an fs.existsSync check before ever touching Worker;
// keep it finding a real file (the one build.mjs already produced on disk —
// see package.json's predev/prebuild hooks) so no test here accidentally
// shells out to rebuild it via execFileSync.
jest.mock("node:fs", () => ({
  ...jest.requireActual("node:fs"),
  existsSync: () => true,
}));

import { Worker } from "node:worker_threads";
import { runSolve, solveInWorker } from "../host";

const Mock = Worker as unknown as MockWorkerCtor;

function lastWorker(): MockWorker {
  const w = Mock.instances[Mock.instances.length - 1];
  if (!w) throw new Error("no worker constructed");
  return w;
}

const baseOpts: SolveOptions = { seed: 1, timeBudgetMs: 1000, iterCap: 100 };
const problem = {} as EngineProblem; // never inspected by the mock — only threaded through workerData

beforeEach(() => {
  Mock.instances.length = 0;
});

describe("solveInWorker (E6a)", () => {
  it("relays progress messages live and resolves on 'done'", async () => {
    const progressed: Array<{ pct: number; phase: string }> = [];
    const promise = solveInWorker(problem, { ...baseOpts, onProgress: (p) => progressed.push(p) });

    const w = lastWorker();
    // Constructed with the two fields that CANNOT cross the boundary
    // stripped (onProgress/signal) — see protocol.ts's WorkerSolveOptions.
    expect(w.options.workerData).toEqual({ problem, opts: { seed: 1, timeBudgetMs: 1000, iterCap: 100 } });

    w.emit("message", { type: "progress", pct: 10, bestScore: 5, phase: "construct" });
    w.emit("message", { type: "progress", pct: 50, bestScore: 3, phase: "search" });
    expect(progressed).toEqual([
      { pct: 10, bestScore: 5, phase: "construct" },
      { pct: 50, bestScore: 3, phase: "search" },
    ]);

    const solution = { days: [], assignment: {}, objectiveBreakdown: {} } as any;
    w.emit("message", { type: "done", solution });

    await expect(promise).resolves.toBe(solution);
    expect(w.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects legibly on an 'error' message and still terminates", async () => {
    const promise = solveInWorker(problem, baseOpts);
    const w = lastWorker();
    w.emit("message", { type: "error", message: "the engine threw inside the worker" });
    await expect(promise).rejects.toThrow("the engine threw inside the worker");
    expect(w.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects on the worker's own 'error' event", async () => {
    const promise = solveInWorker(problem, baseOpts);
    const w = lastWorker();
    w.emit("error", new Error("worker crashed loading the bundle"));
    await expect(promise).rejects.toThrow("worker crashed loading the bundle");
    expect(w.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects on a non-zero exit with no prior done/error message", async () => {
    const promise = solveInWorker(problem, baseOpts);
    const w = lastWorker();
    w.emit("exit", 1);
    await expect(promise).rejects.toThrow(/exited with code 1/);
  });

  it("a zero exit AFTER 'done' does not double-settle", async () => {
    const promise = solveInWorker(problem, baseOpts);
    const w = lastWorker();
    const solution = { ok: true } as any;
    w.emit("message", { type: "done", solution });
    w.emit("exit", 0);
    await expect(promise).resolves.toBe(solution);
    expect(w.terminate).toHaveBeenCalledTimes(1); // not twice
  });

  it("a late exit(1) AFTER 'done' does not override the resolution (settled guard)", async () => {
    const promise = solveInWorker(problem, baseOpts);
    const w = lastWorker();
    const solution = { ok: true } as any;
    w.emit("message", { type: "done", solution });
    w.emit("exit", 1); // e.g. a teardown crash after already reporting success
    await expect(promise).resolves.toBe(solution);
  });

  it("terminates and rejects legibly when the hard stop fires (worker.terminate(), design (c))", async () => {
    jest.useFakeTimers();
    try {
      const promise = solveInWorker(problem, { ...baseOpts, hardStopMs: 1000 });
      const w = lastWorker();
      // hardStopMs (1000) + the host's own 5s grace = 6000ms net.
      jest.advanceTimersByTime(6000);
      await expect(promise).rejects.toThrow(/hard stop/i);
      expect(w.terminate).toHaveBeenCalledTimes(1);

      // A message arriving AFTER the terminate() must not resurrect the
      // already-settled promise (the `settled` guard applies here too).
      w.emit("message", { type: "done", solution: {} });
    } finally {
      jest.useRealTimers();
    }
  });

  it("derives the net timeout from timeBudgetMs*3 when hardStopMs is absent", async () => {
    jest.useFakeTimers();
    try {
      // timeBudgetMs 1000 -> 3000 + 5000 grace = 8000ms net.
      const promise = solveInWorker(problem, { seed: 1, timeBudgetMs: 1000 });
      jest.advanceTimersByTime(7999);
      // Not yet — give the event loop a tick to prove nothing has settled.
      let settled = false;
      promise.then(() => (settled = true)).catch(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);

      jest.advanceTimersByTime(1);
      await expect(promise).rejects.toThrow(/hard stop/i);
    } finally {
      jest.useRealTimers();
    }
  });

  it("skips the outer timer (never fires early) when timeBudgetMs is Infinity and hardStopMs is absent", async () => {
    // Regression: setTimeout(fn, Infinity) does NOT mean "never fire" — Node
    // clamps a non-finite delay to ~1ms, so an earlier version of this file
    // rejected an Infinity-budget solve almost immediately (caught by this
    // file's own real-process proof script — see STATE.md's E6a entry).
    jest.useFakeTimers();
    try {
      const promise = solveInWorker(problem, { seed: 1, timeBudgetMs: Infinity });
      const w = lastWorker();
      jest.advanceTimersByTime(24 * 60 * 60 * 1000); // a full day — still must not have fired
      let settled = false;
      promise.then(() => (settled = true)).catch(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);

      // The engine's own hardStopMs (unaffected — still just a number handed
      // to the worker) is the only net in this mode; simulate it resolving
      // normally.
      w.emit("message", { type: "done", solution: { ok: true } as any });
      await expect(promise).resolves.toEqual({ ok: true });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("runSolve (E6a) — worker vs in-process gate", () => {
  const realEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...realEnv };
  });

  it("never constructs a Worker when JEST_WORKER_ID is set (the ambient jest case)", async () => {
    expect(process.env.JEST_WORKER_ID).toBeDefined(); // jest sets this itself — no manipulation needed
    const doc = docOf([
      {
        date: "2026-09-01",
        dayStartMin: 540,
        dayEndMin: 1200,
        stops: [tripStop("fx-01", 30), tripStop("fx-02", 20)],
      },
    ]);
    const problem2 = await problemFor(doc);
    const solution = await runSolve(problem2, { seed: 7, timeBudgetMs: 500, iterCap: 500 });
    expect(Mock.instances.length).toBe(0); // no worker spawned — the in-process path ran
    // And it's the SAME answer alnsEngine.solve gives directly (same
    // (problem, seed, iterCap) — see host.ts's runSolve doc comment: worker
    // and in-process modes call the literal same function).
    const direct = await alnsEngine.solve(problem2, { seed: 7, timeBudgetMs: 500, iterCap: 500 });
    expect(solution.days).toEqual(direct.days);
  });

  it("constructs a Worker when JEST_WORKER_ID is absent and ENGINE_IN_WORKER=1 is explicit", async () => {
    delete process.env.JEST_WORKER_ID;
    process.env.ENGINE_IN_WORKER = "1"; // explicit override wins regardless of NODE_ENV
    const p = runSolve(problem, baseOpts);
    // Give the gate's synchronous check a turn before asserting.
    await Promise.resolve();
    expect(Mock.instances.length).toBe(1);
    lastWorker().emit("message", { type: "done", solution: { days: [] } as any });
    await p;
  });

  it("defaults to the worker path when NODE_ENV=production and neither JEST_WORKER_ID nor ENGINE_IN_WORKER is set", async () => {
    delete process.env.JEST_WORKER_ID;
    delete process.env.ENGINE_IN_WORKER;
    Object.assign(process.env, { NODE_ENV: "production" });
    const p = runSolve(problem, baseOpts);
    await Promise.resolve();
    expect(Mock.instances.length).toBe(1);
    lastWorker().emit("message", { type: "done", solution: { days: [] } as any });
    await p;
  });

  it("defaults to the in-process path when NODE_ENV=development (next dev) — the measured e2e-stability call", async () => {
    delete process.env.JEST_WORKER_ID;
    delete process.env.ENGINE_IN_WORKER;
    Object.assign(process.env, { NODE_ENV: "development" });
    const doc = docOf([
      {
        date: "2026-09-01",
        dayStartMin: 540,
        dayEndMin: 1200,
        stops: [tripStop("fx-01", 30)],
      },
    ]);
    const problem2 = await problemFor(doc);
    await runSolve(problem2, { seed: 1, timeBudgetMs: 200, iterCap: 200 });
    expect(Mock.instances.length).toBe(0);
  });

  it("stays on the in-process path when ENGINE_IN_WORKER=0, even without JEST_WORKER_ID and with NODE_ENV=production", async () => {
    delete process.env.JEST_WORKER_ID;
    Object.assign(process.env, { NODE_ENV: "production" }); // would otherwise default ON — the explicit "0" must still win
    delete process.env.JEST_WORKER_ID;
    process.env.ENGINE_IN_WORKER = "0";
    const doc = docOf([
      {
        date: "2026-09-01",
        dayStartMin: 540,
        dayEndMin: 1200,
        stops: [tripStop("fx-01", 30)],
      },
    ]);
    const problem2 = await problemFor(doc);
    await runSolve(problem2, { seed: 1, timeBudgetMs: 200, iterCap: 200 });
    expect(Mock.instances.length).toBe(0);
  });
});
