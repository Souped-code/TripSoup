// D2.3 (T2): debug-only entry point that creates a trip and hands off to the
// relocated board at /debug/trip/[id]. Same gate as the other /debug pages
// (notFound() unless DEBUG_BOARD=1). The board's Playwright specs start here
// now (page.goto("/debug/trip") + click new-trip) instead of "/", since the
// board itself no longer lives at "/".
import { notFound } from "next/navigation";
import { NewTripButton } from "@/ui/board/NewTripButton";

export default function NewTripDebugPage() {
  if (process.env.DEBUG_BOARD !== "1") notFound();

  return (
    <main>
      <h1>Itinerary Optimiser</h1>
      <p className="muted">
        Paste Google Maps links, mark your bookings, get an optimized day plan.
      </p>
      <NewTripButton />
    </main>
  );
}
