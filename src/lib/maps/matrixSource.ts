// Matrix cache + batching orchestration — §3 cost control (LOCKED, spec not
// optimization). Standalone so it is testable with a stub fetcher; the real
// adapter wires the Routes API into `fetcher`. Tests never touch an adapter here.

import type { MatrixStop, TravelMatrix, TravelMode } from "./types";

// Fetches drive times for the cross product origins x destinations
// (that is the shape the Routes API serves). Returns one entry per pair.
export type PairFetcher = (
  origins: MatrixStop[],
  destinations: MatrixStop[],
  mode: TravelMode
) => Promise<{ fromId: string; toId: string; minutes: number }[]>;

export type MatrixCache = {
  get(key: string): number | undefined;
  set(key: string, minutes: number): void;
};

export const cacheKey = (fromId: string, toId: string, mode: TravelMode): string =>
  `${fromId}|${toId}|${mode}`;

// Max destinations per request — keeps each request within API element limits.
const MAX_DESTINATIONS_PER_REQUEST = 25;

// Cache-first matrix assembly. Cached pairs are NEVER included in any fetch
// (§3: never re-fetched on cache hit). Uncached pairs are grouped per origin
// and fetched in batched destination chunks.
export function createMatrixSource(fetcher: PairFetcher, cache: MatrixCache = new Map()) {
  return async function getTravelMatrix(
    stops: MatrixStop[],
    mode: TravelMode
  ): Promise<TravelMatrix> {
    const matrix: TravelMatrix = {};
    const byId = new Map(stops.map((s) => [s.id, s]));
    const missing = new Map<string, string[]>(); // originId -> uncached destIds

    for (const from of stops) {
      matrix[from.id] = {};
      for (const to of stops) {
        if (from.id === to.id) {
          matrix[from.id][to.id] = 0;
          continue;
        }
        const cached = cache.get(cacheKey(from.id, to.id, mode));
        if (cached !== undefined) {
          matrix[from.id][to.id] = cached;
        } else {
          const list = missing.get(from.id) ?? [];
          list.push(to.id);
          missing.set(from.id, list);
        }
      }
    }

    for (const [originId, destIds] of missing) {
      const origin = byId.get(originId)!;
      for (let i = 0; i < destIds.length; i += MAX_DESTINATIONS_PER_REQUEST) {
        const chunk = destIds.slice(i, i + MAX_DESTINATIONS_PER_REQUEST);
        const results = await fetcher(
          [origin],
          chunk.map((id) => byId.get(id)!),
          mode
        );
        for (const r of results) {
          cache.set(cacheKey(r.fromId, r.toId, mode), r.minutes);
          matrix[r.fromId][r.toId] = r.minutes;
        }
      }
    }

    // Boundary validation (§8): a fetcher that fails to cover its pairs is a
    // Google-API-shaped problem, surface it rather than emit a holey matrix.
    for (const from of stops) {
      for (const to of stops) {
        if (matrix[from.id][to.id] === undefined) {
          throw new Error(`matrix fetch left pair unresolved: ${from.id} -> ${to.id}`);
        }
      }
    }
    return matrix;
  };
}
