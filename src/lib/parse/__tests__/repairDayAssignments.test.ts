// Positional day repair — reproduces the 2026-08-17 prod finding: the live
// LLM attached the FIRST place under each date marker to the PREVIOUS day
// (systematic fencepost at temperature 0). Position in the pasted text is the
// ground truth whenever the markers are literally findable.

import { repairDayAssignments } from "../repairDayAssignments";
import type { ParsedItinerary } from "../types";

const TEXT = [
  "trip w mum",
  "staying at Marina Bay Sands",
  "",
  "24 aug",
  "- merlion park photo",
  "- gardens by the bay",
  "",
  "25 aug",
  "- chinatown walk",
  "- katong laksa lunch",
  "",
  "26 aug",
  "- jewel changi waterfall",
  "- east coast park sunset",
  "",
  "random",
  "- book grab maybe",
].join("\n");

const item = (raw: string): ParsedItinerary["items"][number] => ({
  kind: "label",
  raw,
  anchorLikely: false,
});

// Items in input order; index:      0                            1
const ITEMS = [
  item("staying at Marina Bay Sands"),
  item("merlion park photo"), //     1
  item("gardens by the bay"), //     2
  item("chinatown walk"), //         3
  item("katong laksa lunch"), //     4
  item("jewel changi waterfall"), // 5
  item("east coast park sunset"), // 6
  item("book grab maybe"), //        7 — dayless note
];

function base(days: ParsedItinerary["days"]): ParsedItinerary {
  return { items: ITEMS, days, splitGroups: [] };
}

describe("repairDayAssignments", () => {
  it("fixes the prod fencepost: first place of each day attached to the previous day", () => {
    // The exact observed slip: day 1 grabbed chinatown (3), day 2 grabbed jewel (5).
    const broken = base([
      { dateHint: "24 aug", itemRefs: [1, 2, 3] },
      { dateHint: "25 aug", itemRefs: [4, 5] },
      { dateHint: "26 aug", itemRefs: [6] },
    ]);
    const repaired = repairDayAssignments(broken, TEXT);
    expect(repaired.days.map((d) => d.itemRefs)).toEqual([[1, 2], [3, 4], [5, 6]]);
    // items untouched, dayless note still dayless
    expect(repaired.items).toBe(ITEMS);
  });

  it("returns the SAME object when the grouping already matches position", () => {
    const correct = base([
      { dateHint: "24 aug", itemRefs: [1, 2] },
      { dateHint: "25 aug", itemRefs: [3, 4] },
      { dateHint: "26 aug", itemRefs: [5, 6] },
    ]);
    expect(repairDayAssignments(correct, TEXT)).toBe(correct);
  });

  it("bails untouched when a marker can't be found in the text", () => {
    const broken = base([
      { dateHint: "24 aug", itemRefs: [1, 2, 3] },
      { dateHint: "August 25th", itemRefs: [4, 5] }, // model rephrased the hint
      { dateHint: "26 aug", itemRefs: [6] },
    ]);
    expect(repairDayAssignments(broken, TEXT)).toBe(broken);
  });

  it("bails untouched for single-day parses and never invents membership", () => {
    const single = base([{ dateHint: "24 aug", itemRefs: [1, 2] }]);
    expect(repairDayAssignments(single, TEXT)).toBe(single);

    // header item (0) and trailing note (7) are dayless — a repair pass over a
    // broken grouping must not pull them into any day
    const broken = base([
      { dateHint: "24 aug", itemRefs: [1, 2, 3] },
      { dateHint: "25 aug", itemRefs: [4, 5] },
      { dateHint: "26 aug", itemRefs: [6] },
    ]);
    const repaired = repairDayAssignments(broken, TEXT);
    const all = repaired.days.flatMap((d) => d.itemRefs);
    expect(all).not.toContain(0);
    expect(all).not.toContain(7);
  });

  it("the same place on two days stays one-per-day (fan-back shape)", () => {
    const text = ["Day 1", "Riverside Cafe", "Day 2", "Riverside Cafe"].join("\n");
    const twice: ParsedItinerary = {
      items: [item("Riverside Cafe"), item("Riverside Cafe")],
      days: [
        { dateHint: "Day 1", itemRefs: [0] },
        { dateHint: "Day 2", itemRefs: [1] },
      ],
      splitGroups: [],
    };
    expect(repairDayAssignments(twice, text)).toBe(twice);
  });

  it("an unlocatable item keeps the model's placement", () => {
    const items = [...ITEMS];
    items[4] = item("totally rewritten by the model"); // raw not in the text
    const broken: ParsedItinerary = {
      items,
      days: [
        { dateHint: "24 aug", itemRefs: [1, 2, 3] },
        { dateHint: "25 aug", itemRefs: [4, 5] },
        { dateHint: "26 aug", itemRefs: [6] },
      ],
      splitGroups: [],
    };
    const repaired = repairDayAssignments(broken, TEXT);
    // 3 and 5 are repaired positionally; 4 is unlocatable → stays on day 2
    expect(repaired.days.map((d) => d.itemRefs)).toEqual([[1, 2], [3, 4], [5, 6]]);
  });
});
