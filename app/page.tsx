"use client";

// D2.3 (T2): the old board moved to /debug/trip/[id] (env-gated). "/" keeps
// this same New-trip action for now, just repointed there, so it stays a
// working front door until a later task replaces it with the real greeting.
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function Home() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function createTrip() {
    setBusy(true);
    const res = await fetch("/api/trips", { method: "POST" });
    const doc = await res.json();
    router.push(`/debug/trip/${doc.tripId}`);
  }

  return (
    <main>
      <h1>Itinerary Optimiser</h1>
      <p className="muted">
        Paste Google Maps links, mark your bookings, get an optimized day plan.
      </p>
      <button className="primary" onClick={createTrip} disabled={busy} data-testid="new-trip">
        New trip
      </button>
    </main>
  );
}
