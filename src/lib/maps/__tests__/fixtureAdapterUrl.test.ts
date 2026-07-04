// D2.2 backend spine: fixture adapter now accepts pasted Maps-style URLs, not
// just bare names/ids — this exercises the real "URL -> extracted name ->
// resolved stop" path in fixture mode. Uses the real Casterbridge fixture
// data (fixtureCity.ts): fx-01 "Market Hall", fx-02 "Clock Tower Square".

import { createFixtureAdapter } from "../fixtureAdapter";

const adapter = createFixtureAdapter();

describe("fixture adapter URL extraction", () => {
  it("resolves a ?q= style Maps URL to the matching fixture stop", async () => {
    const { stops, failures } = await adapter.resolvePlaces([
      "https://maps.google.com/?q=Market+Hall",
    ]);
    expect(failures).toEqual([]);
    expect(stops.map((s) => s.id)).toEqual(["fx-01"]);
    expect(stops[0].source).toBe("https://maps.google.com/?q=Market+Hall");
  });

  it("resolves a /maps/place/<name> style Maps URL to the matching fixture stop", async () => {
    const { stops, failures } = await adapter.resolvePlaces([
      "https://www.google.com/maps/place/Clock+Tower+Square/@51.4512,-2.5988,17z",
    ]);
    expect(failures).toEqual([]);
    expect(stops.map((s) => s.id)).toEqual(["fx-02"]);
  });

  it("still matches a bare name (no regression from before URL support)", async () => {
    const { stops, failures } = await adapter.resolvePlaces(["Market Hall"]);
    expect(failures).toEqual([]);
    expect(stops.map((s) => s.id)).toEqual(["fx-01"]);
  });

  it("still matches a bare id (no regression)", async () => {
    const { stops, failures } = await adapter.resolvePlaces(["fx-07"]);
    expect(failures).toEqual([]);
    expect(stops.map((s) => s.id)).toEqual(["fx-07"]);
  });

  it("a URL encoding an unknown place name surfaces as a failure, not a resolved stop", async () => {
    const { stops, failures } = await adapter.resolvePlaces([
      "https://maps.google.com/?q=Totally+Fake+Place",
    ]);
    expect(stops).toEqual([]);
    expect(failures).toEqual([
      {
        source: "https://maps.google.com/?q=Totally+Fake+Place",
        reason: "no match in fixture city",
      },
    ]);
  });
});
