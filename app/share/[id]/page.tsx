// Phase B.1 — read-only share view by slug, rebuilt into the same journal
// world as the reveal (/trip/[id]): the hand-drawn map beside a read-only
// torn-journal timeline (src/ui/reveal/ShareTimeline.tsx), instead of the
// legacy PlanView inside generic white .cards. Server component —
// recomputes plans from the stored document (deterministic solver: recompute
// == what the owner saw, including persisted leg toggles via planService).
// Same resilience pattern as /trip/[id]: a planTripDay failure degrades to a
// rejected-status plan for that day rather than 500ing the whole page.

import { getTripStore } from "@/lib/config";
import { planTripDay } from "@/lib/planService";
import { RevealMap, type RevealStop } from "@/ui/reveal/RevealMap";
import { ShareTimeline } from "@/ui/reveal/ShareTimeline";
import type { DayPlan } from "@/lib/schedule/types";

export const dynamic = "force-dynamic";

// Mirrors planService.ts's private validManualOrder / RevealClient.tsx's
// client-side copy of the same rule (server-only, not exported, and
// RevealClient is a "use client" module this server component can't import
// a plain function from) — a manualOrder only counts if it's an exact
// permutation of the day's current stop ids; anything else (stale/partial/
// unknown) falls back to the stored stop order, same as the server does.
function validManualOrder(manualOrder: string[] | undefined, stopIds: string[]): string[] | null {
  if (!manualOrder || manualOrder.length !== stopIds.length) return null;
  const idSet = new Set(stopIds);
  const seen = new Set<string>();
  for (const id of manualOrder) {
    if (!idSet.has(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return manualOrder;
}

export default async function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await getTripStore().get(id);

  if (!doc) {
    return (
      <main
        style={{ background: "var(--paper)", minHeight: "100dvh", padding: "48px 24px" }}
        data-testid="share-view"
      >
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 400, color: "var(--ink)" }}>
          Trip not found.
        </h1>
        <p style={{ fontFamily: "var(--font-body)", color: "var(--ink-soft)" }}>
          That trip doesn&rsquo;t exist, or the link&rsquo;s gone stale.
        </p>
      </main>
    );
  }

  const plans: DayPlan[] = await Promise.all(
    doc.days.map(async (_, i) => {
      try {
        return await planTripDay(doc, i);
      } catch (e) {
        return {
          status: "rejected" as const,
          message:
            "This day's plan couldn't be cooked — " + (e instanceof Error ? e.message : String(e)),
        };
      }
    })
  );

  return (
    <main
      // maxWidth:"none" overrides globals.css's `main { max-width: 880px }`,
      // same fix /trip/[id] needed — without it the 1360 board frame is
      // capped at 880 and the map renders small.
      style={{
        background: "var(--paper)",
        minHeight: "100dvh",
        padding: "clamp(14px, 3.5vw, 24px) clamp(12px, 3.5vw, 24px) 40px",
        maxWidth: "none",
      }}
      data-testid="share-view"
    >
      <div style={{ maxWidth: 1360, margin: "0 auto" }}>
        <div style={{ marginBottom: 6 }}>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 400,
              color: "var(--ink)",
              margin: 0,
              fontSize: "clamp(1.5rem, 4.5vw, 2rem)",
            }}
          >
            Your itinerary
          </h1>
          <p style={{ fontFamily: "var(--font-body)", color: "var(--ink-soft)", margin: "4px 0 0" }}>
            A shared plan from TripSoup.
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 32, marginTop: 14 }}>
          {doc.days.map((day, i) => {
            const plan = plans[i];
            const stopIds = day.stops.map((s) => s.id);
            const orderedIds =
              plan.status === "ok" ? plan.order : (validManualOrder(day.manualOrder, stopIds) ?? stopIds);
            const bookedId = day.stops.find((s) => s.anchor)?.id ?? null;
            const mapStops: RevealStop[] = day.stops.map((s) => ({
              id: s.id,
              name: s.name,
              lat: s.location.lat,
              lng: s.location.lng,
            }));

            return (
              <section key={i} data-testid={`share-day-${i}`}>
                {doc.days.length > 1 && (
                  <h2
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 400,
                      color: "var(--ink-soft)",
                      fontSize: "1.1rem",
                      margin: "0 0 10px",
                    }}
                  >
                    Day {i + 1}
                  </h2>
                )}
                {day.stops.length === 0 ? (
                  <p style={{ fontFamily: "var(--font-body)", color: "var(--ink-soft)" }}>
                    No stops on this day.
                  </p>
                ) : (
                  <div className="reveal-layout">
                    <div className="reveal-layout__map">
                      <RevealMap stops={mapStops} orderedIds={orderedIds} bookedId={bookedId} />
                    </div>
                    <ShareTimeline day={day} plan={plan} orderedIds={orderedIds} />
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </main>
  );
}
