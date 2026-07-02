// Local walking estimator — §3 (LOCKED). Pure, no API, NOT on the mapsProvider
// port. Decides walk eligibility at zero marginal spend.

import type { LatLng, Settings } from "./types";

const EARTH_RADIUS_M = 6371000;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.asin(Math.sqrt(s));
}

export function walkMinutesFromMeters(meters: number, settings: Settings): number {
  return (meters * settings.detourFactor) / settings.walkSpeedMPerMin;
}

export function walkMinutes(a: LatLng, b: LatLng, settings: Settings): number {
  return walkMinutesFromMeters(haversineMeters(a, b), settings);
}

// §2: a pair is walk-eligible when the walking estimate <= walkMax (inclusive).
export function isWalkEligible(walkMin: number, settings: Settings): boolean {
  return walkMin <= settings.walkMax;
}
