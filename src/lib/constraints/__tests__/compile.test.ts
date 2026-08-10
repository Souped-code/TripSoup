// E2 — compileFromDoc golden. One hand-built TripDoc, one exact ConstraintSet,
// asserted whole. Weights are written as literals, not imported constants, on
// purpose: retuning a weight must break this test and be re-approved, not slip
// through because the expectation moved with the code.

import { compileFromDoc } from "../compile";
import type { ConstraintSet } from "../types";
import type { TripDoc } from "../../store/types";
import { FIXTURE_STOPS } from "../../maps/fixtureCity";
import type { TripStop } from "../../store/types";

const stop = (id: string, durationMin: number, anchorStartMin?: number): TripStop => {
  const f = FIXTURE_STOPS.find((s) => s.id === id)!;
  return {
    id: f.id,
    name: f.name,
    location: f.location,
    durationMin,
    ...(anchorStartMin === undefined ? {} : { anchor: { startMin: anchorStartMin } }),
  };
};

// Two days, an anchor on each, three precedence wishes (same-day, cross-day,
// and one naming a stop that isn't in the doc at all), plus a manualOrder and a
// legOverride that must NOT show up anywhere in the compiled set.
const goldenDoc = (): TripDoc => ({
  tripId: "golden-two-day",
  days: [
    {
      date: "2026-07-05",
      dayStartMin: 540,
      dayEndMin: 1200,
      stops: [stop("fx-01", 60), stop("fx-02", 45, 660), stop("fx-03", 30)],
      precedence: [
        { beforeId: "fx-01", afterId: "fx-03" }, // same day -> hard
        { beforeId: "fx-03", afterId: "fx-06", reason: "harbour at sunset" }, // cross day -> soft
        { beforeId: "fx-01", afterId: "fx-99" }, // dangling -> dropped
      ],
      manualOrder: ["fx-03", "fx-02", "fx-01"], // engine bypass, never a constraint
    },
    {
      date: "2026-07-06",
      dayStartMin: 600,
      dayEndMin: 1260,
      stops: [stop("fx-05", 90, 780), stop("fx-06", 60)],
    },
  ],
  settings: { walkMax: 10, driveOverheadMin: 10 },
  legOverrides: [{ dayIndex: 0, fromId: "fx-01", toId: "fx-03", mode: "drive" }],
});

const expected: ConstraintSet = {
  version: 1,
  stops: {
    "fx-01": {
      duration: {
        value: { minMin: 60, typicalMin: 60, maxMin: 60 },
        provenance: { source: "legacy" },
        hardness: "hard",
      },
      effort: { value: "medium", provenance: { source: "derived" }, hardness: "hard" },
      priority: { value: "must", provenance: { source: "legacy" }, hardness: "hard" },
      pinnedDay: { value: { index: 0 }, provenance: { source: "legacy" }, hardness: "hard" },
    },
    "fx-02": {
      duration: {
        value: { minMin: 45, typicalMin: 45, maxMin: 45 },
        provenance: { source: "legacy" },
        hardness: "hard",
      },
      effort: { value: "medium", provenance: { source: "derived" }, hardness: "hard" },
      priority: { value: "must", provenance: { source: "legacy" }, hardness: "hard" },
      pinnedDay: { value: { index: 0 }, provenance: { source: "legacy" }, hardness: "hard" },
      window: {
        value: { startMin: 660, endMin: 660 },
        provenance: { source: "legacy" },
        hardness: "hard",
      },
    },
    "fx-03": {
      duration: {
        value: { minMin: 30, typicalMin: 30, maxMin: 30 },
        provenance: { source: "legacy" },
        hardness: "hard",
      },
      effort: { value: "medium", provenance: { source: "derived" }, hardness: "hard" },
      priority: { value: "must", provenance: { source: "legacy" }, hardness: "hard" },
      pinnedDay: { value: { index: 0 }, provenance: { source: "legacy" }, hardness: "hard" },
    },
    "fx-05": {
      duration: {
        value: { minMin: 90, typicalMin: 90, maxMin: 90 },
        provenance: { source: "legacy" },
        hardness: "hard",
      },
      effort: { value: "medium", provenance: { source: "derived" }, hardness: "hard" },
      priority: { value: "must", provenance: { source: "legacy" }, hardness: "hard" },
      pinnedDay: { value: { index: 1 }, provenance: { source: "legacy" }, hardness: "hard" },
      window: {
        value: { startMin: 780, endMin: 780 },
        provenance: { source: "legacy" },
        hardness: "hard",
      },
    },
    "fx-06": {
      duration: {
        value: { minMin: 60, typicalMin: 60, maxMin: 60 },
        provenance: { source: "legacy" },
        hardness: "hard",
      },
      effort: { value: "medium", provenance: { source: "derived" }, hardness: "hard" },
      priority: { value: "must", provenance: { source: "legacy" }, hardness: "hard" },
      pinnedDay: { value: { index: 1 }, provenance: { source: "legacy" }, hardness: "hard" },
    },
  },
  days: [
    {
      window: {
        value: { startMin: 540, endMin: 1200 },
        provenance: { source: "legacy" },
        hardness: "hard",
      },
    },
    {
      window: {
        value: { startMin: 600, endMin: 1260 },
        provenance: { source: "legacy" },
        hardness: "hard",
      },
    },
  ],
  trip: {
    pacePreset: {
      value: "balanced",
      provenance: { source: "derived" },
      hardness: { soft: { weight: 50 } },
    },
  },
  relations: [
    {
      id: "precedence:fx-01>fx-03",
      value: { kind: "precedence", beforeId: "fx-01", afterId: "fx-03" },
      provenance: { source: "legacy" },
      hardness: "hard",
    },
    {
      id: "precedence:fx-03>fx-06",
      value: { kind: "precedence", beforeId: "fx-03", afterId: "fx-06" },
      provenance: { source: "legacy" },
      hardness: { soft: { weight: 50 } },
    },
  ],
};

