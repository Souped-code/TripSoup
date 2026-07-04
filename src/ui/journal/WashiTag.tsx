import type { ReactNode } from "react";
import "./journal.css";

/**
 * WashiTag — small "booked/anchor" label (design.md §3, §8).
 * `--ink` text on `--washi` background computes to ~9.5:1 (WCAG AAA),
 * comfortably clearing the 4.5:1 body-text minimum even at small sizes.
 * Server Component: purely presentational, no interaction/hooks needed.
 */
export function WashiTag({
  children,
  ...rest
}: {
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <span className="journal-washi-tag" {...rest}>
      {children}
    </span>
  );
}
