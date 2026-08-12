// E6b — the prose port. Mirrors src/lib/parse/types.ts's shape in spirit
// (ParseProvider) but the output is plain text, not a zod-validated object —
// there is no structured shape to get wrong, only a length to cap (the brief
// noted "{prose: string} — actually plain text is fine, cap length").

export type ProseConflict = {
  readonly id: string;
  readonly code: string;
  readonly message: string;
  readonly dayIndex?: number;
};

export type ProseProposal = {
  readonly id: string;
  readonly kind: string;
  readonly message: string;
  readonly resolves: readonly string[];
  readonly costDeltaMin: number;
};

export type ProseInput = {
  readonly conflicts: readonly ProseConflict[];
  readonly proposals: readonly ProseProposal[];
};

export interface ProseProvider {
  explain(input: ProseInput): Promise<string>;
}

/** Decorative copy is capped hard — a runaway model response must never blow
 * up a margin-note-sized UI slot. Applied by every adapter, not just the LLM
 * one, so the contract is uniform regardless of which one ran. */
export const MAX_PROSE_CHARS = 480;

export function capProse(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_PROSE_CHARS) return trimmed;
  return trimmed.slice(0, MAX_PROSE_CHARS - 1).trimEnd() + "…";
}
