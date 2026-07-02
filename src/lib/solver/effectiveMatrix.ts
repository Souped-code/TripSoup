// Effective matrix construction — §2 (LOCKED).
// Per pair: walk-eligible when local walk estimate <= walkMax. For eligible
// pairs the mode is whichever is faster of walk time vs drive time + overhead;
// ineligible pairs always drive. Schedule math always uses the effective time
// of the active mode: walk = walk estimate, drive = drive + overhead.

import type { LatLng, Settings, TravelMatrix } from "../maps/types";
import { isWalkEligible, walkMinutes } from "../maps/walkEstimator";
import type { EffectiveLeg, EffectiveMatrix } from "./types";

export function buildEffectiveLeg(
  driveMin: number,
  walkMin: number,
  settings: Settings
): EffectiveLeg {
  if (!isWalkEligible(walkMin, settings)) {
    return { mode: "drive", walkMin: null, driveMin, chosenBy: "auto" };
  }
  const mode = walkMin <= driveMin + settings.driveOverheadMin ? "walk" : "drive";
  return { mode, walkMin, driveMin, chosenBy: "auto" };
}

export function buildEffectiveMatrix(
  drive: TravelMatrix,
  locations: Record<string, LatLng>,
  settings: Settings
): EffectiveMatrix {
  const matrix: EffectiveMatrix = {};
  for (const fromId of Object.keys(drive)) {
    matrix[fromId] = {};
    for (const toId of Object.keys(drive[fromId])) {
      if (fromId === toId) continue;
      matrix[fromId][toId] = buildEffectiveLeg(
        drive[fromId][toId],
        walkMinutes(locations[fromId], locations[toId], settings),
        settings
      );
    }
  }
  return matrix;
}

// The number the schedule walks with — always the active mode's effective time.
export function effectiveMinutes(leg: EffectiveLeg, settings: Settings): number {
  return leg.mode === "walk" ? leg.walkMin! : leg.driveMin + settings.driveOverheadMin;
}
