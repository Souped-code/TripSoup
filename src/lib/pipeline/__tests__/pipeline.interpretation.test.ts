// M1.4 / M1.5 / M1.6 — whole-paste interpretation. The subject here is the
// RESOLVE CHECKPOINT: the one place that decides to spend money on a Places
// lookup. Every test below either proves a guard holds or proves a string that
// must never be billed is never sent.
//
// Fixture mode ONLY — no live Maps/LLM calls are ever made (mirrors
// pipeline.test.ts's isolation exactly: fresh TRIPS_DIR per test,
// MAPS_PROVIDER=fixture).

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { runPipeline, resolveDayDate, type PipelineResult } from "../pipeline";
import * as config from "../../config";
import * as parseModule from "../../parse/parseItinerary";
import type { ParsedItinerary } from "../../parse/types";
import {
  createEntitlements,
  getEntitlements,
  type Capability,
} from "../../entitlements/entitlements";

// Entitlements holding everything EXCEPT interpret.names — the free-tier shape
// M3.5 will return for real. maxStops overridable to exercise the cap cheaply.
function withoutNames(maxStops = 40) {
  const caps: Capability[] = [
    "resolve.links",
    "interpret.social",
    "suggest.crossDate",
    "export.hires",
  ];
  return createEntitlements({ tier: "free", capabilities: caps, maxStops, watermark: true });
}

function withNames(maxStops = 40) {
  return createEntitlements({
    tier: "pass",
    capabilities: [
      "resolve.links",
      "interpret.names",
      "interpret.social",
      "suggest.crossDate",
      "export.hires",
    ],
    maxStops,
    watermark: false,
  });
}

// Captures exactly what reached resolvePlaces. The pipeline calls
// getMapsProvider() itself, so the spy must replace the module export.
function spyOnResolveInputs(): string[][] {
  const captured: string[][] = [];
  const realGetMapsProvider = config.getMapsProvider;
  jest.spyOn(config, "getMapsProvider").mockImplementation(() => {
    const real = realGetMapsProvider();
    return {
      ...real,
      resolvePlaces: async (inputs: string[]) => {
        captured.push([...inputs]);
        return real.resolvePlaces(inputs);
      },
    };
  });
  return captured;
}

async function drive(
  text: string,
  opts: Parameters<typeof runPipeline>[1] = {}
): Promise<PipelineResult> {
  const gen = runPipeline(text, opts);
  while (true) {
    const { value, done } = await gen.next();
    if (done) return value as PipelineResult;
  }
}

