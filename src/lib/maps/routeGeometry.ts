// Route geometry service — turns consecutive trip-stop pairs into simplified
// road-following polylines via Amazon Location Service geo-routes v2 (GrabMaps
// data, ap-southeast-1), so the reveal map's pen line can follow real roads.
//
// FAILURE PHILOSOPHY — the exact OPPOSITE of kvMatrixCache.ts. That cache
// THROWS on any KV error because a swallowed failure there would silently
// re-fetch (and re-bill) matrix pairs — the failure has to be loud so it can
// never masquerade as a cache hit (§3, billed-data protection). This service
// is DECORATIVE: the reveal map already draws a hand-sketched pen line as its
// baseline, so a road polyline is a nice-to-have, never a requirement. Every
// failure path here — no API key, HTTP error, malformed AWS response, thrown
// fetch, a throwing cache — resolves that ONE leg to `null` and moves on.
// Nothing in this module ever throws out of `getLegGeometries`; a failure
// must never block a reveal. (The KV cache below still borrows kvMatrixCache's
// wire protocol verbatim — same MGET/MSET pipeline calls — it just isn't
// trusted to fail loudly here; see createKvGeoCache's comment.)
//
// Cost posture mirrors the maps/parse "no key -> safe no-op" convention
// (config.ts's fixture fallback, llmAdapter's construction throw): dev, jest,
// and Playwright have no AWS_LOCATION_API_KEY and must spend nothing — that
// is checked FIRST, before any cache or network call.

export type GeoPoint = { lat: number; lng: number };

// [lng, lat] pairs (matches AWS's coordinate order), or null when this leg
// could not be resolved for any reason — the map falls back to its
// hand-sketched line for that leg.
export type LegLine = Array<[number, number]> | null;

// Minimal shape we actually read off a fetch Response — lets tests hand back
// a plain object instead of constructing a real Response (same spirit as
// matrixSource.ts's bespoke PairFetcher rather than reusing a platform type).
type MinimalResponse = {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
};
type Fetcher = (url: string, init: RequestInit) => Promise<MinimalResponse>;

export type RouteGeometryCache = {
  getMany(keys: string[]): Promise<Record<string, Array<[number, number]>>>;
  setMany(entries: Array<{ key: string; line: Array<[number, number]> }>): Promise<void>;
};

export type RouteGeometryDeps = {
  fetcher?: Fetcher;
  cache?: RouteGeometryCache;
  apiKey?: string;
  region?: string;
};

export type RouteGeometrySource = {
  getLegGeometries(
    pairs: Array<{ from: GeoPoint; to: GeoPoint }>,
    mode?: "car"
  ): Promise<LegLine[]>;
};

const DEFAULT_REGION = "ap-southeast-1";
const MAX_CONCURRENT_FETCHES = 4; // a 15-stop day = 14 legs — don't burst
const SIMPLIFY_TOLERANCE_DEG = 0.00035; // Douglas-Peucker tolerance, ≈ 39 m
const MAX_POINTS_PER_LEG = 80;

// ---------------------------------------------------------------------------
// Douglas-Peucker simplification — pure, exported for tests.
// ---------------------------------------------------------------------------

function perpendicularDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  const t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return Math.hypot(px - projX, py - projY);
}

// Evenly-spaced index sampling rather than a fixed "every Nth point" walk —
// a fixed stride can overshoot the cap by one once you force-keep the last
// point (off-by-one at the boundary), whereas sampling `maxPoints` positions
// across the full span guarantees the result never exceeds maxPoints while
// still always keeping the first and last point.
function capPoints(
  points: Array<[number, number]>,
  maxPoints: number
): Array<[number, number]> {
  if (points.length <= maxPoints || maxPoints < 2) return points;
  const lastIdx = points.length - 1;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.round((i * lastIdx) / (maxPoints - 1))]);
  }
  return out;
}

// Iterative (stack-based, not recursive) Douglas-Peucker over [x,y] pairs —
// no projection, plain-degree distances, which is fine at the sub-100m
// tolerances used here. Iterative so a long AWS polyline can't run us into a
// recursion-depth concern. Then capped at maxPoints (always keeping the
// first/last point) so a long drive never ships an oversized overlay.
export function simplifyLine(
  points: Array<[number, number]>,
  tolerance: number,
  maxPoints: number = MAX_POINTS_PER_LEG
): Array<[number, number]> {
  if (points.length <= 2) return capPoints(points, maxPoints);

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end <= start + 1) continue;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist > tolerance) {
      keep[maxIdx] = true;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }

  const reduced = points.filter((_, i) => keep[i]);
  return capPoints(reduced, maxPoints);
}

