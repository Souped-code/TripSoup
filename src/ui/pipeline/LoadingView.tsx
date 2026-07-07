"use client";

// The loading surface (design.md §8): while the pipeline runs, Gracie cycles
// through her scenes IN STEP with real backend stages, and progress reads as a
// soup pot filling — never a generic percentage bar or spinner. On failure she
// freezes in her "this is fine" pose beside a legible error and a retry button.
import { useEffect, useState } from "react";
import type { PipelineStage } from "@/lib/pipeline/pipeline";
import type { GracieSceneName } from "@/ui/journal/GracieScene";
import { GracieScene } from "@/ui/journal/GracieScene";
import { InkButton } from "@/ui/journal/InkButton";
import type { PipelineState } from "./usePipeline";
import "./pipeline.css";

// Which Gracie scene plays during each pipeline stage (plan D2.2).
const SCENE_FOR_STAGE: Record<PipelineStage, GracieSceneName> = {
  parse: "route-scribble", // scribbling routes while she reads your links
  resolve: "pin-throw", // pinning places on the map
  matrix: "this-is-fine", // waiting on the drive-time lookups
  solve: "soup-stir", // cooking the best order
};

export function LoadingView({
  state,
  onRetry,
}: {
  state: PipelineState;
  onRetry: () => void;
}) {
  // Live cook timer (testing aid) — counts up from the moment the paste was
  // submitted (usePipeline stamped ts-cook-t0), refreshing 10×/sec.
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (state.phase !== "running") return;
    let t0 = Date.now();
    try {
      const s = Number(sessionStorage.getItem("ts-cook-t0"));
      if (s) t0 = s;
    } catch { /* storage off */ }
    setElapsed((Date.now() - t0) / 1000);
    const id = setInterval(() => setElapsed((Date.now() - t0) / 1000), 100);
    return () => clearInterval(id);
  }, [state.phase]);

  if (state.phase === "error") {
    return (
      <div className="pipeline-stage" data-testid="pipeline-error">
        <GracieScene name="this-is-fine" size={240} paused data-testid="pipeline-gracie-error" />
        <p className="pipeline-detail pipeline-detail--error" data-testid="pipeline-error-message">
          {state.message}
        </p>
        <InkButton variant="primary" onClick={onRetry} data-testid="pipeline-retry">
          Try again
        </InkButton>
      </div>
    );
  }

  // idle shows the same frame as the first running stage so there's no flash.
  const stage: PipelineStage = state.phase === "running" ? state.stage : "parse";
  const pct = state.phase === "running" ? state.pct : 0;
  const detail = state.phase === "running" ? state.detail : "Warming up the kitchen…";

  return (
    <div className="pipeline-stage" data-testid="pipeline-loading">
      <GracieScene name={SCENE_FOR_STAGE[stage]} size={240} data-testid="pipeline-gracie" />

      {/* Soup pot filling with --soup soup to `pct`% — the progress metaphor. */}
      <div
        className="pipeline-pot"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Cooking your plan"
        data-testid="pipeline-progress"
      >
        <div className="pipeline-pot-soup" style={{ height: `${pct}%` }} />
      </div>

      <p className="pipeline-detail" data-testid="pipeline-detail">
        {detail}
      </p>

      {elapsed != null && (
        <p className="pipeline-timer" data-testid="pipeline-timer">
          cooking · {elapsed.toFixed(1)}s
        </p>
      )}
    </div>
  );
}