describe("M1 interpretation — resolve checkpoint", () => {
  let tmpDir: string;
  let prevMapsProvider: string | undefined;
  let prevTripsDir: string | undefined;

  beforeEach(() => {
    prevMapsProvider = process.env.MAPS_PROVIDER;
    prevTripsDir = process.env.TRIPS_DIR;
    process.env.MAPS_PROVIDER = "fixture";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-interp-test-"));
    process.env.TRIPS_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevMapsProvider === undefined) delete process.env.MAPS_PROVIDER;
    else process.env.MAPS_PROVIDER = prevMapsProvider;
    if (prevTripsDir === undefined) delete process.env.TRIPS_DIR;
    else process.env.TRIPS_DIR = prevTripsDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  // ------------------------------------------------------------ the gate

  it("gate OFF: a text-only paste bills nothing and resolves no stops", async () => {
    const captured = spyOnResolveInputs();
    const result = await drive(
      ["Day 1", "Market Hall", "Riverside Cafe"].join("\n"),
      { entitlements: withoutNames() }
    );

    // Nothing was sent at all — not "sent and discarded".
    expect(captured.flat()).toEqual([]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.doc.days.flatMap((d) => d.stops)).toEqual([]);
  });

  it("gate ON: the same text-only paste resolves its named places", async () => {
    const captured = spyOnResolveInputs();
    const result = await drive(
      ["Day 1", "Market Hall", "Riverside Cafe"].join("\n"),
      { entitlements: withNames() }
    );

    expect(captured.flat()).toEqual(["Market Hall, Casterbridge", "Riverside Cafe, Casterbridge"]);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.doc.days[0].stops.map((s) => s.id)).toEqual(["fx-01", "fx-04"]);
  });

  it("gate is belt-and-suspenders: a stray placeQuery is refused at the checkpoint itself", async () => {
    // Bypasses the parse-adapter gate entirely (M1.6's gate 1) to prove the
    // resolve gate (M1.4's gate 2) stands on its own — a placeQuery arriving
    // from ANY source, including a future adapter or a bug, still cannot be
    // billed without the capability.
    const parsed: ParsedItinerary = {
      items: [
        {
          kind: "label",
          raw: "Market Hall",
          label: "Market Hall",
          placeQuery: "Market Hall, Casterbridge",
          anchorLikely: false,
        },
      ],
      days: [{ itemRefs: [0] }],
      splitGroups: [],
    };
    jest.spyOn(parseModule, "parseItinerary").mockResolvedValue(parsed);
    const captured = spyOnResolveInputs();

    await drive("Market Hall", { entitlements: withoutNames() });
    expect(captured.flat()).toEqual([]);
  });

  // ------------------------------------------------- what may be queried

  it("label and raw text are NEVER queries, even with the gate fully on", async () => {
    // A note with no url and no placeQuery. Its raw/label text is exactly the
    // kind of string the LOCKED rule exists to keep away from Places.
    const parsed: ParsedItinerary = {
      items: [
        {
          kind: "label",
          raw: "remember to book the ferry, it sells out",
          label: "remember to book the ferry, it sells out",
          anchorLikely: false,
        },
      ],
      days: [{ itemRefs: [0] }],
      splitGroups: [],
    };
    jest.spyOn(parseModule, "parseItinerary").mockResolvedValue(parsed);
    const captured = spyOnResolveInputs();

    await drive("remember to book the ferry, it sells out", { entitlements: withNames() });
    expect(captured.flat()).toEqual([]);
  });

  it("a link item resolves by its url — a placeQuery never competes with it", async () => {
    const parsed: ParsedItinerary = {
      items: [
        {
          kind: "link",
          raw: "https://maps.google.com/?q=Market+Hall",
          url: "https://maps.google.com/?q=Market+Hall",
          placeQuery: "Somewhere Else Entirely, Casterbridge",
          anchorLikely: false,
        },
      ],
      days: [{ itemRefs: [0] }],
      splitGroups: [],
    };
    jest.spyOn(parseModule, "parseItinerary").mockResolvedValue(parsed);
    const captured = spyOnResolveInputs();

    await drive("x", { entitlements: withNames() });
    expect(captured.flat()).toEqual(["https://maps.google.com/?q=Market+Hall"]);
  });

  // ------------------------------------------------------------- dedupe

  it("the same place on two days is billed ONCE and fanned back to both items", async () => {
    const captured = spyOnResolveInputs();
    const result = await drive(
      ["Day 1", "Riverside Cafe", "Day 2", "Riverside Cafe"].join("\n"),
      { entitlements: withNames() }
    );

    // One billed lookup, one cap slot...
    expect(captured.flat()).toEqual(["Riverside Cafe, Casterbridge"]);
    // ...but both days still get their stop.
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.doc.days.map((d) => d.stops.map((s) => s.id))).toEqual([["fx-04"], ["fx-04"]]);
  });

  // ---------------------------------------------------------------- cap

  it("caps at maxStops on UNIQUE queries and reports the overflow", async () => {
    const captured = spyOnResolveInputs();
    const lines = ["Day 1"];
    for (let i = 1; i <= 41; i++) lines.push(`https://maps.google.com/?q=Place+Number+${i}`);

    const result = await drive(lines.join("\n"), { entitlements: withNames() });

    expect(captured.flat()).toHaveLength(40);
    if (result.status !== "ok") throw new Error("expected ok");
    const overflow = result.failures.filter((f) => /that's a lot of places/i.test(f.reason));
    expect(overflow).toHaveLength(1);
    expect(overflow[0].source).toBe("https://maps.google.com/?q=Place+Number+41");
  });

  it("the cap is an entitlement, not a constant — a lower maxStops binds", async () => {
    const captured = spyOnResolveInputs();
    const lines = ["Day 1"];
    for (let i = 1; i <= 5; i++) lines.push(`https://maps.google.com/?q=Place+Number+${i}`);

    await drive(lines.join("\n"), { entitlements: withNames(3) });
    expect(captured.flat()).toHaveLength(3);
  });

  it("links are never crowded out of the cap by names", async () => {
    const captured = spyOnResolveInputs();
    // Two names appear BEFORE the link in the paste; with a cap of 1 the link
    // must still be the one that gets resolved.
    const result = await drive(
      ["Day 1", "Market Hall", "Guildhall Museum", "https://maps.google.com/?q=Riverside+Cafe"].join("\n"),
      { entitlements: withNames(1) }
    );

    expect(captured.flat()).toEqual(["https://maps.google.com/?q=Riverside+Cafe"]);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.doc.days[0].stops.map((s) => s.id)).toEqual(["fx-04"]);
  });

  // ------------------------------------------------- end-to-end interpretation

  it("a two-day text-only paste keeps its days separate, anchors a time, and honours order intent", async () => {
    const result = await drive(
      [
        "Day 1",
        "Market Hall",
        "Riverside Cafe 2pm",
        "Day 2",
        "Guildhall Museum first",
        "Castle Keep",
      ].join("\n"),
      { entitlements: withNames(), refToday: "2026-07-29" }
    );

    if (result.status !== "ok") throw new Error("expected ok");
    const [d1, d2] = result.doc.days;

    // Days separate, nothing shuffled across them.
    expect(d1.stops.map((s) => s.id)).toEqual(["fx-01", "fx-04"]);
    expect(d2.stops.map((s) => s.id)).toEqual(["fx-03", "fx-16"]);

    // "2pm" anchored the cafe.
    expect(d1.stops[1].anchor).toEqual({ startMin: 14 * 60 });

    // "first" became a real precedence pair on day 2.
    expect(d2.precedence).toEqual([
      expect.objectContaining({ beforeId: "fx-03", afterId: "fx-16" }),
    ]);

    // No real dates in the paste -> honest labels, placeholder dates.
    expect(d1.dayLabel).toBe("Day 1");
    expect(d2.dayLabel).toBe("Day 2");
  });

  it("defaults to the process entitlements when none are injected", async () => {
    // The stub is all-on, so the text-only path works without a caller opting
    // in — this pins the default so M3.5's swap is a visible change.
    expect(getEntitlements().has("interpret.names")).toBe(true);
    const result = await drive(["Day 1", "Market Hall"].join("\n"));
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.doc.days[0].stops.map((s) => s.id)).toEqual(["fx-01"]);
  });
});

