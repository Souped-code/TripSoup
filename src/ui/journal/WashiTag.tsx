"use client";

import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import "./journal.css";

export type WashiTone = "washi" | "coral" | "sky" | "pink" | "leaf";

type SpanVariant = { as?: "span" } & HTMLAttributes<HTMLSpanElement>;
type ButtonVariant = { as: "button" } & ButtonHTMLAttributes<HTMLButtonElement>;

export type WashiTagProps = (SpanVariant | ButtonVariant) & {
  children: ReactNode;
  tone?: WashiTone;
};

/**
 * WashiTag — a strip of washi tape (design.md §3, §8). Originally just the
 * yellow booked/anchor label (a plain span); extended here, additively, for
 * D2.3 T6's reveal sidebar:
 *  - `tone` picks one of the §3 decorative tape colors — default "washi"
 *    (yellow) renders byte-identical to the original hardcoded look, so
 *    every existing caller (the debug gallery) is unaffected.
 *  - `as="button"` lets a WashiTag double as a real focusable control — the
 *    sidebar's drag handle needs a keyboard-operable element for dnd-kit's
 *    KeyboardSensor, which a bare <span> can never be.
 */
export const WashiTag = forwardRef<HTMLElement, WashiTagProps>(function WashiTag(
  { children, tone = "washi", as = "span", className, ...rest },
  ref
) {
  const cls = [
    "journal-washi-tag",
    `journal-washi-tag--${tone}`,
    as === "button" && "journal-washi-tag--handle",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (as === "button") {
    const buttonRest = rest as ButtonHTMLAttributes<HTMLButtonElement>;
    return (
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        className={cls}
        {...buttonRest}
        type="button"
      >
        {children}
      </button>
    );
  }

  const spanRest = rest as HTMLAttributes<HTMLSpanElement>;
  return (
    <span ref={ref as React.Ref<HTMLSpanElement>} className={cls} {...spanRest}>
      {children}
    </span>
  );
});
