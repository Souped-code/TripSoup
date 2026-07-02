// P1 done-check: fixture matrix sane (triangle inequality spot checks) +
// fixture resolution behaviour the later phases depend on.

import { createFixtureAdapter } from "../fixtureAdapter";
import { FIXTURE_STOPS, fixtureDriveMinutes } from "../fixtureCity";
import { walkMinutes } from "../walkEstimator";
import { DEFAULT_SETTINGS } from "../types";

const adapter = createFixtureAdapter();

describe("fixture city data", () => {
  it("has ~20 stops with unique ids", () => {
    expect(FIXTURE_STOPS.length).toBe(20);
    expect(new Set(FIXTURE_STOPS.map((s) => s.id)).size).toBe(20);
  });

  it("triangle inequality holds across ALL stop triples", () => {
    // Guaranteed by construction (metric formula + ceil); verify exhaustively
    // anyway — 20^3 = 8000 checks, instant, and this is the done-check.
    for (const a of FIXTURE_STOPS)
      for (const b of FIXTURE_STOPS)
        for (const c of FIXTURE_STOPS) {
          expect(fixtureDriveMinutes(a, c)).toBeLessThanOrEqual(
            fixtureDriveMinutes(a, b) + fixtureDriveMinutes(b, c)
          );
        }
  });

  it("diagonal is zero, off-diagonal is positive", () => {
    for (const a of FIXTURE_STOPS) {
      expect(fixtureDriveMinutes(a, a)).toBe(0);
      for (const b of FIXTURE_STOPS)
        if (a.id !== b.id) expect(fixtureDriveMinutes(a, b)).toBeGreaterThan(0);
    }
  });

  it("old-town cluster hops are walk-eligible; cross-town hops are not", () => {
    const byId = new Map(FIXTURE_STOPS.map((s) => [s.id, s]));
    const walk = (x: string, y: string) =>
      walkMinutes(byId.get(x)!.location, byId.get(y)!.location, DEFAULT_SETTINGS);
    expect(walk("fx-01", "fx-02")).toBeLessThanOrEqual(DEFAULT_SETTINGS.walkMax);
    expect(walk("fx-01", "fx-03")).toBeLessThanOrEqual(DEFAULT_SETTINGS.walkMax);
    expect(walk("fx-01", "fx-14")).toBeGreaterThan(DEFAULT_SETTINGS.walkMax);
    expect(walk("fx-05", "fx-13")).toBeGreaterThan(DEFAULT_SETTINGS.walkMax);
  });
});

describe("fixture adapter", () => {
  it("resolves by id, by name, and by name with city suffix", async () => {
    const { stops, failures } = await adapter.resolvePlaces([
      "fx-07",
      "Market Hall",
      "guildhall museum, Casterbridge",
    ]);
    expect(failures).toEqual([]);
    expect(stops.map((s) => s.id)).toEqual(["fx-07", "fx-01", "fx-03"]);
    expect(stops[0].source).toBe("fx-07");
  });

  it("unknown inputs land in failures with a reason — never dropped", async () => {
    const { stops, failures } = await adapter.resolvePlaces(["Nonexistent Palace", "fx-01"]);
    expect(stops.map((s) => s.id)).toEqual(["fx-01"]);
    expect(failures).toEqual([
      { source: "Nonexistent Palace", reason: "no match in fixture city" },
    ]);
  });

  it("getTravelMatrix returns the fixture formula times", async () => {
    const three = FIXTURE_STOPS.slice(0, 3).map((s) => ({ id: s.id, location: s.location }));
    const m = await adapter.getTravelMatrix(three, "driving");
    expect(m["fx-01"]["fx-02"]).toBe(fixtureDriveMinutes(FIXTURE_STOPS[0], FIXTURE_STOPS[1]));
    expect(m["fx-01"]["fx-01"]).toBe(0);
  });
});
