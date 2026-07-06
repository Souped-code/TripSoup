// D2.3 (T4b) — day-assembly duplicate FLAGGING. Supersedes T4's dedupDayStops
// (commit 5ea9719): Chris's product call overrides the earlier "drop the
// second occurrence" behaviour. When two pasted links resolve to the SAME
// place within a day, BOTH are now kept as stops; the later occurrence is
// marked (`duplicateOf`) and given a distinct suffixed id so the engine can
// treat it as its own node — schedule.ts's validateDay throws if two stops in
// a day share an id, and the id-keyed travel matrix assumes each id is a
// distinct node — while the UI (T6 sidebar, not built here) can flag it for
// the user to remove if accidental. Fixture mode ONLY: no live Maps/LLM calls
// are ever made here (mirrors pipeline.test.ts's isolation exactly — fresh
// TRIPS_DIR temp dir per test, MAPS_PROVIDER=fixture).

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { runPipeline, type PipelineProgress, type PipelineResult } from "../pipeline";

async function drive(text: string): Promise<{ progress: PipelineProgress[]; result: PipelineResult }> {
  const gen = runPipeline(text);
  const progress: PipelineProgress[] = [];
  // for-await gives yielded values but not the generator's `return` value —
  // drive .next() manually so we capture both (mirrors pipeline.test.ts).
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { progress, result: value as PipelineResult };
    progress.push(value as PipelineProgress);
  }
}

