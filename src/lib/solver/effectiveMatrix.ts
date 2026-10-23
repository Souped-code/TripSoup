// Effective matrix construction — §2 (LOCKED).
// Per pair: walk-eligible when local walk estimate <= walkMax. For eligible
// pairs the mode is whichever is faster of walk time vs drive time + overhead;
// ineligible pairs always drive. Schedule math always uses the effective time
// of the active mode: walk = walk estimate, drive = drive + overhead.
//
// Where a transit journey exists (Singapore — the caller passes `transitFor`,
// see src/lib/transit/sg), public transport is the default for any leg too
// far to walk, and a walkable leg is walked. Driving stays on offer as the
// per-leg toggle. Without `transitFor` this file behaves exactly as before.

import type { LatLng, Settings, TravelMatrix } from "../maps/types";
import { isWalkEligible, walkMinutes } from "../maps/walkEstimator";
import type { Journey } from "../transit/sg/router";
import type { EffectiveLeg, EffectiveMatrix, LegMode } from "./types";

export function buildEffectiveLeg(
  driveMin: number,
  walkMin: number,
  settings: Settings,
  transit: Journey | null = null
): EffectiveLeg {
  if (transit) {
    // Walk when it's comfortable OR simply not slower: a 19-min walk beats a
    // 31-min train ride with a change and a long exit walk.
    return isWalkEligible(walkMin, settings) || walkMin <= transit.minutes
      ? { mode: "walk", walkMin, driveMin, transit, chosenBy: "auto" }
      : { mode: "transit", walkMin: null, driveMin, transit, chosenBy: "auto" };
  }
  if (!isWalkEligible(walkMin, settings)) {
    return { mode: "drive", walkMin: null, driveMin, chosenBy: "auto" };
  }
  const mode = walkMin <= driveMin + settings.driveOverheadMin ? "walk" : "drive";
  return { mode, walkMin, driveMin, chosenBy: "auto" };
}

/** Can this leg be travelled by `mode`? Driving always can. */
export function legOffers(leg: EffectiveLeg, mode: LegMode): boolean {
  if (mode === "walk") return leg.walkMin !== null;
  if (mode === "transit") return leg.transit !== undefined;
  return true;
}

export function buildEffectiveMatrix(
  drive: TravelMatrix,
  locations: Record<string, LatLng>,
  settings: Settings,
  transitFor?: (a: LatLng, b: LatLng) => Journey | null
): EffectiveMatrix {
  const matrix: EffectiveMatrix = {};
  for (const fromId of Object.keys(drive)) {
    matrix[fromId] = {};
    for (const toId of Object.keys(drive[fromId])) {
      if (fromId === toId) continue;
      const a = locations[fromId];
      const b = locations[toId];
      matrix[fromId][toId] = buildEffectiveLeg(
        drive[fromId][toId],
        walkMinutes(a, b, settings),
        settings,
        transitFor?.(a, b) ?? null
      );
    }
  }
  return matrix;
}

// The number the schedule walks with — always the active mode's effective time.
export function effectiveMinutes(leg: EffectiveLeg, settings: Settings): number {
  if (leg.mode === "walk") return leg.walkMin!;
  if (leg.mode === "transit") return leg.transit!.minutes;
  return leg.driveMin + settings.driveOverheadMin;
}
