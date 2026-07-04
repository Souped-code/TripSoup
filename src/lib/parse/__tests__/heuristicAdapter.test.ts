import { createHeuristicAdapter } from "../heuristicAdapter";

// Golden sample: exercises URL extraction, line-adjacency label pairing
// (label above the link, no same-line text), a time hint, an ordering
// phrase ("... first"), and two named subgroups.
const SAMPLE = `Day 1
Group A
Hotel check-in
https://maps.google.com/?q=Grand+Hotel
Drop bags at the hotel first
Lunch at 2pm
https://maps.google.com/?q=Sunset+Cafe
Group B
Museum visit
https://maps.google.com/?q=City+Museum`;

describe("heuristic adapter golden", () => {
  it("parses the sample blob into the expected exact shape", async () => {
    const adapter = createHeuristicAdapter();
    const result = await adapter.parse(SAMPLE);

    expect(result).toEqual({
      items: [
        {
          kind: "link",
          raw: "https://maps.google.com/?q=Grand+Hotel",
          url: "https://maps.google.com/?q=Grand+Hotel",
          label: "Hotel check-in",
          dateHint: "Day 1",
          anchorLikely: false,
          groupHint: "Group A",
        },
        {
          kind: "label",
          raw: "Drop bags at the hotel first",
          label: "Drop bags at the hotel first",
          dateHint: "Day 1",
          anchorLikely: false,
          groupHint: "Group A",
          orderConstraint: {
            before: ["https://maps.google.com/?q=Sunset+Cafe"],
            reason: "Drop bags at the hotel first",
          },
        },
        {
          kind: "link",
          raw: "https://maps.google.com/?q=Sunset+Cafe",
          url: "https://maps.google.com/?q=Sunset+Cafe",
          label: "Lunch at 2pm",
          dateHint: "Day 1",
          timeHint: "2pm",
          anchorLikely: true,
          anchorReason: 'time hint "2pm" implies a fixed-time schedule anchor',
          groupHint: "Group A",
        },
        {
          kind: "link",
          raw: "https://maps.google.com/?q=City+Museum",
          url: "https://maps.google.com/?q=City+Museum",
          label: "Museum visit",
          dateHint: "Day 1",
          anchorLikely: false,
          groupHint: "Group B",
        },
      ],
      days: [{ dateHint: "Day 1", itemRefs: [0, 1, 2, 3] }],
      splitGroups: [
        { name: "Group A", itemRefs: [0, 1, 2] },
        { name: "Group B", itemRefs: [3] },
      ],
    });
  });

  it("extracts URLs verbatim, never altering them", async () => {
    const messy = `Check this out https://example.com/path?a=1&b=two%20words#frag`;
    const adapter = createHeuristicAdapter();
    const result = await adapter.parse(messy);
    expect(result.items[0].url).toBe("https://example.com/path?a=1&b=two%20words#frag");
  });

  it("falls back to a single implicit day when no day markers are present", async () => {
    const adapter = createHeuristicAdapter();
    const result = await adapter.parse("https://example.com/x");
    expect(result.days).toEqual([{ itemRefs: [0] }]);
  });

  it("returns empty structures for empty input", async () => {
    const adapter = createHeuristicAdapter();
    const result = await adapter.parse("");
    expect(result).toEqual({ items: [], days: [], splitGroups: [] });
  });
});
