"use client";

// E6b — one trade-off card per active conflict (design.md journal voice): what
// broke, whose constraint it was (provenance), and by how much — plus a chip
// per proposal that resolves it. Dumb/presentational: RevealClient computes
// which cards are visible (day-scope + dismissal filtering, src/lib/planShared.ts)
// and JournalSidebar wires the accept/dismiss callbacks through to it.

import type { Conflict, Proposal, ProposalKind } from "@/lib/engine/types";
import { WashiTag } from "@/ui/journal/WashiTag";
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
    return `off by ${Math.ceil(conflict.violatedByMin)} min`;
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
  if (rounded < 0) return `saves ${Math.abs(rounded)} min`;
  return `+${rounded} min travel`;
}

export interface TradeOffCardProps {
  conflict: Conflict;
  proposals: Proposal[];
  busy: boolean;
  onAccept: (proposal: Proposal) => void;
  onDismiss: (conflict: Conflict) => void;
}

export function TradeOffCard({ conflict, proposals, busy, onAccept, onDismiss }: TradeOffCardProps) {
  return (
    <div className="reveal-tradeoff-card" data-testid={`tradeoff-card-${conflict.id}`}>
      <p className="reveal-tradeoff-card__what" data-testid="tradeoff-card-what">
        {conflict.message}
      </p>
      <p className="reveal-tradeoff-card__who" data-testid="tradeoff-card-who">
        {provenanceLabel(conflict)} — {byHowMuchText(conflict)}.
      </p>

      {proposals.length > 0 && (
        <div className="reveal-tradeoff-card__chips">
          {proposals.map((p) => (
            <WashiTag
              key={p.id}
              as="button"
              tone="leaf"
              className="reveal-tradeoff-chip"
              data-testid={`tradeoff-accept-${p.id}`}
              disabled={busy}
              onClick={() => onAccept(p)}
            >
              {kindLabel(p.kind, p.patch)} · {costDeltaLabel(p.costDeltaMin)}
            </WashiTag>
          ))}
        </div>
      )}

      <button
        type="button"
        className="reveal-tradeoff-card__dismiss"
        data-testid={`tradeoff-dismiss-${conflict.id}`}
        disabled={busy}
        onClick={() => onDismiss(conflict)}
      >
        dismiss
      </button>
    </div>
  );
}
