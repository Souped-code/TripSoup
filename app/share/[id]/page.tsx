// P5: read-only share view by slug. Server component — recomputes plans from
// the stored document (deterministic solver: recompute == what the owner saw,
// including persisted leg toggles via planService).

import { getTripStore } from "@/lib/config";
import { planTripDay } from "@/lib/planService";
import { fmtTime } from "@/ui/time";
import { PlanView } from "@/ui/PlanView";

export const dynamic = "force-dynamic";

export default async function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await getTripStore().get(id);
  if (!doc) {
    return (
      <main>
        <h1>Trip not found</h1>
      </main>
    );
  }

  const plans = await Promise.all(doc.days.map((_, i) => planTripDay(doc, i)));

  return (
    <main data-testid="share-view">
      <h1>Itinerary</h1>
      <p className="muted">Read-only shared plan.</p>
      {doc.days.map((day, i) => (
        <section className="card" key={i} data-testid={`share-day-${i}`}>
          <h2>
            Day {i + 1} · {day.date} · {fmtTime(day.dayStartMin)}–{fmtTime(day.dayEndMin)}
          </h2>
          {day.stops.length === 0 ? (
            <div className="muted">No stops.</div>
          ) : (
            <PlanView
              plan={plans[i]}
              stopNames={Object.fromEntries(day.stops.map((s) => [s.id, s.name]))}
              readOnly
            />
          )}
        </section>
      ))}
    </main>
  );
}
