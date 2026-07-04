import "./journal.css";

/**
 * SketchDivider — hand-drawn-reading horizontal rule (design.md §5, §8).
 * Lightweight CSS approximation (a thin dashed line) rather than an SVG
 * squiggle or a JS animation library. Server Component: purely
 * presentational, no interaction/hooks needed.
 */
export function SketchDivider({ "data-testid": dataTestId }: { "data-testid"?: string } = {}) {
  return <hr className="journal-sketch-divider" data-testid={dataTestId} />;
}
