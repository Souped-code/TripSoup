// The mapsProvider port — handover §3 (LOCKED).
// The resolution half is adapted TO the Phase 0 spike's shape: same signature,
// same ResolveResult, types imported from the spike module unmodified.

import type { ResolveResult } from "../../../resolvePlaces";

export type LatLng = { lat: number; lng: number };

// The port keeps a mode parameter because the API has one; v1 requests driving
// exclusively (§3). Walking times never come from the API — see walkEstimator.
export type TravelMode = "driving";

export type MatrixStop = { id: string; location: LatLng };

/** E6d — reserved matrix-id PREFIX for the trip's home base (TripDoc.homeBase).
 * A real Google place_id can never collide with it, and using a reserved key
 * (rather than the base's own place id alone) keeps "staying AT a visited
 * place" unambiguous in every matrix lookup. */
export const HOME_BASE_KEY = "__home-base__";

/** The base's MATRIX identity: prefix + the base's own place id. The audit's
 * blocking finding: matrixSource caches pairs by `${fromId}|${toId}|${mode}`
 * in a PERSISTENT, deployment-shared cache — a bare reserved id would serve
 * the OLD base's minutes forever after a base change, and cross-contaminate
 * trips whose bases differ. The place id in the key makes cache identity
 * follow base identity. */
export function homeBaseMatrixId(homeBaseId: string): string {
  return `${HOME_BASE_KEY}:${homeBaseId}`;
}

export function isHomeBaseMatrixId(id: string): boolean {
  return id.startsWith(HOME_BASE_KEY);
}

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
