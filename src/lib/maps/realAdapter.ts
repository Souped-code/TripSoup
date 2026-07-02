// Real adapter — §3. All Google contact for the app funnels through here.
// NEVER imported by tests (jest guard enforces this). Construction throws
// without an API key rather than failing later — cost control is spec.
//
// Resolution delegates to the verified Phase 0 module unmodified; the matrix
// half calls the Routes API (driving only) through the shared cache/batching
// orchestration in matrixSource.ts.
//
// UNVERIFIED against the live API in this run (no key present by design);
// LIVE-CHECKLIST items 1–2 validate both halves.

import { resolvePlaces } from "../../../resolvePlaces";
import type { MapsProvider } from "./types";
import { createMatrixSource, type MatrixCache, type PairFetcher } from "./matrixSource";

const ROUTES_ENDPOINT = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";

export function createRealAdapter(opts?: { cache?: MatrixCache }): MapsProvider {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Real maps adapter constructed without GOOGLE_MAPS_API_KEY — refusing (handover §3 cost control). Use the fixture adapter for development and tests."
    );
  }

  const fetcher: PairFetcher = async (origins, destinations) => {
    const waypoint = (s: { location: { lat: number; lng: number } }) => ({
      waypoint: {
        location: {
          latLng: { latitude: s.location.lat, longitude: s.location.lng },
        },
      },
    });
    const res = await fetch(ROUTES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition",
      },
      body: JSON.stringify({
        origins: origins.map(waypoint),
        destinations: destinations.map(waypoint),
        travelMode: "DRIVE",
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Routes API ${res.status}: ${text.slice(0, 200)}`);
    }
    const rows = (await res.json()) as Array<{
      originIndex: number;
      destinationIndex: number;
      duration?: string; // e.g. "1234s"
      condition?: string;
    }>;
    return rows.map((r) => {
      const seconds = r.duration ? parseFloat(r.duration) : NaN;
      if (r.condition === "ROUTE_NOT_FOUND" || !Number.isFinite(seconds)) {
        throw new Error(
          `Routes API returned no route for pair ${origins[r.originIndex]?.id} -> ${destinations[r.destinationIndex]?.id}`
        );
      }
      return {
        fromId: origins[r.originIndex].id,
        toId: destinations[r.destinationIndex].id,
        minutes: seconds / 60,
      };
    });
  };

  return {
    resolvePlaces, // Phase 0 module, unmodified (AUDIT.md §3)
    getTravelMatrix: createMatrixSource(fetcher, opts?.cache),
  };
}
