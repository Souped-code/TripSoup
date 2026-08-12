// E6a — runs INSIDE the spawned worker_thread. Never imported by anything
// that runs on the main thread (host.ts constructs a `Worker` pointed at this
// file's COMPILED form, `worker.generated.cjs` — see build.mjs's header for
// why a compiled file and not this .ts source directly).
//
// Deliberately the thinnest possible shim around the EXACT SAME
// `alnsEngine.solve` that planEngine.ts calls in-process: worker mode and
// in-process mode must run identical solve logic, or they could silently
// diverge in quality/determinism (a fork of the algorithm would defeat the
// entire "the engine is the engine" contract src/lib/engine/index.ts's port
// exists to guarantee). The only NEW logic here is message plumbing.
//
// Message protocol — see protocol.ts for the shared types.

import { parentPort, workerData } from "node:worker_threads";
import { alnsEngine } from "../engine";
import type { WorkerInitData, WorkerMessage } from "./protocol";

function send(msg: WorkerMessage): void {
  parentPort!.postMessage(msg);
}

if (!parentPort) {
  // Guards against this file ever being `require()`d/imported directly on a
  // main thread by mistake — worker_threads sets `parentPort` to null there.
  throw new Error("engineWorker/workerEntry must run inside a worker_thread");
}

const { problem, opts } = workerData as WorkerInitData;

(async () => {
  try {
    // alnsEngine.solve's port type is `EngineSolution | Promise<EngineSolution>`
    // (see src/lib/engine/types.ts's SolverEngine doc comment — today's
    // implementation is synchronous/CPU-bound, but the port allows either);
    // `await` handles both without assuming which.
    const solution = await alnsEngine.solve(problem, {
      ...opts,
      onProgress: (p) => send({ type: "progress", ...p }),
    });
    send({ type: "done", solution });
  } catch (e) {
    send({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
})();
