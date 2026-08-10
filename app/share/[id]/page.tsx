// Phase B.1 — read-only share view by slug, rebuilt into the same journal
// world as the reveal (/trip/[id]): the hand-drawn map beside a read-only
// torn-journal timeline (src/ui/reveal/ShareTimeline.tsx), instead of the
// legacy PlanView inside generic white .cards. Server component — reads the
// trip's PERSISTED plan (E4 — src/lib/planStore.ts's readPlanned; no
// per-page recompute), which is byte-for-byte what the owner saw, including
// persisted leg toggles, because it's the SAME stored plan, not a fresh
// solve. Zero /api/trips/*/plan network calls happen on this page (e2e:
// e2e/share.spec.ts asserts that).

import { readPlanned } from "@/lib/planStore";
import { validManualOrder } from "@/lib/planShared";
import { RevealMap, type RevealStop } from "@/ui/reveal/RevealMap";
import { ShareTimeline } from "@/ui/reveal/ShareTimeline";

export const dynamic = "force-dynamic";
// E5b audit F1: readPlanned can HEAL here — a full engine solve (wall-clocked
// at the budget, but still tens of seconds) inside this page render. Every doc
// stamped before hours entered solveHash heals exactly once post-deploy; the
// platform-default function timeout would kill exactly those renders.
export const maxDuration = 120;


export default async function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await readPlanned(id);

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

  // readPlanned guarantees `doc.plan` is present (self-healing legacy docs on
  // the way) — see planStore.ts. Non-null: `plan` is optional only in the
  // TripDoc TYPE (so pre-E4 docs typecheck), never in what readPlanned
  // actually returns.
  const plans = doc.plan!.days;

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
