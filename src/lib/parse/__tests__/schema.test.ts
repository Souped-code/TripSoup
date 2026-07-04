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

  it("rejects a missing required field (anchorLikely)", () => {
    const bad = { items: [{ kind: "link", raw: "x" }], days: [], splitGroups: [] };
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
