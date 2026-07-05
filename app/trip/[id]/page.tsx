// D2.3 M1: the reveal at /trip/[id] now paints the REAL map — the custom
// journal render engine (src/lib/map/map-render-core.js) wired in via
// RevealMap (client component, fixed-view v1: basemap painted once, overlay
// re-draws on order changes). The torn-journal sidebar, drag-to-reorder, and
// cloud transition remain T6/M2 tasks; until then PlanView keeps rendering
// the schedule below the map (server-recompute pattern shared with
// app/share/[id]/page.tsx — deterministic solver: recompute == what the
// pipeline just produced).

import { getTripStore } from "@/lib/config";
import { planTripDay } from "@/lib/planService";
import { PlanView } from "@/ui/PlanView";
import { PaperCard } from "@/ui/journal/PaperCard";
import { SketchDivider } from "@/ui/journal/SketchDivider";
import { GracieScene } from "@/ui/journal/GracieScene";
import { RevealMap } from "@/ui/reveal/RevealMap";
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
  // reveal: the day renders PlanView's rejected state and the map still
  // paints the stored stop order. (Found by a live smoke: unknown-to-fixture
  // stop ids made planTripDay throw and crash the whole page.)
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

  // M1 map: first day that has stops. Visit order comes from the plan when it
  // solved (includes manualOrder handling); otherwise the day's stored order.
  const mapDayIdx = doc.days.findIndex((d) => d.stops.length > 0);
  const mapDay = mapDayIdx >= 0 ? doc.days[mapDayIdx] : null;
  const mapPlan = mapDayIdx >= 0 ? plans[mapDayIdx] : null;
  const mapOrder =
    mapPlan && mapPlan.status === "ok"
      ? mapPlan.order
      : mapDay
        ? mapDay.stops.map((s) => s.id)
        : [];
  const mapBookedId = mapDay?.stops.find((s) => s.anchor)?.id ?? null;

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

        {mapDay && mapOrder.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <RevealMap
              stops={mapDay.stops.map((s) => ({
                id: s.id,
                name: s.name,
                lat: s.location.lat,
                lng: s.location.lng,
              }))}
              orderedIds={mapOrder}
              bookedId={mapBookedId}
            />
            {doc.days.length > 1 && (
              <p
                style={{
                  fontFamily: "var(--font-body)",
                  color: "var(--ink-soft)",
                  fontSize: 13,
                  margin: "6px 2px 0",
                }}
              >
                Day {mapDayIdx + 1} on the map — day tabs arrive with the sidebar.
              </p>
            )}
          </div>
        )}

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
