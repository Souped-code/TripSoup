// D2.3 T6 — the reveal at /trip/[id]: server component fetches the trip
// document + computes each day's plan (same resilience pattern as before: a
// planTripDay failure degrades to a rejected-status plan for that day rather
// than 500ing the whole page), then hands both to RevealClient, which owns
// all reveal state (active day, drag-reorder, re-optimize, duplicate
// removal) and renders the map beside the torn-journal sidebar.

import { getTripStore } from "@/lib/config";
import { planTripDay } from "@/lib/planService";
import { SketchDivider } from "@/ui/journal/SketchDivider";
import { GracieScene } from "@/ui/journal/GracieScene";
import { RevealClient } from "@/ui/reveal/RevealClient";
import type { DayPlan } from "@/lib/schedule/types";

export const dynamic = "force-dynamic";

export default async function TripRevealPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const doc = await getTripStore().get(id);

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

  // A plan failure (matrix/adapter error) must degrade legibly, never 500 the
  // reveal: RevealClient/JournalSidebar render that day's rejected state (a
  // red margin note) and the map still paints the stored stop order. (Found
  // by a live smoke: unknown-to-fixture stop ids made planTripDay throw and
  // crash the whole page.)
  const plans: DayPlan[] = await Promise.all(
    doc.days.map(async (_, i) => {
      try {
        return await planTripDay(doc, i);
      } catch (e) {
        return {
          status: "rejected" as const,
          message:
            "This day's plan couldn't be cooked — " +
            (e instanceof Error ? e.message : String(e)),
        };
      }
    })
  );

  return (
    <main
      // maxWidth:"none" overrides globals.css's `main { max-width: 880px }`
      // (a leftover from the narrow legacy pages) — the reveal is a wide board,
      // and without this the inner 1360 frame was capped at 880 and the map
      // rendered small (Chris's "scale not harmonious" note, 2026-07-07).
      style={{ background: "var(--paper)", minHeight: "100dvh", padding: "24px 24px 36px", maxWidth: "none" }}
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
                fontSize: "1.6rem",
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
              Sidebar&rsquo;s on the right.
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
