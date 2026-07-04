// D1.4 debug-only gallery for the journal design system (design.md). Gated
// behind DEBUG_BOARD=1 so it never appears in a normal production build —
// not linked from anywhere in the live app, and unreachable without the env
// var. Server Component: purely presentational demo, no interaction needed
// at this layer (InkButton/JournalInput themselves are "use client").

import { notFound } from "next/navigation";
import { PaperCard } from "@/ui/journal/PaperCard";
import { InkButton } from "@/ui/journal/InkButton";
import { JournalInput } from "@/ui/journal/JournalInput";
import { WashiTag } from "@/ui/journal/WashiTag";
import { SketchDivider } from "@/ui/journal/SketchDivider";
import { GracieScene } from "@/ui/journal/GracieScene";

export default function DesignGalleryPage() {
  if (process.env.DEBUG_BOARD !== "1") notFound();

  return (
    <main style={{ padding: 24, background: "var(--paper)", color: "var(--ink)" }}>
      <h1 style={{ fontFamily: "var(--font-display)" }}>Journal design gallery</h1>
      <p style={{ fontFamily: "var(--font-body)" }}>
        Debug-only board for the D1.4 design tokens and journal component library.
        Visible only when DEBUG_BOARD=1 (see design.md).
      </p>

      <h2 style={{ fontFamily: "var(--font-display)" }}>PaperCard</h2>
      <PaperCard data-testid="gallery-paper-card">
        <p style={{ fontFamily: "var(--font-body)", margin: 0 }}>
          A paper card, recessed and softly shadowed.
        </p>
      </PaperCard>

      <SketchDivider />

      <h2 style={{ fontFamily: "var(--font-display)" }}>InkButton</h2>
      <div style={{ display: "flex", gap: 12 }}>
        <InkButton variant="primary" data-testid="gallery-ink-button-primary">
          Primary action
        </InkButton>
        <InkButton variant="secondary" data-testid="gallery-ink-button-secondary">
          Secondary action
        </InkButton>
      </div>

      <SketchDivider />

      <h2 style={{ fontFamily: "var(--font-display)" }}>JournalInput</h2>
      <label htmlFor="gallery-input-demo" style={{ fontFamily: "var(--font-body)" }}>
        Trip name
      </label>
      <div>
        <JournalInput
          id="gallery-input-demo"
          placeholder="Tokyo, spring 2027"
          data-testid="gallery-journal-input"
        />
      </div>

      <SketchDivider />

      <h2 style={{ fontFamily: "var(--font-display)" }}>WashiTag</h2>
      <WashiTag data-testid="gallery-washi-tag">booked</WashiTag>

      <SketchDivider />

      <h2 style={{ fontFamily: "var(--font-display)" }}>SketchDivider</h2>
      <SketchDivider data-testid="gallery-sketch-divider" />

      <SketchDivider />

      <h2 style={{ fontFamily: "var(--font-display)" }}>GracieScene</h2>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <GracieScene name="pin-throw" size={192} data-testid="gallery-gracie-pin-throw" />
        <GracieScene name="route-scribble" size={192} data-testid="gallery-gracie-route-scribble" />
        <GracieScene name="this-is-fine" size={192} data-testid="gallery-gracie-this-is-fine" />
        <GracieScene name="soup-stir" size={192} data-testid="gallery-gracie-soup-stir" />
      </div>
    </main>
  );
}