// ---------------------------------------------------------------------------

describe("resolveDayDate (M1.5)", () => {
  const REF = "2026-07-29";

  it("reads an explicit day+month and infers the year forward", () => {
    // Still ahead in the reference year.
    expect(resolveDayDate("12 Aug", REF, "Day 1")).toEqual({ date: "2026-08-12" });
    // Already past in the reference year -> next year, never a past trip date.
    expect(resolveDayDate("12 Jul", REF, "Day 1")).toEqual({ date: "2027-07-12" });
    // Today itself counts as future.
    expect(resolveDayDate("29 Jul", REF, "Day 1")).toEqual({ date: "2026-07-29" });
  });

  it("accepts month-first and long month names, with or without an explicit year", () => {
    expect(resolveDayDate("Aug 12", REF, "Day 1")).toEqual({ date: "2026-08-12" });
    expect(resolveDayDate("August 12", REF, "Day 1")).toEqual({ date: "2026-08-12" });
    expect(resolveDayDate("15 March 2028", REF, "Day 1")).toEqual({ date: "2028-03-15" });
    expect(resolveDayDate("12th July 2026", REF, "Day 1")).toEqual({ date: "2026-07-12" });
  });

  it("rolls a Feb 29 hint to the next leap year rather than inventing Mar 1", () => {
    expect(resolveDayDate("29 Feb", "2026-01-01", "Day 1")).toEqual({ date: "2028-02-29" });
  });

  it("labels — never invents a date — for Day N, weekdays, and absent hints", () => {
    expect(resolveDayDate("Day 2", REF, "Day 2")).toEqual({ date: REF, dayLabel: "Day 2" });
    expect(resolveDayDate("Saturday", REF, "Day 3")).toEqual({ date: REF, dayLabel: "Saturday" });
    expect(resolveDayDate(undefined, REF, "Day 1")).toEqual({ date: REF, dayLabel: "Day 1" });
    expect(resolveDayDate("   ", REF, "Day 1")).toEqual({ date: REF, dayLabel: "Day 1" });
  });

  it("refuses ambiguous numeric dates — 12/7 could be either day", () => {
    expect(resolveDayDate("12/7", REF, "Day 1")).toEqual({ date: REF, dayLabel: "12/7" });
    expect(resolveDayDate("12-07-2026", REF, "Day 1")).toEqual({ date: REF, dayLabel: "12-07-2026" });
  });

  it("rejects impossible dates instead of rolling them over", () => {
    // JS Date would happily turn 31 Feb into 2/3 March. We do not.
    expect(resolveDayDate("31 Feb", REF, "Day 1")).toEqual({ date: REF, dayLabel: "31 Feb" });
    expect(resolveDayDate("31 Apr 2027", REF, "Day 1")).toEqual({ date: REF, dayLabel: "31 Apr 2027" });
  });

  it("tidies label casing and trailing punctuation", () => {
    expect(resolveDayDate("day 1:", REF, "Day 1").dayLabel).toBe("Day 1");
    expect(resolveDayDate("  saturday  ", REF, "Day 2").dayLabel).toBe("Saturday");
  });
});