describe("runPipeline day-assembly duplicate flagging (D2.3 T4b)", () => {
  let tmpDir: string;
  let prevMapsProvider: string | undefined;
  let prevTripsDir: string | undefined;

  beforeEach(() => {
    prevMapsProvider = process.env.MAPS_PROVIDER;
    prevTripsDir = process.env.TRIPS_DIR;
    process.env.MAPS_PROVIDER = "fixture";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-dupflag-test-"));
    process.env.TRIPS_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevMapsProvider === undefined) delete process.env.MAPS_PROVIDER;
    else process.env.MAPS_PROVIDER = prevMapsProvider;
    if (prevTripsDir === undefined) delete process.env.TRIPS_DIR;
    else process.env.TRIPS_DIR = prevTripsDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps BOTH stops when two links resolve to the same fixture place in one day, and marks the second", async () => {
    // Both URLs independently resolve to fx-01 "Market Hall" (fixtureCity.ts)
    // via fixtureAdapter's findFixtureStop — one via ?q=, the other via
    // /maps/place/ — a realistic "pasted the same place twice" scenario.
    const blob = `Day 1
https://maps.google.com/?q=Market+Hall
https://maps.google.com/maps/place/Market+Hall
`;
    const { result } = await drive(blob);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return; // narrows for TS below

    expect(result.doc.days.length).toBe(1);
    const stops = result.doc.days[0].stops;
    expect(stops.length).toBe(2); // neither occurrence is dropped

    expect(stops[0].id).toBe("fx-01");
    expect(stops[0].duplicateOf).toBeUndefined();
    expect(stops[0].name).toBe("Market Hall");
    expect(stops[0].location).toBeTruthy();

    expect(stops[1].id).toBe("fx-01#2");
    expect(stops[1].duplicateOf).toBe("fx-01");
    expect(stops[1].name).toBe("Market Hall");
    expect(stops[1].location).toBeTruthy();
    // Same place -> identical coordinates on both occurrences.
    expect(stops[1].location).toEqual(stops[0].location);

    // The engine constraint this exists to satisfy: distinct ids per day, so
    // schedule.ts's validateDay does not throw, and the plan actually visits
    // both nodes rather than erroring out.
    expect(result.plans.length).toBe(1);
    const plan = result.plans[0];
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    expect(plan.order.length).toBe(2);
    expect(new Set(plan.order)).toEqual(new Set(["fx-01", "fx-01#2"]));
  });

  it("each occurrence keeps its own anchor — no carrying onto the other", async () => {
    // First occurrence is a plain link (no time hint -> no anchor). The SAME
    // place (fx-01) recurs with a "2pm" hint attached. Unlike T4's dedup
    // (which carried a dropped duplicate's anchor onto the survivor), T4b
    // keeps them as separate stops, so the anchor belongs ONLY to the
    // occurrence that actually carried it — no merging, no carrying.
    const blob = `Day 1
https://maps.google.com/?q=Market+Hall
Meet at Market Hall 2pm https://maps.google.com/maps/place/Market+Hall
`;
    const { result } = await drive(blob);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const stops = result.doc.days[0].stops;
    expect(stops.length).toBe(2);

    expect(stops[0].id).toBe("fx-01");
    expect(stops[0].duplicateOf).toBeUndefined();
    expect(stops[0].anchor).toBeUndefined();

    expect(stops[1].id).toBe("fx-01#2");
    expect(stops[1].duplicateOf).toBe("fx-01");
    expect(stops[1].anchor).toEqual({ startMin: 14 * 60 });
  });

  it("does NOT suffix the same place id across two different days", async () => {
    // Flagging is scoped to a single day — the same place may legitimately
    // recur on a different day (e.g. breakfast at the same cafe twice), which
    // is not a same-day accidental duplicate.
    const blob = `Day 1
https://maps.google.com/?q=Market+Hall

Day 2
https://maps.google.com/maps/place/Market+Hall
`;
    const { result } = await drive(blob);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.doc.days.length).toBe(2);

    expect(result.doc.days[0].stops.map((s) => s.id)).toEqual(["fx-01"]);
    expect(result.doc.days[0].stops[0].duplicateOf).toBeUndefined();

    expect(result.doc.days[1].stops.map((s) => s.id)).toEqual(["fx-01"]);
    expect(result.doc.days[1].stops[0].duplicateOf).toBeUndefined();
  });

  it("a precedence pair naming the LATER (suffixed) occurrence attaches to that suffixed id, and the solver enforces it", async () => {
    // The interesting direction of the spec: the "first" constraint's target
    // (its orderConstraint.before raw-string join) is item2 below — the
    // SECOND occurrence of fx-01, which T4b suffixes to fx-01#2 (T4's dedup
    // would have dropped this occurrence and the precedence would have
    // landed on the survivor fx-01 instead; T4b keeps both, so precedence
    // must land on the SPECIFIC occurrence it names, not whichever survives).
    const blob = `Day 1
https://maps.google.com/?q=Market+Hall
Grab coffee first https://maps.google.com/?q=Riverside+Cafe
https://maps.google.com/maps/place/Market+Hall
`;
    const { result } = await drive(blob);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const day0 = result.doc.days[0];
    // In list order: fx-01 (first Market Hall), fx-04 (Riverside Cafe),
    // fx-01#2 (second Market Hall, suffixed).
    expect(day0.stops.map((s) => s.id)).toEqual(["fx-01", "fx-04", "fx-01#2"]);
    expect(day0.stops[2].duplicateOf).toBe("fx-01");

    expect(day0.precedence).toEqual([
      expect.objectContaining({ beforeId: "fx-04", afterId: "fx-01#2" }),
    ]);

    // And the solver actually enforces it: Riverside Cafe (fx-04) before the
    // SECOND Market Hall occurrence (fx-01#2) specifically.
    const plan = result.plans[0];
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    expect(plan.order.indexOf("fx-04")).toBeLessThan(plan.order.indexOf("fx-01#2"));
    expect(new Set(plan.order)).toEqual(new Set(["fx-01", "fx-04", "fx-01#2"]));
  });

  it("is deterministic: running the same duplicate input twice yields identical ids and order", async () => {
    const blob = `Day 1
https://maps.google.com/?q=Market+Hall
Grab coffee first https://maps.google.com/?q=Riverside+Cafe
https://maps.google.com/maps/place/Market+Hall
`;
    const { result: result1 } = await drive(blob);
    const { result: result2 } = await drive(blob);

    expect(result1.status).toBe("ok");
    expect(result2.status).toBe("ok");
    if (result1.status !== "ok" || result2.status !== "ok") return;

    const idsOf = (r: Extract<PipelineResult, { status: "ok" }>) =>
      r.doc.days[0].stops.map((s) => ({ id: s.id, duplicateOf: s.duplicateOf }));
    expect(idsOf(result2)).toEqual(idsOf(result1));

    const plan1 = result1.plans[0];
    const plan2 = result2.plans[0];
    expect(plan1.status).toBe("ok");
    expect(plan2.status).toBe("ok");
    if (plan1.status !== "ok" || plan2.status !== "ok") return;
    expect(plan2.order).toEqual(plan1.order);
  });
});
