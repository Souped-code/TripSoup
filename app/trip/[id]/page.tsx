// D2.3 (T3): interim reveal at /trip/[id] — an EXPLICIT PLACEHOLDER. The real
// map + torn-journal-sidebar reveal (design.md §8 Reveal: cloud transition,
// MapLibre paper map, drag-to-reorder) is a later, design-gated task; this
// exists only so paste -> cook -> see works end to end and is testable, per
// the D2.3 plan. Mirrors app/share/[id]/page.tsx's server-recompute pattern
// (deterministic solver: recompute == what the pipeline just produced) —
// reskinned with the journal design system for the page chrome. PlanView
// itself is reused read-only, completely unmodified, exactly as the share
// page uses it; its internals (still the pre-journal-system look) are out of
// this task's scope by design.

import { getTripStore } from "@/lib/config";
import { planTripDay } from "@/lib/planService";
import { PlanView } from "@/ui/PlanView";
import { PaperCard } from "@/ui/journal/PaperCard";
import { SketchDivider } from "@/ui/journal/SketchDivider";
import { GracieScene } from "@/ui/journal/GracieScene";

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

  const plans = await Promise.all(doc.days.map((_, i) => planTripDay(doc, i)));

  return (
    <main
      style={{ background: "var(--paper)", minHeight: "100dvh", padding: "48px 24px 96px" }}
      data-testid="trip-reveal"
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 8 }}>
          <GracieScene name="soup-stir" size={96} paused data-testid="trip-reveal-gracie" />
          <div>
            <h1
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 400,
                color: "var(--ink)",
                margin: 0,
                fontSize: "2rem",
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
              The map and sidebar are still being drawn up. Here&rsquo;s the plan Gracie
              cooked up in the meantime.
            </p>
          </div>
        </div>

        <SketchDivider />

        {doc.days.map((day, i) => (
          <div key={i} style={{ marginBottom: 16 }}>
            <PaperCard data-testid={`trip-day-${i}`}>
              <h2
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 400,
                  color: "var(--ink)",
                  marginTop: 0,
                }}
              >
                Day {i + 1} · {day.date}
              </h2>
              {day.stops.length === 0 ? (
                <p style={{ fontFamily: "var(--font-body)", color: "var(--ink-soft)" }}>
                  No stops.
                </p>
              ) : (
                <PlanView
                  plan={plans[i]}
                  stopNames={Object.fromEntries(day.stops.map((s) => [s.id, s.name]))}
                  readOnly
                />
              )}
            </PaperCard>
          </div>
        ))}
      </div>
    </main>
  );
}
