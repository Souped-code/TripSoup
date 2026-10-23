// Is a point in Singapore? A bounding box with Johor's corners cut out — JB
// Sentral, Danga Bay and Legoland Malaysia sit inside the plain box, and a
// cross-border trip is not something the SG network can plan (immigration).
// No data import: cheap to use anywhere (solveProjection, the router).

import type { LatLng } from "../../maps/types";

export function inSingapore(p: LatLng): boolean {
  if (!(p.lat > 1.15 && p.lat < 1.48 && p.lng > 103.59 && p.lng < 104.1)) return false;
  if (p.lat > 1.455 && p.lng < 103.81) return false; // Johor Bahru, Danga Bay
  if (p.lat > 1.36 && p.lng < 103.66) return false; // Iskandar Puteri, Legoland Malaysia
  return true;
}
