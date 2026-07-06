// D2.3 M2a: route geometry service. Exercised ONLY with a stubbed fetcher and
// a stubbed cache — never a real key, never network. See the file's own
// header for the fail-open philosophy (opposite of kvMatrixCache, which
// throws to protect billed matrix data): here every failure path resolves to
// null and the test suite proves exactly that, leg by leg.

import {
  createRouteGeometrySource,
  simplifyLine,
  type RouteGeometryCache,
} from "../routeGeometry";

// Cost guard: this MUST be undefined in the jest env. createRouteGeometrySource
// falls back to process.env.AWS_LOCATION_API_KEY whenever a test doesn't
// inject its own `apiKey`, so if a real key ever leaked into this process the
// "no key" tests below would silently start hitting real AWS. Every test that
// needs a "key present" branch injects a fake apiKey via deps instead of
// touching this env var — see the extended guard in adapterGuard.test.ts,
// which bans any test file from assigning to it.
it("cost guard: no AWS key is present in the jest environment", () => {
  expect(process.env.AWS_LOCATION_API_KEY).toBeUndefined();
});

type MinimalResponse = { ok: boolean; status?: number; json(): Promise<unknown> };

function awsOk(lineString: Array<[number, number]>): MinimalResponse {
  return {
    ok: true,
    json: async () => ({ Routes: [{ Legs: [{ Geometry: { LineString: lineString } }] }] }),
  };
}

function makeStubFetcher(
  handler: (url: string, body: { Origin: number[]; Destination: number[] }) => Promise<MinimalResponse> | MinimalResponse
) {
  const calls: Array<{ url: string; body: { Origin: number[]; Destination: number[] } }> = [];
  const fetcher = async (url: string, init: RequestInit): Promise<MinimalResponse> => {
    const body = JSON.parse(init.body as string) as { Origin: number[]; Destination: number[] };
    calls.push({ url, body });
    return handler(url, body);
  };
  return { fetcher, calls };
}

function makeEmptyStubCache(): RouteGeometryCache {
  return {
    async getMany() {
      return {};
    },
    async setMany() {
      /* no-op */
    },
  };
}

// A cache whose getMany answers "hit" for exactly the FIRST key it is asked
// about (whatever string that turns out to be) and "miss" for every other —
// lets tests exercise "one leg is cached, one is not" without needing to
// reproduce the service's internal cache-key format.
function makeFirstKeyHitCache(hitLine: Array<[number, number]>) {
  const getManyCalls: string[][] = [];
  const setManyCalls: Array<Array<{ key: string; line: Array<[number, number]> }>> = [];
  const cache: RouteGeometryCache = {
    async getMany(keys) {
      getManyCalls.push(keys);
      return keys.length > 0 ? { [keys[0]]: hitLine } : {};
    },
    async setMany(entries) {
      setManyCalls.push(entries);
    },
  };
  return { cache, getManyCalls, setManyCalls };
}

const pair = (a: [number, number], b: [number, number]) => ({
  from: { lat: a[0], lng: a[1] },
  to: { lat: b[0], lng: b[1] },
});

describe("no AWS key", () => {
  it("resolves every leg to null and never calls the fetcher", async () => {
    const calls: unknown[] = [];
    const fetcher = async (): Promise<MinimalResponse> => {
      calls.push(true);
      throw new Error("fetcher must never be called without a key");
    };
    const source = createRouteGeometrySource({ fetcher, cache: makeEmptyStubCache() });

    const result = await source.getLegGeometries([
      pair([1.3, 103.8], [1.31, 103.81]),
      pair([1.32, 103.82], [1.33, 103.83]),
    ]);

    expect(result).toEqual([null, null]);
    expect(calls.length).toBe(0);
  });
});

describe("happy path", () => {
  it("parses the documented AWS shape, dedupes the shared joint, and simplifies", async () => {
    // Two legs sharing a joint point at [2,0]; all five points are collinear
    // (constant y=0) so Douglas-Peucker provably collapses the interior
    // points, leaving only the endpoints.
    const { fetcher } = makeStubFetcher(() => ({
      ok: true,
      json: async () => ({
        Routes: [
          {
            Legs: [
              { Geometry: { LineString: [[0, 0], [1, 0], [2, 0]] } },
              { Geometry: { LineString: [[2, 0], [3, 0], [4, 0]] } },
            ],
          },
        ],
      }),
    }));
    const source = createRouteGeometrySource({ fetcher, cache: makeEmptyStubCache(), apiKey: "test-key" });

    const result = await source.getLegGeometries([pair([1.3, 103.8], [1.31, 103.81])]);

    expect(result).toEqual([[[0, 0], [4, 0]]]);
  });
});

