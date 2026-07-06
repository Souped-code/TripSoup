"use client";

// "New trip" action, relocated from app/page.tsx (D2.3 T2): POSTs /api/trips
// and routes to the relocated board at /debug/trip/[id]. Used by
// app/debug/trip/page.tsx (the specs' entry point); "/" keeps its own inline
// copy of this same action pointed at the same URL until a later task
// replaces "/" with the real greeting.

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewTripButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function createTrip() {
    setBusy(true);
    const res = await fetch("/api/trips", { method: "POST" });
    const doc = await res.json();
    router.push(`/debug/trip/${doc.tripId}`);
  }

  return (
    <button className="primary" onClick={createTrip} disabled={busy} data-testid="new-trip">
      New trip
    </button>
  );
}
