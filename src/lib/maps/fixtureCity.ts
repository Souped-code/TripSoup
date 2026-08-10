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

// E3 — deterministic, hand-written mirror of Google's `regularOpeningHours`
// RAW shape (day: 0=Sunday..6=Saturday — Google's convention, not this
// repo's ISO one; see openingHours.ts). fixtureAdapter.ts attaches this
// verbatim as `Stop.openingHours`, so fixture mode exercises the REAL
// parseGoogleHours path end to end, exactly like production — nothing about
// hours is fixture-only logic.
export type FixtureGoogleHours = {
  periods: Array<{
    open: { day: number; hour: number; minute: number };
    close?: { day: number; hour: number; minute: number };
  }>;
};

export type FixtureStop = {
  id: string;
  name: string;
  location: LatLng;
  address: string;
  accessMin: number; // parking/approach cost folded into drive times
  hours?: FixtureGoogleHours;
};

const s = (
  id: string,
  name: string,
  lat: number,
  lng: number,
  accessMin: number,
  hours?: FixtureGoogleHours
): FixtureStop => ({
  id,
  name,
  location: { lat, lng },
  address: `${name}, Casterbridge`,
  accessMin,
  ...(hours ? { hours } : {}),
});

// Every day 0..6 (Google convention), open startHour:00-endHour:00.
function dailyHours(startHour: number, endHour: number): FixtureGoogleHours {
  return {
    periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
      open: { day, hour: startHour, minute: 0 },
      close: { day, hour: endHour, minute: 0 },
    })),
  };
}

// Open every day EXCEPT Monday (Google day 1), startHour:00-endHour:00.
function closedMondaysHours(startHour: number, endHour: number): FixtureGoogleHours {
  return {
    periods: [0, 2, 3, 4, 5, 6].map((day) => ({
      open: { day, hour: startHour, minute: 0 },
      close: { day, hour: endHour, minute: 0 },
    })),
  };
}

// Split shift every day: a matinee and an evening slot.
function splitShiftHours(): FixtureGoogleHours {
  return {
    periods: [0, 1, 2, 3, 4, 5, 6].flatMap((day) => [
      { open: { day, hour: 10, minute: 0 }, close: { day, hour: 13, minute: 0 } },
      { open: { day, hour: 19, minute: 0 }, close: { day, hour: 22, minute: 0 } },
    ]),
  };
}

export const FIXTURE_STOPS: FixtureStop[] = [
  // old-town cluster — walkable hops
  s("fx-01", "Market Hall", 51.45, -2.6, 2),
  s("fx-02", "Clock Tower Square", 51.4512, -2.5988, 1),
  // E3: Monday-closed, else 09:00-17:00 — the fixture the plan's own example
  // ("Heads up — Guildhall Museum looks closed on Mondays") is built around.
  s("fx-03", "Guildhall Museum", 51.4491, -2.5979, 1, closedMondaysHours(9, 17)),
  s("fx-04", "Riverside Cafe", 51.4478, -2.6013, 0),
  // harbour cluster
  s("fx-05", "Old Port Aquarium", 51.438, -2.618, 3),
  // E3: open every day 09:00-18:00 — the "visited within hours -> no note" case.
  s("fx-06", "Harbour Fort", 51.4362, -2.6205, 2, dailyHours(9, 18)),
  s("fx-07", "South Beach Boardwalk", 51.433, -2.615, 1),
  // spread
  s("fx-08", "Botanic Conservatory", 51.457, -2.609, 1),
  // E3: split-shift (matinee 10-13, evening 19-22) every day.
  s("fx-09", "Grand Theatre", 51.4525, -2.6045, 2, splitShiftHours()),
  s("fx-10", "Cathedral", 51.4535, -2.596, 1),
  s("fx-11", "Artisan Quarter", 51.4482, -2.5925, 0),
  s("fx-12", "University Quad", 51.461, -2.602, 1),
  s("fx-13", "Northgate Mall", 51.466, -2.595, 4),
  s("fx-14", "City Stadium", 51.47, -2.612, 4),
  s("fx-15", "Observatory Hill", 51.464, -2.623, 2),
  // E3: open every day but closes early (09:00-16:00) — the
  // "closes before you'd arrive" advisory case.
  s("fx-16", "Castle Keep", 51.4445, -2.588, 2, dailyHours(9, 16)),
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
