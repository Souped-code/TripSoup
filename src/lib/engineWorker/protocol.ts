// E6a — the message shapes crossing the worker boundary. Shared (type-only
// where it matters) between host.ts (main thread) and workerEntry.ts (the
// worker), so the two sides can never drift silently out of sync.
//
// EngineProblem/EngineSolution themselves need no adaptation here: both are
// plain data (records, arrays, typed arrays — see src/lib/engine/types.ts's
// header, "WHY THE PROBLEM IS A SEPARATE TYPE") and survive structuredClone
// (the algorithm Node's `Worker` uses for `workerData` and postMessage)
// unchanged. The ONE thing that does NOT survive is `SolveOptions.onProgress`
// (a function) and `.signal` (a live view of host-side mutable state) —
// `WorkerSolveOptions` is `SolveOptions` with exactly those two stripped.

import type { EngineSolution, SolveOptions } from "../engine";

/** `SolveOptions` minus the two fields that cannot cross a worker boundary.
 * `onProgress` is reconstructed by host.ts from `{type:"progress"}` messages;
 * `signal` has no worker-mode equivalent — a real `worker.terminate()` (see
 * host.ts's hard timeout) replaces the cooperative abort check entirely, and
 * is strictly stronger (an actual kill vs. a flag the search loop only polls
 * every 128 iterations). */
export type WorkerSolveOptions = Omit<SolveOptions, "onProgress" | "signal">;

/** worker -> host, via `parentPort.postMessage` / the `Worker` instance's
 * `"message"` event. Exactly one of `"done"` / `"error"` is ever sent, and it
 * is always the LAST message (zero or more `"progress"` messages precede
 * it). */
export type WorkerMessage =
  | { type: "progress"; pct: number; bestScore: number; phase: string }
  | { type: "done"; solution: EngineSolution }
  | { type: "error"; message: string };

/** host -> worker, via the `workerData` option at construction. */
export type WorkerInitData = {
  problem: import("../engine").EngineProblem;
  opts: WorkerSolveOptions;
};
