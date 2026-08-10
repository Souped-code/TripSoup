// Client-safe pure helpers shared between server code (planService.ts) and
// client components (src/ui/reveal/RevealClient.tsx) and the share server
// component (app/share/[id]/page.tsx). Deliberately NOT part of planService,
// which is server-only by convention (imports getMapsProvider etc.) and
// cannot be imported from a "use client" module. This module must stay free
// of any server-only import (fs, config.ts, planService.ts, …).

// A manualOrder is honored only if it is an exact permutation of the current
// stop ids — same size, same set, no duplicates, no unknowns. Anything else
// (a stale order from before the stop list changed) returns null, meaning
// "fall back to the solved/stored order" — the same rule enforced server-side
// by planService.planTripDay, mirrored here so every reader (server pages,
// client optimistic UI) agrees on what counts as a valid pin.
export function validManualOrder(
  manualOrder: string[] | undefined,
  stopIds: string[]
): string[] | null {
  if (!manualOrder || manualOrder.length !== stopIds.length || stopIds.length === 0) return null;
  const idSet = new Set(stopIds);
  const seen = new Set<string>();
  for (const id of manualOrder) {
    if (!idSet.has(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return manualOrder;
}
