// D2.2 backend spine — end-to-end pipeline test. Fixture mode ONLY: no live
// Maps/LLM calls are ever made here. Isolates the trip store to a fresh temp
// dir per test (mirrors the file-store's env-driven wiring in config.ts —
// TRIPS_DIR is read fresh on every getTripStore() call, so no module reset
// is needed between tests).

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { runPipeline, parseTimeHint, type PipelineProgress, type PipelineResult } from "../pipeline";
import * as config from "../../config";

// A realistic pasted itinerary blob using REAL Casterbridge fixture names
// (fixtureCity.ts): fx-04 Riverside Cafe, fx-01 Market Hall, fx-02 Clock
// Tower Square. "first" triggers heuristicAdapter's orderConstraint.before;
// "2pm" triggers anchorLikely+timeHint; the last URL names a place that does
// not exist in the fixture city, so it must surface as a failure.
const BLOB = `Day 1
Drop bags at Riverside Cafe first https://maps.google.com/?q=Riverside+Cafe
https://maps.google.com/?q=Market+Hall
A charming old market square worth a look
Meet at Clock Tower Square 2pm https://maps.google.com/maps/place/Clock+Tower+Square
https://maps.google.com/?q=Mystery+Ruins+Nobody+Knows
`;

async function drive(text: string): Promise<{ progress: PipelineProgress[]; result: PipelineResult }> {
  const gen = runPipeline(text);
  const progress: PipelineProgress[] = [];
  // for-await gives yielded values but not the generator's `return` value —
  // drive .next() manually so we capture both.
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { progress, result: value as PipelineResult };
    progress.push(value as PipelineProgress);
  }
}

describe("runPipeline", () => {
  let tmpDir: string;
  let prevMapsProvider: string | undefined;
  let prevTripsDir: string | undefined;

  beforeEach(() => {
    prevMapsProvider = process.env.MAPS_PROVIDER;
    prevTripsDir = process.env.TRIPS_DIR;
    process.env.MAPS_PROVIDER = "fixture";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-"));
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

  it("parseTimeHint handles am/pm and 24h shapes, and rejects garbage", () => {
    expect(parseTimeHint("2pm")).toBe(14 * 60);
    expect(parseTimeHint("2:30pm")).toBe(14 * 60 + 30);
    expect(parseTimeHint("9am")).toBe(9 * 60);
    expect(parseTimeHint("14:00")).toBe(14 * 60);
    expect(parseTimeHint("not a time")).toBeNull();
  });

  it("runs end to end: progress monotonic, stage order, persisted doc, anchors, precedence, failures", async () => {
    // Spy on getMapsProvider so we can assert exactly what resolvePlaces
    // receives, directly verifying the LOCKED rule (only .url values, never
    // label text, ever reach resolvePlaces) — the pipeline calls
    // getMapsProvider() itself, so the spy must replace the module export,
    // not a separately-constructed adapter instance.
    const realGetMapsProvider = config.getMapsProvider;
    const capturedCalls: string[][] = [];
    jest.spyOn(config, "getMapsProvider").mockImplementation(() => {
      const real = realGetMapsProvider();
      return {
        ...real,
        resolvePlaces: async (inputs: string[]) => {
          capturedCalls.push(inputs);
          return real.resolvePlaces(inputs);
        },
      };
    });

    const { progress, result } = await drive(BLOB);

    // --- progress monotonic, ends at 100 ---
    expect(progress.length).toBeGreaterThan(0);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].pct).toBeGreaterThanOrEqual(progress[i - 1].pct);
    }
    expect(progress[progress.length - 1].pct).toBe(100);

    // --- stage ordering: parse -> resolve -> (matrix/solve)*, never backward
    // into an earlier stage once left ---
    const firstResolveIdx = progress.findIndex((p) => p.stage === "resolve");
    const firstMatrixIdx = progress.findIndex((p) => p.stage === "matrix");
    expect(firstResolveIdx).toBeGreaterThan(-1);
    expect(firstMatrixIdx).toBeGreaterThan(firstResolveIdx);
    expect(progress.slice(firstResolveIdx).some((p) => p.stage === "parse")).toBe(false);
    expect(
      progress.slice(firstMatrixIdx).some((p) => p.stage === "parse" || p.stage === "resolve")
    ).toBe(false);

    // --- LOCKED rule: only real URLs reach resolvePlaces, never label text ---
    expect(capturedCalls.length).toBe(1); // fixture adapter resolves the whole batch in one call
    const urlsSent = capturedCalls[0];
    expect(urlsSent.length).toBe(4);
    expect(urlsSent.every((u) => u.startsWith("https://"))).toBe(true);
    expect(urlsSent).not.toContain("A charming old market square worth a look");

    // --- final result ---
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return; // narrows for TS below

    expect(result.plans.length).toBe(result.doc.days.length);
    expect(result.doc.days.length).toBe(1); // single "Day 1" marker in the blob

    // --- unresolvable URL surfaces as a failure, pipeline still succeeds ---
    expect(result.failures).toEqual([
      {
        source: "https://maps.google.com/?q=Mystery+Ruins+Nobody+Knows",
        reason: "no match in fixture city",
      },
    ]);

    // --- persisted doc round-trips through the store ---
    const reread = await config.getTripStore().get(result.tripId);
    expect(reread).toEqual(result.doc);

    // --- anchor lands on the correct TripStop (Clock Tower Square, fx-02) ---
    const clockTower = result.doc.days[0].stops.find((s) => s.id === "fx-02");
    expect(clockTower).toBeDefined();
    expect(clockTower?.anchor).toEqual({ startMin: 14 * 60 });

    // other stops have no anchor
    const marketHall = result.doc.days[0].stops.find((s) => s.id === "fx-01");
    expect(marketHall?.anchor).toBeUndefined();
    // label override: Market Hall's display name is overridden by the
    // adjacent label line ("A charming old market square worth a look") —
    // labels CAN become display text, but never a resolve query (already
    // asserted above via urlsSent).
    expect(marketHall?.name).toBe("A charming old market square worth a look");

    // --- precedence pair lands on the correct TripDay ---
    // "Drop bags at Riverside Cafe first" (fx-04) must come before the very
    // next item, Market Hall (fx-01).
    expect(result.doc.days[0].precedence).toEqual([
      expect.objectContaining({ beforeId: "fx-04", afterId: "fx-01" }),
    ]);
  });

  it("succeeds with an empty parse (no days, no items) and still reaches pct 100", async () => {
    const { progress, result } = await drive("");
    expect(progress[progress.length - 1].pct).toBe(100);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.doc.days.length).toBe(1);
    expect(result.doc.days[0].stops).toEqual([]);
    expect(result.plans.length).toBe(1);
    expect(result.failures).toEqual([]);
  });
});
