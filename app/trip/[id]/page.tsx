// D2.3 T6 — the reveal at /trip/[id]: server component reads the trip's
// PERSISTED plan (E4 — src/lib/planStore.ts's readPlanned; no per-page
// recompute. A planTripDay failure still degrades to a rejected-status plan
// for that day rather than 500ing the whole page, but that resilience now
// lives inside planStore.savePlanned, not here), then hands doc + plans to
// RevealClient, which owns all reveal state (active day, drag-reorder,
// re-optimize, duplicate removal) and renders the map beside the
// torn-journal sidebar.

import { readPlanned } from "@/lib/planStore";
import { SketchDivider } from "@/ui/journal/SketchDivider";
import { GracieScene } from "@/ui/journal/GracieScene";
import { RevealClient } from "@/ui/reveal/RevealClient";

export const dynamic = "force-dynamic";

export default async function TripRevealPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const doc = await readPlanned(id);

  if (!doc) {
    return (
      <main
        style={{ background: "var(--paper)", minHeight: "100dvh", padding: "48px 24px" }}
        data-testid="trip-not-found"
      >
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 400,
            color: "var(--ink)",
          }}
        >
          Trip not found.
        </h1>
        <p style={{ fontFamily: "var(--font-body)", color: "var(--ink-soft)" }}>
          That trip doesn&rsquo;t exist, or the link&rsquo;s gone stale.
        </p>
      </main>
    );
  }

  // readPlanned guarantees `doc.plan` is present (self-healing legacy docs
  // and stamping trivial empty-day plans on the way) — see planStore.ts.
  // Non-null: `plan` is optional only in the TripDoc TYPE (so pre-E4 docs
  // typecheck), never in what readPlanned actually returns.
  const plans = doc.plan!.days;

  return (
    <main
      // maxWidth:"none" overrides globals.css's `main { max-width: 880px }`
      // (a leftover from the narrow legacy pages) — the reveal is a wide board,
      // and without this the inner 1360 frame was capped at 880 and the map
      // rendered small (Chris's "scale not harmonious" note, 2026-07-07).
      style={{ background: "var(--paper)", minHeight: "100dvh", padding: "clamp(14px, 3.5vw, 24px) clamp(12px, 3.5vw, 24px) 40px", maxWidth: "none" }}
      data-testid="trip-reveal"
    >
      <div style={{ maxWidth: 1360, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 14, marginBottom: 6 }}>
          <GracieScene name="soup-stir" size={64} paused data-testid="trip-reveal-gracie" />
          <div>
            <h1
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 400,
                color: "var(--ink)",
                margin: 0,
                fontSize: "clamp(1.5rem, 4.5vw, 2rem)",
              }}
              data-testid="trip-reveal-heading"
            >
              Your route&rsquo;s ready.
            </h1>
            <p
              style={{
                fontFamily: "var(--font-body)",
                color: "var(--ink-soft)",
                margin: "4px 0 0",
              }}
            >
              Reorder any stop and Gracie re-times the day.
            </p>
          </div>
        </div>

        <SketchDivider />

        <div style={{ marginTop: 14 }}>
          <RevealClient initialDoc={doc} initialPlans={plans} />
        </div>
      </div>
    </main>
  );
}
