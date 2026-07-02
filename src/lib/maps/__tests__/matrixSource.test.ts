// P1 done-checks: cache hit never re-fetches; batching correct.
// Exercised against a counting stub fetcher — no adapter, no network.

import { cacheKey, createMatrixSource, type PairFetcher } from "../matrixSource";
import type { MatrixStop } from "../types";

const stop = (id: string, lat: number, lng: number): MatrixStop => ({
  id,
  location: { lat, lng },
});

const STOPS = [stop("a", 0, 0), stop("b", 0, 0.01), stop("c", 0.01, 0), stop("d", 0.01, 0.01)];

// Deterministic fake drive time so assertions are exact.
const fakeMinutes = (fromId: string, toId: string) =>
  fromId.charCodeAt(0) * 10 + toId.charCodeAt(0);

function makeStubFetcher() {
  const calls: { originIds: string[]; destIds: string[] }[] = [];
  const fetchedPairs: string[] = [];
  const fetcher: PairFetcher = async (origins, destinations) => {
    calls.push({ originIds: origins.map((o) => o.id), destIds: destinations.map((d) => d.id) });
    const out = [];
    for (const o of origins) {
      for (const d of destinations) {
        fetchedPairs.push(`${o.id}->${d.id}`);
        out.push({ fromId: o.id, toId: d.id, minutes: fakeMinutes(o.id, d.id) });
      }
    }
    return out;
  };
  return { fetcher, calls, fetchedPairs };
}

describe("matrix cache", () => {
  it("cold call fetches every off-diagonal pair exactly once and fills the matrix", async () => {
    const { fetcher, fetchedPairs } = makeStubFetcher();
    const getMatrix = createMatrixSource(fetcher);
    const m = await getMatrix(STOPS, "driving");

    expect(fetchedPairs.sort()).toEqual(
      STOPS.flatMap((f) => STOPS.filter((t) => t.id !== f.id).map((t) => `${f.id}->${t.id}`)).sort()
    );
    expect(new Set(fetchedPairs).size).toBe(fetchedPairs.length); // no pair fetched twice
    expect(m.a.b).toBe(fakeMinutes("a", "b"));
    expect(m.d.c).toBe(fakeMinutes("d", "c"));
    for (const s of STOPS) expect(m[s.id][s.id]).toBe(0);
  });

  it("warm call NEVER re-fetches — zero fetcher calls on full cache hit", async () => {
    const { fetcher, calls } = makeStubFetcher();
    const cache = new Map<string, number>();
    const getMatrix = createMatrixSource(fetcher, cache);

    await getMatrix(STOPS, "driving");
    const coldCalls = calls.length;
    expect(coldCalls).toBeGreaterThan(0);

    const m2 = await getMatrix(STOPS, "driving");
    expect(calls.length).toBe(coldCalls); // not one more request
    expect(m2.a.b).toBe(fakeMinutes("a", "b"));
  });

  it("adding one stop fetches only the pairs involving it — cached pairs excluded", async () => {
    const { fetcher, fetchedPairs } = makeStubFetcher();
    const cache = new Map<string, number>();
    const getMatrix = createMatrixSource(fetcher, cache);

    await getMatrix(STOPS.slice(0, 3), "driving"); // a, b, c cached
    fetchedPairs.length = 0;

    await getMatrix(STOPS, "driving"); // + d
    expect(fetchedPairs.sort()).toEqual(
      ["a->d", "b->d", "c->d", "d->a", "d->b", "d->c"].sort()
    );
  });

  it("cache key includes mode", () => {
    expect(cacheKey("x", "y", "driving")).toBe("x|y|driving");
  });
});

describe("batching", () => {
  it("uncached destinations for one origin are chunked at 25 per request", async () => {
    const many: MatrixStop[] = [stop("o", 0, 0)];
    for (let i = 0; i < 30; i++) many.push(stop(`d${String(i).padStart(2, "0")}`, 0, i * 0.001));

    const { fetcher, calls } = makeStubFetcher();
    const getMatrix = createMatrixSource(fetcher);
    await getMatrix(many, "driving");

    const oCalls = calls.filter((c) => c.originIds[0] === "o");
    expect(oCalls.length).toBe(2); // 30 destinations -> 25 + 5
    expect(oCalls[0].destIds.length).toBe(25);
    expect(oCalls[1].destIds.length).toBe(5);
  });

  it("requests are batched per origin, not per pair", async () => {
    const { fetcher, calls } = makeStubFetcher();
    const getMatrix = createMatrixSource(fetcher);
    await getMatrix(STOPS, "driving");
    // 4 origins x 3 destinations each -> exactly 4 requests, not 12
    expect(calls.length).toBe(4);
    for (const c of calls) expect(c.destIds.length).toBe(3);
  });
});
