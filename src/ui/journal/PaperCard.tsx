import type { ReactNode } from "react";
import "./journal.css";

/**
 * PaperCard — journal design system container (design.md §5).
 *
 * "Irregular" border approximation: design.md allows a pragmatic v1 using
 * slightly asymmetric border-radius corners instead of a heavier SVG
 * rough-edge filter / border-image — see `.journal-card` in journal.css.
 * Server Component: purely presentational, no interaction/hooks needed.
 */
export function PaperCard({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div className={["journal-card", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}
