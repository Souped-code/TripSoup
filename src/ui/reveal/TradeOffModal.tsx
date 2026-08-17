"use client";

// E6c — the decision modal (Chris, 2026-08-14: "like picking a perk in TFT";
// layout locked to Chris's mock, 2026-08-17): the issue floats top-centre on
// the paper wash (no panel box, like TFT's augment screen), below it a row of
// up to three TALL pick-cards with a left/right arrow either side cycling
// previous/next issue, and a single "Decide later" button bottom-centre.
// "leave it" (the persisted per-conflict dismiss) stays as a quiet link under
// the cards — it's an action on THIS issue, not on the whole deck.
// Dumb/presentational: RevealClient owns the queue, the
// auto-pop-once-per-new-issue-set logic, and every callback.
//
// Testid compatibility is deliberate: `tradeoff-card-*`, `tradeoff-accept-*`
// and `tradeoff-dismiss-*` carry over from the retired sidebar card stack so
// the e2e suite exercises the same semantics in the new surface.

import { useEffect } from "react";
import type { Conflict, Proposal, ProposalKind } from "@/lib/engine/types";
import { formatDuration } from "@/lib/util/duration";
import { InkButton } from "@/ui/journal/InkButton";
import type { TradeOffCardEntry } from "./JournalSidebar";
import "./reveal.css";

function provenanceLabel(conflict: Conflict): string {
  switch (conflict.constraintRef.provenance.source) {
    case "google":
      return "Google says";
    case "llm":
      return "from your notes";
    case "user":
      return "you set this";
    case "legacy":
      return "from your itinerary";
    case "derived":
      return "Gracie's default";
    default:
      return "the plan";
  }
}

function byHowMuchText(conflict: Conflict): string {
  if (conflict.violatedByMin > 0) {
    return `off by ${formatDuration(conflict.violatedByMin)}`;
  }
  return "no amount of shuffling fixes it on its own";
}

function kindLabel(kind: ProposalKind, patch: Proposal["patch"]): string {
  switch (kind) {
    case "dropStop":
      return "Skip it";
    case "shiftWindow":
      return patch.op === "setDayWindow" ? "Run the day later" : "Shift the booking";
    case "moveDay":
      return patch.op === "moveStop" ? `Move to day ${patch.toDayIndex + 1}` : "Move it";
    case "trimDuration":
      return "Trim the visit";
    case "relaxPace":
      return "Ease the pace";
  }
}

function costDeltaLabel(costDeltaMin: number): string {
  const rounded = Math.round(costDeltaMin);
  if (rounded === 0) return "about the same either way";
  if (rounded < 0) return `saves ${formatDuration(Math.abs(rounded))}`;
  return `+${formatDuration(rounded)} travel`;
}

/** TFT shows exactly three; more chips than that is a menu, not a decision. */
const PICK_LIMIT = 3;
const PICK_ROTATE = [-1.1, 0.7, -0.6];

export interface TradeOffModalProps {
  cards: TradeOffCardEntry[];
  index: number;
  busy: boolean;
  onAccept: (proposal: Proposal) => void;
  onDismiss: (conflict: Conflict) => void;
  onPrev: () => void;
  onNext: () => void;
  onDecideLater: () => void;
}

export function TradeOffModal({
  cards,
  index,
  busy,
  onAccept,
  onDismiss,
  onPrev,
  onNext,
  onDecideLater,
}: TradeOffModalProps) {
  const many = cards.length > 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDecideLater();
      else if (e.key === "ArrowLeft" && many) onPrev();
      else if (e.key === "ArrowRight" && many) onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDecideLater, onPrev, onNext, many]);

  const shown = Math.min(index, cards.length - 1);
  const entry = cards[shown];
  if (!entry) return null;
  const { conflict, proposals } = entry;
  const picks = proposals.slice(0, PICK_LIMIT);

  return (
    <div
      className="reveal-decision-overlay"
      data-testid="decision-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Gracie needs a decision"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDecideLater();
      }}
    >
      <div className="reveal-decision-stage" data-testid={`tradeoff-card-${conflict.id}`}>
        {/* the issue, floating top-centre — no panel box (Chris's mock) */}
        <header className="reveal-decision-issue">
          <p className="reveal-decision-issue__count" data-testid="decision-modal-count">
            {many ? `decision ${shown + 1} of ${cards.length}` : "one decision to make"}
          </p>
          <h2 className="reveal-decision-issue__what" data-testid="tradeoff-card-what">
            {conflict.message}
          </h2>
          <p className="reveal-decision-issue__who" data-testid="tradeoff-card-who">
            {provenanceLabel(conflict)} — {byHowMuchText(conflict)}.
          </p>
        </header>

        {/* arrows either side cycle previous/next issue (mock); hidden when
            there is only one issue to decide */}
        <div className="reveal-decision-row">
          {many && (
            <button
              type="button"
              className="reveal-decision-arrow"
              data-testid="decision-modal-prev"
              aria-label="Previous issue"
              disabled={busy}
              onClick={onPrev}
            >
              ←
            </button>
          )}

          {picks.length > 0 ? (
            <div className="reveal-decision-picks">
              {picks.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  className="reveal-decision-pick"
                  style={{ transform: `rotate(${PICK_ROTATE[i % PICK_ROTATE.length]}deg)` }}
                  data-testid={`tradeoff-accept-${p.id}`}
                  disabled={busy}
                  onClick={() => onAccept(p)}
                >
                  <span className="reveal-decision-pick__kind">{kindLabel(p.kind, p.patch)}</span>
                  <span className="reveal-decision-pick__message">{p.message}</span>
                  <span className="reveal-decision-pick__cost">{costDeltaLabel(p.costDeltaMin)}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="reveal-decision-none">
              Gracie couldn&rsquo;t find a clean fix — have a look and adjust by hand.
            </p>
          )}

          {many && (
            <button
              type="button"
              className="reveal-decision-arrow"
              data-testid="decision-modal-next"
              aria-label="Next issue"
              disabled={busy}
              onClick={onNext}
            >
              →
            </button>
          )}
        </div>

        <button
          type="button"
          className="reveal-decision-leave"
          data-testid={`tradeoff-dismiss-${conflict.id}`}
          disabled={busy}
          onClick={() => onDismiss(conflict)}
        >
          leave it — Gracie stops asking
        </button>

        <InkButton
          className="reveal-decision-later"
          data-testid="tradeoff-decide-later"
          disabled={busy}
          onClick={onDecideLater}
        >
          Decide later
        </InkButton>
      </div>
    </div>
  );
}
