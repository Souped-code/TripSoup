import { ParsedItinerarySchema } from "../types";

const VALID = {
  items: [
    {
      kind: "link",
      raw: "https://example.com",
      url: "https://example.com",
      anchorLikely: false,
    },
  ],
  days: [{ itemRefs: [0] }],
  splitGroups: [],
};

describe("ParsedItinerarySchema", () => {
  it("accepts a well-formed payload", () => {
    expect(ParsedItinerarySchema.safeParse(VALID).success).toBe(true);
  });

  it("coerces a missing/null anchorLikely to false — live-model tolerance (prod, 2026-08-10)", () => {
    // The live LLM omits anchorLikely on items with no time cue, and at temp 0
    // every retry omits it identically — a hard requirement burned all attempts
    // on a guaranteed failure. Missing and null read as "no anchor signal".
    for (const item of [
      { kind: "link", raw: "x" },
      { kind: "link", raw: "x", anchorLikely: null },
    ]) {
      const parsed = ParsedItinerarySchema.safeParse({ items: [item], days: [], splitGroups: [] });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.items[0].anchorLikely).toBe(false);
    }
  });

  it("still rejects a non-boolean anchorLikely (garbage is not a default)", () => {
    const bad = {
      items: [{ kind: "link", raw: "x", anchorLikely: "yes" }],
      days: [],
      splitGroups: [],
    };
    expect(ParsedItinerarySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown `kind` value", () => {
    const bad = {
      items: [{ kind: "junk", raw: "x", anchorLikely: false }],
      days: [],
      splitGroups: [],
    };
    expect(ParsedItinerarySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects itemRefs that aren't numbers", () => {
    const bad = { items: [], days: [{ itemRefs: ["0"] }], splitGroups: [] };
    expect(ParsedItinerarySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects completely malformed junk", () => {
    expect(ParsedItinerarySchema.safeParse({ nonsense: true }).success).toBe(false);
    expect(ParsedItinerarySchema.safeParse(null).success).toBe(false);
    expect(ParsedItinerarySchema.safeParse("not an object").success).toBe(false);
  });

  it("rejects a top-level array in place of the items array", () => {
    const bad = { items: "not-an-array", days: [], splitGroups: [] };
    expect(ParsedItinerarySchema.safeParse(bad).success).toBe(false);
  });
});
