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

// Async bulk interface so REST-backed implementations (KV, Supabase) can
// batch in one round-trip rather than N serial get() calls.
export type MatrixCache = {
  getMany(keys: string[]): Promise<Record<string, number>>;
  setMany(entries: { key: string; minutes: number }[]): Promise<void>;
};

export const cacheKey = (fromId: string, toId: string, mode: TravelMode): string =>
  `${fromId}|${toId}|${mode}`;

// In-memory MatrixCache backed by a plain Map. Exported as the default for
// tests and callers that do not need persistence.
export function createMapMatrixCache(map: Map<string, number> = new Map()): MatrixCache {
  return {
    async getMany(keys) {
      const out: Record<string, number> = {};
      for (const k of keys) {
        const v = map.get(k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    },
    async setMany(entries) {
      for (const { key, minutes } of entries) {
        map.set(key, minutes);
      }
    },
  };
}

// Max destinations per request — keeps each request within API element limits.
const MAX_DESTINATIONS_PER_REQUEST = 25;

// Cache-first matrix assembly. Cached pairs are NEVER included in any fetch
// (§3: never re-fetched on cache hit). Uncached pairs are grouped per origin
// and fetched in batched destination chunks.
export function createMatrixSource(
  fetcher: PairFetcher,
  cache: MatrixCache = createMapMatrixCache()
) {
  return async function getTravelMatrix(
    stops: MatrixStop[],
    mode: TravelMode
  ): Promise<TravelMatrix> {
    const matrix: TravelMatrix = {};
    const byId = new Map(stops.map((s) => [s.id, s]));

    // One bulk read of every off-diagonal key up front — a later phase's
    // retry-resume-from-cache guarantee requires all prior writes to be visible
    // before we decide what is missing.
    const allKeys: string[] = [];
    for (const from of stops) {
      for (const to of stops) {
        if (from.id !== to.id) allKeys.push(cacheKey(from.id, to.id, mode));
      }
    }
    const cachedRecord = await cache.getMany(allKeys);

    const missing = new Map<string, string[]>(); // originId -> uncached destIds
    for (const from of stops) {
      matrix[from.id] = {};
      for (const to of stops) {
        if (from.id === to.id) {
          matrix[from.id][to.id] = 0;
          continue;
        }
        const key = cacheKey(from.id, to.id, mode);
        if (key in cachedRecord) {
          matrix[from.id][to.id] = cachedRecord[key];
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
        // Cache after each per-origin batch so a retry resumes from partial
        // progress rather than re-fetching pairs already paid for (§3).
        const batchEntries: { key: string; minutes: number }[] = [];
        for (const r of results) {
          const key = cacheKey(r.fromId, r.toId, mode);
          batchEntries.push({ key, minutes: r.minutes });
          matrix[r.fromId][r.toId] = r.minutes;
        }
        await cache.setMany(batchEntries);
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
