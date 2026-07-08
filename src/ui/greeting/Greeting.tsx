"use client";

// D2.3 (T3): the greeting `/` — the product's front door (design.md §8
// Greeting; §1 "the landing IS the product", §2.5 "no marketing formula").
// Paste box -> the already-built D2.2 pipeline (usePipeline + LoadingView,
// consumed as-is, not reinvented) -> on the terminal ok frame, hands off to
// the interim reveal at /trip/[id].
//
// Phase B.2 (2026-07-08): the idle landing is a POST-IT paste field sitting
// inside the notebook on a full-bleed desk background (Higgsfield bg-2). Chris
// placed the post-it within a red-outlined space on the open journal spread —
// centred on the notebook, so a viewport-centred note lands in it. Everything
// (greeting, label, tip, CTA) lives on the note; the desk is pure background.
// The running/handoff frames keep the plain --paper surface. Flow, testids,
// and validation are unchanged.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { GracieScene } from "@/ui/journal/GracieScene";
import { JournalInput } from "@/ui/journal/JournalInput";
import { InkButton } from "@/ui/journal/InkButton";
import { LoadingView } from "@/ui/pipeline/LoadingView";
import { usePipeline } from "@/ui/pipeline/usePipeline";
import "./greeting.css";

// No backend cap exists yet on paste length (app/api/pipeline/route.ts only
// rejects empty text) — this is a friendly UI-level guard against pasting
// something absurd (a whole scraped webpage), not a hard technical limit.
const MAX_PASTE_CHARS = 20_000;

function timeOfDayGreeting(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning.";
  if (hour >= 12 && hour < 18) return "Good afternoon.";
  return "Good evening.";
}

// Journal-voice validation (design.md §1: warm, plain, never corporate). Runs
// before usePipeline is ever called — the pipeline's own error path (inside
// LoadingView) is for real backend/stage failures, not paste-box pre-checks.
function validatePaste(raw: string): string | null {
  if (raw.trim() === "") {
    return "Paste something first. A couple of links, a note, anything you’ve got.";
  }
  if (raw.length > MAX_PASTE_CHARS) {
    return "That’s a lot to paste in one go. Trim it down a bit and try again.";
  }
  return null;
}

export function Greeting() {
  const router = useRouter();
  const { state, run } = usePipeline();
  const [text, setText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  // SSR-safe: both the server render and the first client render show this
  // neutral, on-voice fallback. The real time-of-day swap happens client-only
  // in the effect below so hydration never mismatches on the visitor's clock.
  const [greeting, setGreeting] = useState("Hello.");
  const navigatedRef = useRef(false);

  useEffect(() => {
    setGreeting(timeOfDayGreeting(new Date().getHours()));
  }, []);

  // Hand off to the interim reveal the moment the pipeline's terminal ok
  // frame lands. Guarded so a re-render never double-navigates.
  useEffect(() => {
    if (state.phase === "done" && !navigatedRef.current) {
      navigatedRef.current = true;
      router.push(`/trip/${state.result.tripId}`);
    }
  }, [state, router]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const message = validatePaste(text);
    setFormError(message);
    if (message) return;
    run(text);
  }

  // Loading surface (design.md §8): Gracie cycles per real stage, soup-pot
  // progress, failure = frozen "this is fine" + retry — all inside
  // LoadingView already; wired here, not reinvented.
  if (state.phase === "running" || state.phase === "error") {
    return (
      <main className="greeting-main" data-testid="greeting-running">
        <LoadingView state={state} onRetry={() => run(text)} />
      </main>
    );
  }

  // Brief bridge frame between the terminal ok frame and the redirect
  // landing — avoids flashing LoadingView's pot back to 0% (it has no "done"
  // branch of its own; it isn't asked to render one).
  if (state.phase === "done") {
    return (
      <main className="greeting-main" data-testid="greeting-handoff">
        <div className="greeting-handoff">
          <GracieScene
            name="soup-stir"
            size={160}
            paused
            data-testid="greeting-handoff-gracie"
          />
          <p>Your route&rsquo;s ready. Taking you there&hellip;</p>
        </div>
      </main>
    );
  }

  return (
    <main className="greeting-main greeting-hero" data-testid="greeting-idle">
      <form className="greeting-form" onSubmit={handleSubmit} noValidate>
        {/* The post-it IS the paste field — a warm sticky note in the notebook,
            held by a strip of washi tape. Everything lives on the note. */}
        <div className="greeting-postit" data-testid="greeting-card">
          <span className="greeting-postit__tape" aria-hidden="true" />
          <h1 className="greeting-time" data-testid="greeting-time">
            {greeting}
          </h1>
          <label htmlFor="greeting-paste-input" className="greeting-label">
            Paste your trip — links, notes, chaos welcome.
          </label>
          <JournalInput
            as="textarea"
            id="greeting-paste-input"
            className="greeting-textarea"
            rows={5}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (formError) setFormError(null);
            }}
            data-testid="greeting-paste"
          />
          {formError && (
            <p className="greeting-form-error" role="alert" data-testid="greeting-form-error">
              {formError}
            </p>
          )}
          <div className="greeting-actions">
            <p className="greeting-how" data-testid="greeting-how">
              Paste anything with your trip in it — Gracie untangles the order, you get a plan to share.
            </p>
            <InkButton type="submit" variant="primary" data-testid="greeting-submit">
              Let&rsquo;s cook!
            </InkButton>
          </div>
        </div>
      </form>
    </main>
  );
}
