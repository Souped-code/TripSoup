// Synthetic city "Casterbridge" — §3 fixture data, lives in the repo.
// ~20 stops with real-looking coordinates. Driving times derive from a metric
// formula, so the triangle inequality holds by construction:
//   drive(a,b) = ceil( haversine(a,b)/500 + access(a) + access(b) )  minutes
// (500 m/min ~ 30 km/h urban driving; access = per-stop parking/approach cost.
// ceil preserves the inequality: x<=y+z implies ceil(x)<=ceil(y)+ceil(z).)
// Stops fx-01..fx-04 form a walkable old-town cluster (<600 m hops) so walk-leg
// behaviour is exercised; the rest spread over ~5 km so driving dominates.

import { haversineMeters } from "./walkEstimator";
import type { LatLng } from "./types";

export type FixtureStop = {
  id: string;
  name: string;
  location: LatLng;
  address: string;
  accessMin: number; // parking/approach cost folded into drive times
};

const s = (
  id: string,
  name: string,
  lat: number,
  lng: number,
  accessMin: number
): FixtureStop => ({
  id,
  name,
  location: { lat, lng },
  address: `${name}, Casterbridge`,
  accessMin,
});

export const FIXTURE_STOPS: FixtureStop[] = [
  // old-town cluster — walkable hops
  s("fx-01", "Market Hall", 51.45, -2.6, 2),
  s("fx-02", "Clock Tower Square", 51.4512, -2.5988, 1),
  s("fx-03", "Guildhall Museum", 51.4491, -2.5979, 1),
  s("fx-04", "Riverside Cafe", 51.4478, -2.6013, 0),
  // harbour cluster
  s("fx-05", "Old Port Aquarium", 51.438, -2.618, 3),
  s("fx-06", "Harbour Fort", 51.4362, -2.6205, 2),
  s("fx-07", "South Beach Boardwalk", 51.433, -2.615, 1),
  // spread
  s("fx-08", "Botanic Conservatory", 51.457, -2.609, 1),
  s("fx-09", "Grand Theatre", 51.4525, -2.6045, 2),
  s("fx-10", "Cathedral", 51.4535, -2.596, 1),
  s("fx-11", "Artisan Quarter", 51.4482, -2.5925, 0),
  s("fx-12", "University Quad", 51.461, -2.602, 1),
  s("fx-13", "Northgate Mall", 51.466, -2.595, 4),
  s("fx-14", "City Stadium", 51.47, -2.612, 4),
  s("fx-15", "Observatory Hill", 51.464, -2.623, 2),
  s("fx-16", "Castle Keep", 51.4445, -2.588, 2),
  s("fx-17", "Lakeside Pavilion", 51.457, -2.585, 1),
  s("fx-18", "City Zoo", 51.476, -2.588, 3),
  s("fx-19", "Science Dome", 51.4415, -2.61, 2),
  s("fx-20", "Vineyard Terrace", 51.4805, -2.626, 1),
];

const DRIVE_SPEED_M_PER_MIN = 500;

export function fixtureDriveMinutes(a: FixtureStop, b: FixtureStop): number {
  if (a.id === b.id) return 0;
  return Math.ceil(
    haversineMeters(a.location, b.location) / DRIVE_SPEED_M_PER_MIN + a.accessMin + b.accessMin
  );
}
