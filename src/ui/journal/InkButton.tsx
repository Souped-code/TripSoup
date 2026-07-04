"use client";

import type { ButtonHTMLAttributes } from "react";
import "./journal.css";

export interface InkButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
}

/**
 * InkButton — journal design system button (design.md §5).
 *
 * Palette rule (design.md §3): `--action` green is the ONLY button/CTA
 * color — `--soup` orange is brand/illustration, never an action color.
 * Primary is `--action` fill with `--paper` text (5.46:1, passes AA body
 * text at any size). Secondary is `--paper` fill with `--ink` border/text
 * (~13.3:1, safe at any size).
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
