// E6a — a tiny push -> pull bridge: turns a callback (`push`, called from
// wherever async work happens to be, at whatever real times it happens to
// fire) into an `AsyncGenerator` a `for await…of` loop can drain LIVE, item
// by item, as they're pushed — not a batch collected then replayed after the
// producer finishes.
//
// Used by pipeline.ts's solve stage: `runSolve`'s `onProgress` callback
// (src/lib/engineWorker/host.ts) pushes into the channel from worker
// `"message"` events arriving over real wall-clock time; the pipeline
// generator drains it concurrently with awaiting the solve's own result, so
// each tick reaches the SSE route the moment it actually happens.
//
// Deliberately minimal — no backpressure, no buffering limit (a solve emits
// at most a few dozen ticks total; see search.ts's PROGRESS_MS throttle), no
// external dependency. Generic so a later stage (or a different route
// entirely) can reuse it without copying this file.

export type ProgressChannel<T> = {
  /** Enqueues one item. Safe to call from anywhere, any number of times,
   * including from inside a synchronous callback (e.g. the in-process
   * fallback's `onProgress`, invoked from a tight CPU-bound loop) or from an
   * event-loop callback fired well after `drain()` was already started
   * (e.g. a worker's `"message"` event). */
  push: (item: T) => void;
  /** Marks the channel done. `drain()` yields every item pushed so far
   * (including ones queued before `drain()` was even called) and then
   * returns — or, if `err` is given, THROWS it after yielding everything
   * that arrived first. Idempotent (a second call is a no-op): callers use
   * `.finally(() => close())` alongside a separate `.then`/`.catch` that
   * records the outcome, so both settle paths reach here exactly once in
   * spirit even though `finally` itself only runs once regardless. */
  close: (err?: unknown) => void;
  /** The consuming side. Exactly one concurrent `drain()` is supported (this
   * is a single-consumer channel, matching pipeline.ts's one generator). */
  drain: () => AsyncGenerator<T, void, void>;
};

export function progressChannel<T>(): ProgressChannel<T> {
  const queue: T[] = [];
  let waiter: (() => void) | null = null;
  let closed = false;
  let closeError: unknown;

  function wake(): void {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve();
    }
  }

  function push(item: T): void {
    if (closed) return; // draining already finished; a late push is dropped, not queued forever
    queue.push(item);
    wake();
  }

  function close(err?: unknown): void {
    if (closed) return;
    closed = true;
    closeError = err;
    wake();
  }

  async function* drain(): AsyncGenerator<T, void, void> {
    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (closed) {
        if (closeError !== undefined) throw closeError;
        return;
      }
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
    }
  }

  return { push, close, drain };
}
