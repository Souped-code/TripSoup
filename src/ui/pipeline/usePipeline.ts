"use client";

// Client hook that runs the paste→plan pipeline and exposes its REAL streamed
// progress (D2.2). EventSource can't POST a body, so we read the SSE stream off
// a fetch response by hand — parsing `data:`/`event:` frames delimited by blank
// lines. Types are imported with `import type`, so none of pipeline.ts's
// server-only imports (config, planService, crypto) reach the client bundle.
import { useCallback, useRef, useState } from "react";
import type {
  PipelineProgress,
  PipelineResult,
  PipelineStage,
} from "@/lib/pipeline/pipeline";

type OkResult = Extract<PipelineResult, { status: "ok" }>;

export type PipelineState =
  | { phase: "idle" }
  | { phase: "running"; stage: PipelineStage; pct: number; detail: string }
  | { phase: "done"; result: OkResult }
  | { phase: "error"; stage: PipelineStage; message: string };

// Parse one SSE frame ("event: x\ndata: y") into {event, data}. Returns null
// for keep-alive/comment frames we don't care about.
function parseFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

export function usePipeline(): {
  state: PipelineState;
  run: (text: string) => Promise<void>;
} {
  const [state, setState] = useState<PipelineState>({ phase: "idle" });
  // Guard against overlapping runs (double-click / retry mid-flight).
  const runningRef = useRef(false);

  const run = useCallback(async (text: string) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setState({ phase: "running", stage: "parse", pct: 0, detail: "Reading your links…" });

    try {
      const res = await fetch("/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!res.ok || !res.body) {
        // Non-stream error (rate limit, bad body, no stream). Read a JSON
        // message if there is one; otherwise a generic legible line.
        let message = "Something went wrong starting your plan.";
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) message = j.error;
        } catch {
          /* body wasn't JSON */
        }
        setState({ phase: "error", stage: "parse", message });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let terminal = false;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const parsed = parseFrame(frame);
          if (!parsed) continue;

          if (parsed.event === "done") {
            terminal = true;
            const result = JSON.parse(parsed.data) as PipelineResult;
            if (result.status === "ok") {
              setState({ phase: "done", result });
            } else {
              setState({ phase: "error", stage: result.stage, message: result.message });
            }
          } else {
            const p = JSON.parse(parsed.data) as PipelineProgress;
            setState({ phase: "running", stage: p.stage, pct: p.pct, detail: p.detail });
          }
        }
      }

      // Stream ended without a terminal frame — the connection died mid-flight
      // (the maxDuration ceiling, a proxy drop). The pipeline is idempotent, so
      // present a retryable error rather than hanging on a stale progress bar.
      if (!terminal) {
        setState({
          phase: "error",
          stage: "solve",
          message: "The connection dropped before your plan finished — give it another go.",
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ phase: "error", stage: "parse", message });
    } finally {
      runningRef.current = false;
    }
  }, []);

  return { state, run };
}