// ---------------------------------------------------------------------------
// Cache — bulk async getMany/setMany, same shape as matrixSource's MatrixCache.
// ---------------------------------------------------------------------------

// Module-scope shared backing store: even though createRouteGeometrySource()
// is called fresh per request (house convention, like getMapsProvider()),
// the in-memory cache it builds when there is no KV env closes over THIS map,
// so a warm dev/test process still gets warm repeats.
const inMemoryStore = new Map<string, Array<[number, number]>>();

function createInMemoryCache(): RouteGeometryCache {
  return {
    async getMany(keys) {
      const out: Record<string, Array<[number, number]>> = {};
      for (const k of keys) {
        const v = inMemoryStore.get(k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    },
    async setMany(entries) {
      for (const { key, line } of entries) inMemoryStore.set(key, line);
    },
  };
}

// KV-backed cache — same Upstash REST /pipeline wire protocol as
// kvMatrixCache.ts (MGET/MSET command arrays, POST {url}/pipeline, Bearer
// auth) reusing the same KV_REST_API_URL / KV_REST_API_TOKEN env vars. The
// mechanics are identical; the CONTRACT is inverted. kvMatrixCache throws on
// any KV error so a caller can never silently re-fetch (and re-bill) a
// matrix pair. This function is allowed to throw the same way — that keeps
// the two implementations easy to compare side by side — but every call site
// in getLegGeometries wraps it in try/catch and treats a throw as a plain
// cache miss. A KV outage must never block a decorative overlay.
function createKvGeoCache(url: string, token: string): RouteGeometryCache {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  return {
    async getMany(keys) {
      if (keys.length === 0) return {};
      const res = await fetch(`${url}/pipeline`, {
        method: "POST",
        headers,
        body: JSON.stringify([["MGET", ...keys]]),
      });
      if (!res.ok) throw new Error(`KV getMany failed: ${res.status}`);
      const [{ result: values }] = (await res.json()) as [{ result: (string | null)[] }];
      const out: Record<string, Array<[number, number]>> = {};
      for (let i = 0; i < keys.length; i++) {
        const raw = values[i];
        if (raw == null) continue;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) out[keys[i]] = parsed;
      }
      return out;
    },
    async setMany(entries) {
      if (entries.length === 0) return;
      const kv: string[] = [];
      for (const { key, line } of entries) kv.push(key, JSON.stringify(line));
      const res = await fetch(`${url}/pipeline`, {
        method: "POST",
        headers,
        body: JSON.stringify([["MSET", ...kv]]),
      });
      if (!res.ok) throw new Error(`KV setMany failed: ${res.status}`);
    },
  };
}

function resolveDefaultCache(): RouteGeometryCache {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (url && token) return createKvGeoCache(url, token);
  return createInMemoryCache(); // no KV env -> in-memory Map so dev gets warm repeats
}

// Namespaced, coordinate-rounded cache key. Rounding to 5 decimals (~1.1m)
// means two requests for "the same" leg always collide on the same key even
// if the caller's floats carry more noise than that.
function legCacheKey(mode: string, from: GeoPoint, to: GeoPoint): string {
  const round = (n: number) => n.toFixed(5);
  return `geo:v1:${mode}:${round(from.lat)},${round(from.lng)}:${round(to.lat)},${round(to.lng)}`;
}

// ---------------------------------------------------------------------------
// AWS geo-routes v2 call + defensive parsing.
// ---------------------------------------------------------------------------

// LIVE-SHAPE NOTE: the field names below (Routes[].Legs[].Geometry.LineString)
// are our best reading of the geo-routes v2 request/response shape —
// UNVERIFIED against a real call. Confirm at the CHRIS-STEP (AWS Location key
// creation) and correct this function if the live shape differs. Until then,
// every `.` access is guarded so a wrong guess degrades to "no geometry for
// this leg" instead of a crash.
function extractLineString(data: unknown): Array<[number, number]> | null {
  if (typeof data !== "object" || data === null) return null;
  const routes = (data as { Routes?: unknown }).Routes;
  if (!Array.isArray(routes) || routes.length === 0) return null;

  const firstRoute = routes[0];
  if (typeof firstRoute !== "object" || firstRoute === null) return null;
  const legs = (firstRoute as { Legs?: unknown }).Legs;
  if (!Array.isArray(legs) || legs.length === 0) return null;

  const combined: Array<[number, number]> = [];
  for (const leg of legs) {
    if (typeof leg !== "object" || leg === null) return null;
    const geometry = (leg as { Geometry?: unknown }).Geometry;
    if (typeof geometry !== "object" || geometry === null) return null;
    const lineString = (geometry as { LineString?: unknown }).LineString;
    if (!Array.isArray(lineString) || lineString.length === 0) return null;

    for (const rawPoint of lineString) {
      if (
        !Array.isArray(rawPoint) ||
        rawPoint.length < 2 ||
        typeof rawPoint[0] !== "number" ||
        typeof rawPoint[1] !== "number"
      ) {
        return null;
      }
      const point: [number, number] = [rawPoint[0], rawPoint[1]];
      const prev = combined[combined.length - 1];
      if (prev && prev[0] === point[0] && prev[1] === point[1]) continue; // dedupe shared joint
      combined.push(point);
    }
  }
  return combined.length > 0 ? combined : null;
}

async function fetchLegGeometry(
  fetcher: Fetcher,
  apiKey: string,
  region: string,
  from: GeoPoint,
  to: GeoPoint
): Promise<Array<[number, number]> | null> {
  try {
    const res = await fetcher(
      `https://routes.geo.${region}.amazonaws.com/v2/routes?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Origin: [from.lng, from.lat],
          Destination: [to.lng, to.lat],
          TravelMode: "Car",
          LegGeometryFormat: "Simple",
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return extractLineString(data);
  } catch {
    return null; // fetch threw (network/DNS/timeout) — this leg is null, nothing else
  }
}

// Simple worker-pool semaphore — caps in-flight AWS calls without a new
// dependency. `limit` workers each pull the next queue index until it is
// drained; still fundamentally one Promise.all underneath. `fn` must never
// reject (fetchLegGeometry guarantees this) — a rejection here would sink
// every other in-flight leg via Promise.all.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Public factory.
// ---------------------------------------------------------------------------

export function createRouteGeometrySource(deps?: RouteGeometryDeps): RouteGeometrySource {
  const fetcher = deps?.fetcher ?? (fetch as Fetcher);
  const apiKey = deps?.apiKey ?? process.env.AWS_LOCATION_API_KEY;
  const region = deps?.region ?? process.env.AWS_LOCATION_REGION ?? DEFAULT_REGION;
  const cache = deps?.cache ?? resolveDefaultCache();

  return {
    async getLegGeometries(pairs, mode = "car") {
      // Cost rule (file header): no key, zero fetches, zero cache calls —
      // dev/jest/Playwright must be able to spend nothing, always.
      if (!apiKey) return pairs.map(() => null);

      try {
        const keys = pairs.map((p) => legCacheKey(mode, p.from, p.to));

        let cached: Record<string, Array<[number, number]>> = {};
        try {
          cached = await cache.getMany(keys);
        } catch {
          cached = {}; // fail open — any cache error is just a full miss
        }

        const results: LegLine[] = keys.map((k) => cached[k] ?? null);
        const missingIdx: number[] = [];
        for (let i = 0; i < keys.length; i++) {
          if (results[i] === null) missingIdx.push(i);
        }

        const fetchedLines = await mapWithConcurrency(
          missingIdx,
          MAX_CONCURRENT_FETCHES,
          async (i) => {
            const raw = await fetchLegGeometry(fetcher, apiKey, region, pairs[i].from, pairs[i].to);
            return raw ? simplifyLine(raw, SIMPLIFY_TOLERANCE_DEG) : null;
          }
        );

        const freshEntries: Array<{ key: string; line: Array<[number, number]> }> = [];
        missingIdx.forEach((i, j) => {
          const line = fetchedLines[j];
          results[i] = line;
          if (line) freshEntries.push({ key: keys[i], line }); // never negative-cache nulls
        });

        if (freshEntries.length > 0) {
          try {
            await cache.setMany(freshEntries);
          } catch {
            /* fail open — a cache write failure must never block the response */
          }
        }

        return results;
      } catch {
        // Absolute backstop — every other path already fails to null, but
        // this service must NEVER throw into the page, full stop.
        return pairs.map(() => null);
      }
    },
  };
}
