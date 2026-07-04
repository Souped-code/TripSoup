// D2.3 (T4) — day-assembly stop-id dedup. Closes the latent gap logged in
// STATE.md at the end of D2.2: src/lib/pipeline/pipeline.ts assembled resolved
// stops into each day keyed by stop.id (the resolved place_id); if two pasted
// links resolved to the SAME place_id, the day carried two same-id stops,
// which the solver ("every stop exactly once", solver/solver.ts) and the
// id-keyed travel matrix cannot handle — schedule.ts's validateDay throws
// "duplicate stop id in day" the moment that reaches planTripDay, so
// pre-fix this whole scenario surfaces as PipelineResult status:"error", not
// as an inspectable two-element array. Fixture mode ONLY: no live Maps/LLM
// calls are ever made here (mirrors pipeline.test.ts's isolation exactly —
// fresh TRIPS_DIR temp dir per test, MAPS_PROVIDER=fixture).

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

describe("runPipeline day-assembly dedup (D2.3 T4)", () => {
  let tmpDir: string;
  let prevMapsProvider: string | undefined;
  let prevTripsDir: string | undefined;

  beforeEach(() => {
    prevMapsProvider = process.env.MAPS_PROVIDER;
    prevTripsDir = process.env.TRIPS_DIR;
    process.env.MAPS_PROVIDER = "fixture";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-dedup-test-"));
    process.env.TRIPS_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevMapsProvider === undefined) delete process.env.MAPS_PROVIDER;
    else process.env.MAPS_PROVIDER = prevMapsProvider;
    if (prevTripsDir === undefined) delete process.env.TRIPS_DIR;
    else process.env.TRIPS_DIR = prevTripsDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dedupes two links that resolve to the same fixture stop id within a day, keeping the first occurrence", async () => {
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
    expect(stops.length).toBe(1);
    expect(stops[0].id).toBe("fx-01");
    expect(stops[0].name).toBe("Market Hall");
  });

  it("carries a later duplicate's anchor onto the surviving first occurrence, without adopting its name", async () => {
    // First occurrence is a plain link (no time hint -> no anchor). The SAME
    // place (fx-01) recurs with a "2pm" hint attached — that occurrence is
    // dropped as a stop, but its anchor must survive onto the kept stop, or a
    // booked time silently vanishes just because a plain link for the same
    // place happened to come first.
    const blob = `Day 1
https://maps.google.com/?q=Market+Hall
Meet at Market Hall 2pm https://maps.google.com/maps/place/Market+Hall
`;
    const { result } = await drive(blob);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const stops = result.doc.days[0].stops;
    expect(stops.length).toBe(1);
    const survivor = stops[0];
    expect(survivor.id).toBe("fx-01");
    // First occurrence's name wins — predictable over clever, no merging.
    expect(survivor.name).toBe("Market Hall");
    // But the later duplicate's anchor hint is carried onto the survivor.
    expect(survivor.anchor).toEqual({ startMin: 14 * 60 });
  });

  it("does NOT dedup the same place id across two different days", async () => {
    // Dedup is scoped to a single day — the same place may legitimately
    // recur on a different day (e.g. breakfast at the same cafe twice).
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
    expect(result.doc.days[1].stops.map((s) => s.id)).toEqual(["fx-01"]);
  });

  it("integration sanity: full pipeline succeeds and the affected day's plan visits each stop exactly once", async () => {
    // Two links dupe to fx-01 ("Market Hall"); a third resolves to a distinct
    // place, fx-02 ("Clock Tower Square"). Pre-fix this reaches planTripDay
    // with two fx-01 stops in one day, and schedule.ts's validateDay throws
    // "duplicate stop id in day: fx-01" — caught by runPipeline's try/catch
    // and surfaced as status:"error", never "ok".
    const blob = `Day 1
https://maps.google.com/?q=Market+Hall
https://maps.google.com/maps/place/Market+Hall
https://maps.google.com/?q=Clock+Tower+Square
`;
    const { result } = await drive(blob);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(
      result.doc.days[0].stops.map((s) => s.id).sort()
    ).toEqual(["fx-01", "fx-02"]);

    expect(result.plans.length).toBe(1);
    const plan = result.plans[0];
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;

    // No duplicate-id stop anywhere in the assembled visit order.
    expect(new Set(plan.order).size).toBe(plan.order.length);
    expect(plan.order.slice().sort()).toEqual(["fx-01", "fx-02"]);
  });

  it("a precedence pair naming a deduped-away occurrence still attaches to the surviving stop", async () => {
    // The interesting direction of spec item 4: the "first" constraint's
    // target (its orderConstraint.before raw-string join) is item2 below —
    // the LATER, dropped occurrence of fx-01 — not item0 (the survivor).
    // Precedence is built from resolvedByItemIndex (untouched by dedup) and
    // attaches by id, so it must still land on whichever stop id="fx-01"
    // survives into day.stops, and the solver must still enforce it.
    const blob = `Day 1
https://maps.google.com/?q=Market+Hall
Grab coffee first https://maps.google.com/?q=Riverside+Cafe
https://maps.google.com/maps/place/Market+Hall
`;
    const { result } = await drive(blob);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const day0 = result.doc.days[0];
    // fx-01 deduped down to one stop; fx-04 (Riverside Cafe) untouched.
    expect(day0.stops.map((s) => s.id).sort()).toEqual(["fx-01", "fx-04"]);
    expect(day0.precedence).toEqual([
      expect.objectContaining({ beforeId: "fx-04", afterId: "fx-01" }),
    ]);

    // And the solver actually enforces it: Riverside Cafe (fx-04) before
    // Market Hall (fx-01) in the assembled visit order.
    const plan = result.plans[0];
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    expect(plan.order.indexOf("fx-04")).toBeLessThan(plan.order.indexOf("fx-01"));
  });
});
