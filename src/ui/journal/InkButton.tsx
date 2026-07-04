"use client";

import type { ButtonHTMLAttributes } from "react";
import "./journal.css";

export interface InkButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
}

/**
 * InkButton — journal design system button (design.md §5).
 *
 * Contrast rule (design.md §3): `--soup` on `--paper` is ~3:1, below the
 * 4.5:1 body-text minimum, so `--soup` may only be used as a FILL with
 * `--paper`-colored text on top — never `--soup` text on a `--paper`
 * background. The primary variant below is deliberately inverted (soup
 * fill, paper text) and journal.css sizes/weights the label so it qualifies
 * as WCAG "large text", where the ~3:1 ratio is sufficient. Secondary is
 * `--paper` fill with `--ink` border/text (~13.3:1, safe at any size).
 *
 * "use client": marked so it can safely accept event handler props
 * (onClick, etc.) wherever it's composed later, including under Server
 * Component parents — it has no internal state/hooks itself.
 */
export function InkButton({
  variant = "secondary",
  className,
  children,
  type = "button",
  ...rest
}: InkButtonProps) {
  const variantClass = variant === "primary" ? "journal-btn--primary" : "journal-btn--secondary";
  return (
    <button
      type={type}
      className={["journal-btn", variantClass, className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