describe("cache", () => {
  it("a cache hit skips the fetcher for that leg; setMany runs only for the fresh fetch", async () => {
    const hitLine: Array<[number, number]> = [[10, 20], [11, 21]];
    const { cache, getManyCalls, setManyCalls } = makeFirstKeyHitCache(hitLine);
    const freshLineString: Array<[number, number]> = [[0, 0], [1, 0], [2, 0]];
    const { fetcher, calls } = makeStubFetcher(() => awsOk(freshLineString));

    const source = createRouteGeometrySource({ fetcher, cache, apiKey: "test-key" });
    const result = await source.getLegGeometries([
      pair([1, 1], [2, 2]), // this becomes keys[0] -> the cache hit
      pair([3, 3], [4, 4]), // this is the fresh fetch
    ]);

    expect(result[0]).toEqual(hitLine); // served straight from cache, not re-simplified
    expect(result[1]).toEqual([[0, 0], [2, 0]]); // fetched + simplified
    expect(calls.length).toBe(1); // fetcher only called for the miss
    expect(getManyCalls.length).toBe(1); // one bulk getMany for the whole batch
    expect(setManyCalls.length).toBe(1);
    expect(setManyCalls[0].length).toBe(1); // only the fresh leg written, not the hit
  });

  it("a throwing cache is treated as a miss and never propagates", async () => {
    const throwingCache: RouteGeometryCache = {
      async getMany(): Promise<Record<string, Array<[number, number]>>> {
        throw new Error("KV is down");
      },
      async setMany(): Promise<void> {
        throw new Error("KV is down");
      },
    };
    const { fetcher, calls } = makeStubFetcher(() => awsOk([[0, 0], [1, 0], [2, 0]]));
    const source = createRouteGeometrySource({ fetcher, cache: throwingCache, apiKey: "test-key" });

    const result = await source.getLegGeometries([pair([1, 1], [2, 2])]);

    expect(result).toEqual([[[0, 0], [2, 0]]]); // getMany threw -> miss -> fetch proceeded
    expect(calls.length).toBe(1);
    // setMany's throw (fresh result IS cacheable) must not have propagated —
    // reaching this line at all is the proof; nothing more to assert.
  });
});

describe("AWS failures", () => {
  it("a 4xx response or a thrown fetch resolves only that leg to null; siblings still resolve", async () => {
    const { fetcher, calls } = makeStubFetcher((_url, body) => {
      const originLat = body.Origin[1]; // Origin is [lng, lat]
      if (originLat === 1) return { ok: false, status: 400, json: async () => ({}) };
      if (originLat === 3) throw new Error("network blip");
      return awsOk([[0, 0], [1, 0], [2, 0]]);
    });
    const source = createRouteGeometrySource({ fetcher, cache: makeEmptyStubCache(), apiKey: "test-key" });

    const result = await source.getLegGeometries([
      pair([1, 101], [2, 102]), // AWS 400
      pair([3, 103], [4, 104]), // fetch throws
      pair([5, 105], [6, 106]), // succeeds
    ]);

    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toEqual([[0, 0], [2, 0]]);
    expect(calls.length).toBe(3); // all three were attempted despite two failing
  });
});

describe("simplifyLine", () => {
  it("collapses exactly collinear points to just the two endpoints", () => {
    const line: Array<[number, number]> = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
    expect(simplifyLine(line, 0.00035)).toEqual([[0, 0], [4, 0]]);
  });

  it("respects tolerance — drops a deviation within it, keeps one beyond it", () => {
    const withinTolerance: Array<[number, number]> = [[0, 0], [1, 0.0001], [2, 0]];
    expect(simplifyLine(withinTolerance, 0.00035)).toEqual([[0, 0], [2, 0]]);

    const beyondTolerance: Array<[number, number]> = [[0, 0], [1, 0.001], [2, 0]];
    expect(simplifyLine(beyondTolerance, 0.00035)).toEqual([[0, 0], [1, 0.001], [2, 0]]);
  });

  it("caps output at maxPoints while always keeping the first and last point", () => {
    const zigzag: Array<[number, number]> = [];
    for (let i = 0; i <= 20; i++) zigzag.push([i, i % 2 === 0 ? 0 : 5]); // sharp zigzag
    // tolerance 0 keeps every point DP would otherwise consider significant,
    // isolating the cap logic from the simplification logic.
    const result = simplifyLine(zigzag, 0, 5);

    expect(result.length).toBeLessThanOrEqual(5);
    expect(result[0]).toEqual(zigzag[0]);
    expect(result[result.length - 1]).toEqual(zigzag[zigzag.length - 1]);
  });
});
