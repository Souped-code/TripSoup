// The mapsProvider port — handover §3 (LOCKED).
// The resolution half is adapted TO the Phase 0 spike's shape: same signature,
// same ResolveResult, types imported from the spike module unmodified.

import type { ResolveResult } from "../../../resolvePlaces";

export type LatLng = { lat: number; lng: number };

// The port keeps a mode parameter because the API has one; v1 requests driving
// exclusively (§3). Walking times never come from the API — see walkEstimator.
export type TravelMode = "driving";

export type MatrixStop = { id: string; location: LatLng };

// Minutes from -> to. Diagonal entries are 0.
export type TravelMatrix = Record<string, Record<string, number>>;

export interface MapsProvider {
  resolvePlaces(inputs: string[]): Promise<ResolveResult>;
  getTravelMatrix(stops: MatrixStop[], mode: TravelMode): Promise<TravelMatrix>;
}

// User-facing and solver settings — §2/§3. The 9/15 thresholds are settings
// values; the behaviours at each are spec (§7).
export type Settings = {
  walkMax: number; // min — walk-eligibility comfort threshold
  driveOverheadMin: number; // hail/load/park cost added to raw drive times
  detourFactor: number; // straight-line -> street-network fudge
  walkSpeedMPerMin: number;
  maxExhaustive: number; // <= this many flexible stops: permutation search
  maxHeuristic: number; // <= this many: NN + 2-opt, labelled heuristic
};

export const DEFAULT_SETTINGS: Settings = {
  walkMax: 10,
  driveOverheadMin: 10,
  detourFactor: 1.3,
  walkSpeedMPerMin: 80,
  maxExhaustive: 9,
  maxHeuristic: 15,
};