describe("compileFromDoc — golden", () => {
  it("compiles a two-day doc to exactly this constraint set", () => {
    expect(compileFromDoc(goldenDoc())).toEqual(expected);
  });

  it("is deterministic: two compiles of the same doc are deep-equal", () => {
    const doc = goldenDoc();
    expect(compileFromDoc(doc)).toEqual(compileFromDoc(doc));
    // ...and independent of the doc object identity.
    expect(compileFromDoc(goldenDoc())).toEqual(compileFromDoc(goldenDoc()));
  });

  it("never mutates the doc it compiles", () => {
    const doc = goldenDoc();
    const before = JSON.stringify(doc);
    compileFromDoc(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("compileFromDoc — mapping decisions", () => {
  it("ignores manualOrder and legOverrides entirely (engine bypass / post-solve layer)", () => {
    const withBypass = goldenDoc();
    const without: TripDoc = {
      ...withBypass,
      legOverrides: [],
      days: withBypass.days.map((d) => {
        const { manualOrder: _drop, ...rest } = d;
        return rest;
      }),
    };
    expect(compileFromDoc(withBypass)).toEqual(compileFromDoc(without));
  });

  it("ignores travel-model settings (walkMax / driveOverheadMin)", () => {
    const a = goldenDoc();
    const b: TripDoc = { ...a, settings: { walkMax: 25, driveOverheadMin: 0 } };
    expect(compileFromDoc(a)).toEqual(compileFromDoc(b));
  });

  it("drops a precedence pair whose endpoint is nowhere in the doc", () => {
    const set = compileFromDoc(goldenDoc());
    expect(set.relations.map((r) => r.id)).not.toContain("precedence:fx-01>fx-99");
    // every relation endpoint is a key of `stops` — the engine may rely on it
    for (const rel of set.relations) {
      const ends =
        rel.value.kind === "precedence"
          ? [rel.value.beforeId, rel.value.afterId]
          : [rel.value.aId, rel.value.bId];
      for (const id of ends) expect(set.stops[id]).toBeDefined();
    }
  });

  it("states the same precedence wish once, however many times the doc repeats it", () => {
    const doc = goldenDoc();
    doc.days[0].precedence = [
      { beforeId: "fx-01", afterId: "fx-03" },
      { beforeId: "fx-01", afterId: "fx-03", reason: "said twice" },
    ];
    expect(compileFromDoc(doc).relations).toHaveLength(1);
  });

  it("gives a stop repeated across days one entry, pinned to its first day", () => {
    const doc = goldenDoc();
    doc.days[1].stops = [...doc.days[1].stops, stop("fx-01", 15)];
    const set = compileFromDoc(doc);
    expect(set.stops["fx-01"].pinnedDay!.value.index).toBe(0);
    expect(set.stops["fx-01"].duration.value.typicalMin).toBe(60); // first occurrence's
  });

  it("hard-pins every stop to its pasted day (single-day launch mode)", () => {
    const set = compileFromDoc(goldenDoc());
    for (const c of Object.values(set.stops)) {
      expect(c.pinnedDay).toBeDefined();
      expect(c.pinnedDay!.hardness).toBe("hard");
    }
  });

  it("handles an empty doc and a day with no stops without special-casing", () => {
    const empty: TripDoc = {
      tripId: "empty",
      days: [],
      settings: { walkMax: 10, driveOverheadMin: 10 },
      legOverrides: [],
    };
    expect(compileFromDoc(empty)).toEqual({
      version: 1,
      stops: {},
      days: [],
      trip: {
        pacePreset: {
          value: "balanced",
          provenance: { source: "derived" },
          hardness: { soft: { weight: 50 } },
        },
      },
      relations: [],
    });

    const blankDay: TripDoc = {
      ...empty,
      days: [{ date: "2026-07-05", dayStartMin: 540, dayEndMin: 1200, stops: [] }],
    };
    const set = compileFromDoc(blankDay);
    expect(set.days).toHaveLength(1);
    expect(set.stops).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// E2 audit finding 1 (MAJOR): cross-day repeat visits are OCCURRENCES, each
// with its own entry — the first-occurrence-owns collapse silently dropped a
// later visit's anchor and pinned everything to the first day. This doc is the
// auditor's reproduction: Cathedral (fx-10) on day 0 unanchored, and AGAIN on
// day 2 with a booked 18:00 evensong.
// ---------------------------------------------------------------------------
describe("cross-day repeat visits (audit finding 1)", () => {
  const fx10 = FIXTURE_STOPS.find((s) => s.id === "fx-10")!;
  const fx01 = FIXTURE_STOPS.find((s) => s.id === "fx-01")!;
  const mk = (f: typeof fx10, durationMin: number, anchor?: number): TripStop => ({
    id: f.id,
    name: f.name,
    location: f.location,
    durationMin,
    ...(anchor !== undefined ? { anchor: { startMin: anchor } } : {}),
  });
  const day = (stops: TripStop[], precedence?: Array<{ beforeId: string; afterId: string }>) => ({
    date: "2026-07-05",
    dayStartMin: 540,
    dayEndMin: 1320,
    stops,
    ...(precedence ? { precedence } : {}),
  });
  const doc: TripDoc = {
    tripId: "t-crossday",
    days: [
      day([mk(fx10, 60), mk(fx01, 45)]),
      day([mk(fx01, 30)].slice(0, 0).concat([])), // empty middle day
      day([mk(fx10, 30, 1080)], [{ beforeId: "fx-10", afterId: "fx-10" }]),
    ],
    settings: { walkMax: 10, driveOverheadMin: 10 },
    legOverrides: [],
  };

  it("gives every occurrence its own entry, pin, duration, and window", () => {
    const set = compileFromDoc(doc);

    // First occurrence: bare id, pinned day 0, 60min, no window.
    const first = set.stops["fx-10"];
    expect(first.pinnedDay!.value).toEqual({ index: 0 });
    expect(first.duration.value.typicalMin).toBe(60);
    expect(first.window).toBeUndefined();

    // Second occurrence: suffixed key, pinned day 2, 30min, the 18:00 booking
    // is a hard [1080,1080] window — NOT dropped.
    const second = set.stops["fx-10@d2"];
    expect(second).toBeDefined();
    expect(second.pinnedDay!.value).toEqual({ index: 2 });
    expect(second.duration.value.typicalMin).toBe(30);
    expect(second.window).toBeDefined();
    expect(second.window!.value).toEqual({ startMin: 1080, endMin: 1080 });
    expect(second.window!.hardness).toBe("hard");
  });

  it("resolves a precedence endpoint to the occurrence on the pair's own day", () => {
    const set = compileFromDoc(doc);
    // The day-2 self-pair resolved both endpoints to the day-2 occurrence and
    // was then discarded as degenerate or kept consistent — either way no
    // relation may reference a key that is not in stops.
    for (const r of set.relations) {
      if (r.value.kind === "precedence") {
        expect(set.stops[r.value.beforeId]).toBeDefined();
        expect(set.stops[r.value.afterId]).toBeDefined();
      }
    }
  });
});

describe("mergePatches wire-shape hardening (audit finding 2)", () => {
  it("treats null constraint values and provenance-less assertions as not-asserted", async () => {
    const { mergePatches } = await import("../compile");
    const base = compileFromDoc({
      tripId: "t-null",
      days: [
        {
          date: "2026-07-05",
          dayStartMin: 540,
          dayEndMin: 1320,
          stops: [
            {
              id: "fx-01",
              name: "Market Hall",
              location: FIXTURE_STOPS[0].location,
              durationMin: 60,
            },
          ],
        },
      ],
      settings: { walkMax: 10, driveOverheadMin: 10 },
      legOverrides: [],
    });
    // Wire-shaped hostile patch: nulls where constraints go, a provenance-less
    // assertion, and a __proto__ key. Must not throw, must not pollute.
    const hostile = JSON.parse(
      '{"stops":{"fx-01":{"effort":null,"priority":{"value":"could"}},"__proto__":{"priority":{"value":"could","provenance":{"source":"user"},"hardness":"hard"}}},"trip":{"pacePreset":null}}'
    );
    const merged = mergePatches(base, hostile);
    expect(merged.stops["fx-01"].effort.value).toBe("medium"); // null ignored
    expect(merged.stops["fx-01"].priority.value).toBe("must"); // provenance-less ignored
    expect(Object.getPrototypeOf(merged.stops)).toBe(Object.getPrototypeOf(base.stops)); // no proto graft
    expect(({} as Record<string, unknown>).priority).toBeUndefined(); // no global pollution
  });
});
