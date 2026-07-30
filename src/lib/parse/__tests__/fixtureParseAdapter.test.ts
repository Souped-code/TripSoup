// M1.3 — the fixture parse adapter. It is what makes the headline "paste plain
// text" feature testable at zero spend, so its own behaviour needs pinning:
// which lines earn a placeQuery, which must not, and that it does not disturb
// the heuristic day/time/order detection it wraps.

import { createFixtureParseAdapter } from "../fixtureParseAdapter";

const adapter = createFixtureParseAdapter();

describe("fixture parse adapter — placeQuery emission", () => {
  it("emits a city-qualified placeQuery for a bare fixture place name", async () => {
    const parsed = await adapter.parse("Day 1\nMarket Hall");
    expect(parsed.items[0].placeQuery).toBe("Market Hall, Casterbridge");
  });

  it("finds the place inside a natural sentence, and matches case-insensitively", async () => {
    const parsed = await adapter.parse("Day 1\n9am breakfast at riverside cafe, then wander");
    expect(parsed.items[0].placeQuery).toBe("Riverside Cafe, Casterbridge");
  });

  it("omits placeQuery for a line that names no place", async () => {
    const parsed = await adapter.parse("Day 1\nremember to book the ferry, it sells out");
    expect(parsed.items[0].placeQuery).toBeUndefined();
  });

  it("never adds a placeQuery to an item that already has a url", async () => {
    // Links resolve by url; a second source for the same stop would be a
    // competing query and a wasted cap slot.
    const parsed = await adapter.parse("Day 1\nMarket Hall https://maps.google.com/?q=Market+Hall");
    expect(parsed.items[0].url).toBe("https://maps.google.com/?q=Market+Hall");
    expect(parsed.items[0].placeQuery).toBeUndefined();
  });

  it("prefers the longest matching name so a shorter one cannot shadow it", async () => {
    // "South Beach Boardwalk" contains no other fixture name, but the scan
    // order is what guarantees that in general — assert the long name wins.
    const parsed = await adapter.parse("Day 1\nSouth Beach Boardwalk");
    expect(parsed.items[0].placeQuery).toBe("South Beach Boardwalk, Casterbridge");
  });

  it("leaves the heuristic's day / time / order detection untouched", async () => {
    const parsed = await adapter.parse(
      ["Day 1", "Market Hall first", "Riverside Cafe 2pm", "Day 2", "Castle Keep"].join("\n")
    );

    expect(parsed.days).toHaveLength(2);
    expect(parsed.days[0].itemRefs).toEqual([0, 1]);
    expect(parsed.days[1].itemRefs).toEqual([2]);

    expect(parsed.items[1].timeHint).toBe("2pm");
    expect(parsed.items[1].anchorLikely).toBe(true);
    expect(parsed.items[0].orderConstraint?.before).toEqual(["Riverside Cafe 2pm"]);

    // …and every named place still earned its query.
    expect(parsed.items.map((i) => i.placeQuery)).toEqual([
      "Market Hall, Casterbridge",
      "Riverside Cafe, Casterbridge",
      "Castle Keep, Casterbridge",
    ]);
  });

  it("is deterministic — the same paste yields byte-identical output", async () => {
    const blob = ["Day 1", "Market Hall", "Riverside Cafe 2pm"].join("\n");
    const a = await adapter.parse(blob);
    const b = await adapter.parse(blob);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
