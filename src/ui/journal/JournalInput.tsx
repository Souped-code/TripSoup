"use client";

import type { ChangeEventHandler } from "react";
import "./journal.css";

export interface JournalInputProps {
  as?: "input" | "textarea";
  className?: string;
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  name?: string;
  id?: string;
  rows?: number;
  disabled?: boolean;
  onChange?: ChangeEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  onBlur?: ChangeEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  "data-testid"?: string;
}

/**
 * JournalInput — journal design system text field (design.md §5).
 * `--paper-shade` fill, `--ink` border/text, `var(--font-body)`.
 * "use client": inputs need onChange/onBlur wiring wherever they're used.
 */
export function JournalInput({ as = "input", className, rows, ...rest }: JournalInputProps) {
  const cls = ["journal-input", className].filter(Boolean).join(" ");
  if (as === "textarea") {
    return <textarea className={cls} rows={rows} {...rest} />;
  }
  return <input className={cls} {...rest} />;
}
