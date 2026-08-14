"use client";

// E6c — the decision modal (Chris, 2026-08-14: "like picking a perk in TFT").
// One issue in the spotlight at a time: a header top-middle stating what broke
// (journal voice: what + whose constraint + by how much), then up to three big
// washi pick-cards — one per priced proposal — for the user to choose between.
// "leave it" = the old card dismiss (persisted, keyed to the day hash);
// "decide later" = close the modal without deciding (RevealClient records the
// issue-set as seen so it doesn't pop again until the set actually changes —
// the sidebar banner reopens it any time). Dumb/presentational: RevealClient
// owns the queue, the auto-pop logic, and every callback.
//
// Testid compatibility is deliberate: `tradeoff-card-*`, `tradeoff-accept-*`
// and `tradeoff-dismiss-*` carry over from the retired sidebar card stack
// (TradeOffCard.tsx) so the e2e suite exercises the same semantics in the new
// surface.

import { useEffect } from "react";
import type { Conflict, Proposal, ProposalKind } from "@/lib/engine/types";
import { formatDuration } from "@/lib/util/duration";
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
const PICK_ROTATE = [-1.6, 1.2, -0.9];

export interface TradeOffModalProps {
  cards: TradeOffCardEntry[];
  index: number;
  busy: boolean;
  onAccept: (proposal: Proposal) => void;
  onDismiss: (conflict: Conflict) => void;
  onNext: () => void;
  onDecideLater: () => void;
}

export function TradeOffModal({
  cards,
  index,
  busy,
  onAccept,
  onDismiss,
  onNext,
  onDecideLater,
}: TradeOffModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDecideLater();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDecideLater]);

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
      <div className="reveal-decision-panel" data-testid={`tradeoff-card-${conflict.id}`}>
        <p className="reveal-decision-panel__count" data-testid="decision-modal-count">
          {cards.length > 1 ? `decision ${shown + 1} of ${cards.length}` : "one decision to make"}
        </p>
        <h2 className="reveal-decision-panel__what" data-testid="tradeoff-card-what">
          {conflict.message}
        </h2>
        <p className="reveal-decision-panel__who" data-testid="tradeoff-card-who">
          {provenanceLabel(conflict)} — {byHowMuchText(conflict)}.
        </p>

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

        <div className="reveal-decision-actions">
          <button
            type="button"
            className="reveal-decision-link"
            data-testid={`tradeoff-dismiss-${conflict.id}`}
            disabled={busy}
            onClick={() => onDismiss(conflict)}
          >
            leave it — Gracie stops asking
          </button>
          {cards.length > 1 && (
            <button
              type="button"
              className="reveal-decision-link"
              data-testid="decision-modal-next"
              disabled={busy}
              onClick={onNext}
            >
              next issue →
            </button>
          )}
          <button
            type="button"
            className="reveal-decision-link reveal-decision-link--later"
            data-testid="tradeoff-decide-later"
            disabled={busy}
            onClick={onDecideLater}
          >
            decide later
          </button>
        </div>
      </div>
    </div>
  );
}
