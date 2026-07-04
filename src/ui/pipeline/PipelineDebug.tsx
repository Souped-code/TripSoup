"use client";

// Debug-only driver for the pipeline loading flow (gated by the server page).
// Lets Playwright paste a synthetic blob, run the real /api/pipeline stream,
// and observe genuine progress → reveal handoff. Not part of the product UI;
// the real greeting page + reveal are D2.3.
import { useState } from "react";
import { JournalInput } from "@/ui/journal/JournalInput";
import { InkButton } from "@/ui/journal/InkButton";
import { LoadingView } from "./LoadingView";
import { usePipeline } from "./usePipeline";

export function PipelineDebug() {
  const [text, setText] = useState("");
  const { state, run } = usePipeline();

  return (
    <main style={{ padding: 24, background: "var(--paper)", minHeight: "100vh" }}>
      <h1 style={{ fontFamily: "var(--font-display)", color: "var(--ink)" }}>Pipeline debug</h1>

      {state.phase === "idle" && (
        <div style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 12 }}>
          <JournalInput
            as="textarea"
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste your trip — links, notes, chaos welcome"
            data-testid="pipeline-paste"
          />
          <div>
            <InkButton
              variant="primary"
              onClick={() => run(text)}
              data-testid="pipeline-run"
            >
              Cook my trip
            </InkButton>
          </div>
        </div>
      )}

      {(state.phase === "running" || state.phase === "error") && (
        <LoadingView state={state} onRetry={() => run(text)} />
      )}

      {state.phase === "done" && (
        <div data-testid="pipeline-done">
          <p style={{ fontFamily: "var(--font-body)", color: "var(--ink)" }}>
            Your route&apos;s ready.
          </p>
          <pre
            data-testid="pipeline-result-trip-id"
            style={{ fontFamily: "monospace", color: "var(--ink-soft)" }}
          >
            {state.result.tripId}
          </pre>
          <pre
            data-testid="pipeline-result-days"
            style={{ fontFamily: "monospace", color: "var(--ink-soft)" }}
          >
            {String(state.result.doc.days.length)} day(s), {String(state.result.failures.length)}{" "}
            unresolved
          </pre>
        </div>
      )}
    </main>
  );
}
