"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function Home() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function createTrip() {
    setBusy(true);
    const res = await fetch("/api/trips", { method: "POST" });
    const doc = await res.json();
    router.push(`/trip/${doc.tripId}`);
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
