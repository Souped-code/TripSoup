// E4 — plan persistence: solve once, store, read back. Fixture mode only
// (mirrors pipeline.test.ts's isolation: fresh TRIPS_DIR temp dir per test,
// MAPS_PROVIDER=fixture — no live Maps/LLM calls are ever made here).

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { savePlanned, readPlanned, stampPlan, persistPlanned, recookDay, recookTrip } from "../planStore";
import { solveProjection, computeSolveHash, computeDayHash } from "../plan/solveProjection";
import * as planServiceModule from "../planService";
import * as planEngineModule from "../planEngine";
import { seedFor } from "../planEngine";
import { ENGINE_NAME, ENGINE_VERSION, alnsEngine } from "../engine";
import { getTripStore } from "../config";
import type { TripDoc, TripStop } from "../store/types";
import { FIXTURE_STOPS } from "../maps/fixtureCity";
import { parseGoogleHours } from "../maps/openingHours";

const stop = (id: string, extra: Partial<TripStop> = {}): TripStop => {
  const f = FIXTURE_STOPS.find((s) => s.id === id)!;
  // E3 — mirrors pipeline.ts's assembly: fixtureCity.ts's `.hours` is the raw
  // Google-shape mirror (FixtureGoogleHours), parsed through the REAL
  // parseGoogleHours here too, exactly like production, rather than a
  // test-only shortcut.
  const hours = f.hours ? parseGoogleHours(f.hours) : null;
  return {
    id: f.id,
    name: f.name,
    location: f.location,
    durationMin: 60,
    ...(hours ? { hours } : {}),
    ...extra,
  };
};

// Four walkable old-town stops -> always feasible in the fixture city.
const baseDoc = (tripId: string, day: Partial<TripDoc["days"][number]> = {}): TripDoc => ({
  tripId,
  days: [
    {
      date: "2026-07-05",
      dayStartMin: 540,
      dayEndMin: 1320,
      stops: [stop("fx-01"), stop("fx-02"), stop("fx-03"), stop("fx-04")],
      ...day,
    },
  ],
  settings: { walkMax: 10, driveOverheadMin: 10 },
  legOverrides: [],
});

describe("planStore (E4)", () => {
  let tmpDir: string;
  let prevMapsProvider: string | undefined;
  let prevTripsDir: string | undefined;

  beforeEach(() => {
    prevMapsProvider = process.env.MAPS_PROVIDER;
    prevTripsDir = process.env.TRIPS_DIR;
    process.env.MAPS_PROVIDER = "fixture";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "planstore-test-"));
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

  // ---------------------------------------------------------------- savePlanned

  it("savePlanned stamps a correct solveHash, engine, and per-day plans", async () => {
    const doc = baseDoc("t-save");
    const saved = await savePlanned(doc);

    expect(saved.plan).toBeDefined();
    expect(saved.plan!.version).toBe(1);
    // E5b: the production engine is now the E5a ALNS behind the SolverEngine
    // port, seeded deterministically from the doc's own solve projection —
    // no more hardcoded {name:"legacy-exhaustive", seed:0}.
    expect(saved.plan!.engine).toEqual({
      name: ENGINE_NAME,
      version: ENGINE_VERSION,
      seed: seedFor(doc),
    });
    expect(typeof saved.plan!.computedAt).toBe("string");
    expect(new Date(saved.plan!.computedAt).toString()).not.toBe("Invalid Date");
    expect(saved.plan!.solveHash).toBe(computeSolveHash(doc));
    expect(saved.plan!.days.length).toBe(1);
    expect(saved.plan!.days[0].status).toBe("ok");

    // and it actually landed in the store, not just the return value
    const reread = await getTripStore().get("t-save");
    expect(reread).toEqual(saved);
  });

  // ---------------------------------------------------------------- readPlanned

  it("readPlanned returns the stored plan without recomputing when the hash matches", async () => {
    const doc = baseDoc("t-read-fresh");
    const saved = await savePlanned(doc);

    const spy = jest.spyOn(planServiceModule, "planTripDay");
    const read = await readPlanned("t-read-fresh");

    expect(spy).not.toHaveBeenCalled();
    expect(read).toEqual(saved);
  });

  it("readPlanned returns null for a trip that doesn't exist", async () => {
    expect(await readPlanned("nope-does-not-exist")).toBeNull();
  });

  it("a legacy doc (no plan field) self-heals exactly once and persists the healed doc", async () => {
    const doc = baseDoc("t-legacy");
    // Bypass planStore entirely — simulates a pre-E4 doc already on disk.
    await getTripStore().put(doc);

    const healed = await readPlanned("t-legacy");
    expect(healed).not.toBeNull();
    expect(healed!.plan).toBeDefined();
    expect(healed!.plan!.solveHash).toBe(computeSolveHash(doc));

    const reread = await getTripStore().get("t-legacy");
    expect(reread?.plan).toEqual(healed!.plan);

    // "exactly once": a second read with a matching hash must not recompute.
    const spy = jest.spyOn(planServiceModule, "planTripDay");
    const readAgain = await readPlanned("t-legacy");
    expect(spy).not.toHaveBeenCalled();
    expect(readAgain).toEqual(healed);
  });

  it("a tampered doc (stops changed, solveHash now stale) self-heals on read", async () => {
    const doc = baseDoc("t-tamper");
    const saved = await savePlanned(doc);

    // Mutate a solve-relevant field (duration) WITHOUT updating solveHash —
    // simulates corruption / a write that bypassed planStore's chokepoint.
    // Written straight to disk: fileStore.put() itself refuses to persist a
    // doc whose plan.solveHash is stale (the dev/test invariant under test
    // separately below), so a direct put() here would throw before the
    // scenario could even be set up.
    const tampered: TripDoc = {
      ...saved,
      days: [{ ...saved.days[0], stops: saved.days[0].stops.map((s) => ({ ...s, durationMin: 999 })) }],
    };
    fs.writeFileSync(path.join(tmpDir, "t-tamper.json"), JSON.stringify(tampered));

    const healed = await readPlanned("t-tamper");
    expect(healed).not.toBeNull();
    expect(healed!.plan!.solveHash).toBe(computeSolveHash(tampered));
    expect(healed!.plan!.solveHash).not.toBe(tampered.plan!.solveHash);

    const reread = await getTripStore().get("t-tamper");
    expect(reread?.plan?.solveHash).toBe(healed!.plan!.solveHash);
  });

  // ---------------------------------------------------------------- solveHash

  // ------------------------------------------- rejected-day retry (audit finding 1)

  it("a stored plan with a rejected day is served as-is while FRESH (hot-loop guard)", async () => {
    const doc = baseDoc("t-rej-fresh");
    const saved = await savePlanned(doc);
    // Manufacture a matching-hash plan whose one day is rejected, stamped NOW.
    const rejected: TripDoc = {
      ...saved,
      plan: {
        ...saved.plan!,
        computedAt: new Date().toISOString(),
        days: [{ status: "rejected", message: "transient blip" }],
      },
    };
    // Bypass the chokepoint deliberately (simulates the persisted result of a
    // savePlanned that hit a transient failure) — write the raw file.
    fs.writeFileSync(path.join(tmpDir, "t-rej-fresh.json"), JSON.stringify(rejected));

    // E5b: a real recompute now goes through planEngine.planTripWithEngine
    // (one whole-trip engine call), not per-day planService.planTripDay.
    const spy = jest.spyOn(planEngineModule, "planTripWithEngine");
    const read = await readPlanned("t-rej-fresh");
    expect(spy).not.toHaveBeenCalled(); // fresh rejection: no thrash
    expect(read!.plan!.days[0].status).toBe("rejected");
  });

  it("a stored plan with a rejected day HEALS once it has aged past the retry window", async () => {
    const doc = baseDoc("t-rej-aged");
    const saved = await savePlanned(doc);
    const rejected: TripDoc = {
      ...saved,
      plan: {
        ...saved.plan!,
        computedAt: new Date(Date.now() - 6 * 60_000).toISOString(), // aged 6min > 5min window
        days: [{ status: "rejected", message: "transient blip, long ago" }],
      },
    };
    fs.writeFileSync(path.join(tmpDir, "t-rej-aged.json"), JSON.stringify(rejected));

    // E5c: the retry is now DAY-SCOPED (solveIncremental sees a hash match
    // but a non-"ok" stored status, and solves just that day via
    // planEngine.solveDayWithEngine) rather than a whole-trip
    // planTripWithEngine call — pin the new call site, not the old one.
    const spy = jest.spyOn(planEngineModule, "solveDayWithEngine");
    const wholeTripSpy = jest.spyOn(planEngineModule, "planTripWithEngine");
    const read = await readPlanned("t-rej-aged");
    expect(spy).toHaveBeenCalledTimes(1); // aged rejection: retried, scoped to the one day
    expect(wholeTripSpy).not.toHaveBeenCalled();
    expect(read!.plan!.days[0].status).toBe("ok"); // fixture solve succeeds now
    // ...and the heal persisted (subsequent read is quiet).
    spy.mockClear();
    const again = await readPlanned("t-rej-aged");
    expect(spy).not.toHaveBeenCalled();
    expect(again!.plan!.days[0].status).toBe("ok");
  });

  describe("computeSolveHash / solveProjection", () => {
    it("ignores legOverrides", () => {
      const a = baseDoc("t-hash-1");
      const b: TripDoc = {
        ...a,
        legOverrides: [{ dayIndex: 0, fromId: "fx-01", toId: "fx-02", mode: "drive" }],
      };
      expect(computeSolveHash(a)).toBe(computeSolveHash(b));
    });

    it("ignores display-only fields: stop name/address/source and day dayLabel", () => {
      const a = baseDoc("t-hash-2");
      const b: TripDoc = {
        ...a,
        days: [
          {
            ...a.days[0],
            dayLabel: "Day 1 (a Tuesday, probably)",
            stops: a.days[0].stops.map((s) => ({
              ...s,
              name: "A totally different display name",
              address: "123 Somewhere Else",
              source: "https://example.com/whatever",
            })),
          },
        ],
      };
      expect(computeSolveHash(a)).toBe(computeSolveHash(b));
    });

    it("changes when a stop's location changes", () => {
      const a = baseDoc("t-hash-3");
      const b: TripDoc = {
        ...a,
        days: [
          {
            ...a.days[0],
            stops: a.days[0].stops.map((s, i) =>
              i === 0 ? { ...s, location: { lat: s.location.lat + 1, lng: s.location.lng } } : s
            ),
          },
        ],
      };
      expect(computeSolveHash(a)).not.toBe(computeSolveHash(b));
    });

    it("changes when a stop's durationMin changes", () => {
      const a = baseDoc("t-hash-4");
      const b: TripDoc = {
        ...a,
        days: [
          {
            ...a.days[0],
            stops: a.days[0].stops.map((s, i) => (i === 0 ? { ...s, durationMin: s.durationMin + 15 } : s)),
          },
        ],
      };
      expect(computeSolveHash(a)).not.toBe(computeSolveHash(b));
    });

    it("changes when an anchor is added, removed, or its time changes", () => {
      const a = baseDoc("t-hash-5");
      const withAnchor: TripDoc = {
        ...a,
        days: [
          {
            ...a.days[0],
            stops: a.days[0].stops.map((s, i) => (i === 0 ? { ...s, anchor: { startMin: 600 } } : s)),
          },
        ],
      };
      const differentAnchorTime: TripDoc = {
        ...a,
        days: [
          {
            ...a.days[0],
            stops: a.days[0].stops.map((s, i) => (i === 0 ? { ...s, anchor: { startMin: 700 } } : s)),
          },
        ],
      };
      expect(computeSolveHash(a)).not.toBe(computeSolveHash(withAnchor));
      expect(computeSolveHash(withAnchor)).not.toBe(computeSolveHash(differentAnchorTime));
    });

    it("changes when settings.walkMax or settings.driveOverheadMin change", () => {
      const a = baseDoc("t-hash-6");
      const b: TripDoc = { ...a, settings: { ...a.settings, walkMax: a.settings.walkMax + 5 } };
      const c: TripDoc = { ...a, settings: { ...a.settings, driveOverheadMin: a.settings.driveOverheadMin + 5 } };
      expect(computeSolveHash(a)).not.toBe(computeSolveHash(b));
      expect(computeSolveHash(a)).not.toBe(computeSolveHash(c));
    });

    it("changes when manualOrder is set, changed, or cleared", () => {
      const a = baseDoc("t-hash-7");
      const withOrder: TripDoc = {
        ...a,
        days: [{ ...a.days[0], manualOrder: ["fx-04", "fx-03", "fx-02", "fx-01"] }],
      };
      const differentOrder: TripDoc = {
        ...a,
        days: [{ ...a.days[0], manualOrder: ["fx-01", "fx-02", "fx-03", "fx-04"] }],
      };
      expect(computeSolveHash(a)).not.toBe(computeSolveHash(withOrder));
      expect(computeSolveHash(withOrder)).not.toBe(computeSolveHash(differentOrder));
      expect(computeSolveHash(differentOrder)).not.toBe(computeSolveHash(a));
    });

    it("changes when precedence is added or its pair changes", () => {
      const a = baseDoc("t-hash-8");
      const withPrecedence: TripDoc = {
        ...a,
        days: [{ ...a.days[0], precedence: [{ beforeId: "fx-01", afterId: "fx-02" }] }],
      };
      const differentPrecedence: TripDoc = {
        ...a,
        days: [{ ...a.days[0], precedence: [{ beforeId: "fx-02", afterId: "fx-03" }] }],
      };
      expect(computeSolveHash(a)).not.toBe(computeSolveHash(withPrecedence));
      expect(computeSolveHash(withPrecedence)).not.toBe(computeSolveHash(differentPrecedence));
    });

    it("changes on date, day window, stop id, and stop add/remove/reorder (audit finding 4)", () => {
      const base = computeSolveHash(baseDoc("t"));
      expect(computeSolveHash(baseDoc("t", { date: "2026-07-06" }))).not.toBe(base);
      expect(computeSolveHash(baseDoc("t", { dayStartMin: 600 }))).not.toBe(base);
      expect(computeSolveHash(baseDoc("t", { dayEndMin: 1200 }))).not.toBe(base);

      const swapped = baseDoc("t");
      // stop id changes (same location/duration — the id IS solver-relevant:
      // it keys the matrix and precedence)
      swapped.days[0].stops[0] = { ...swapped.days[0].stops[0], id: "fx-05" };
      expect(computeSolveHash(swapped)).not.toBe(base);

      const removed = baseDoc("t");
      removed.days[0].stops = removed.days[0].stops.slice(0, 3);
      expect(computeSolveHash(removed)).not.toBe(base);

      const reordered = baseDoc("t");
      reordered.days[0].stops = [...reordered.days[0].stops].reverse();
      expect(computeSolveHash(reordered)).not.toBe(base);
    });

    it("ignores duplicateOf (display-only duplicate flag)", () => {
      const base = computeSolveHash(baseDoc("t"));
      const flagged = baseDoc("t");
      flagged.days[0].stops[1] = { ...flagged.days[0].stops[1], duplicateOf: "fx-01" };
      expect(computeSolveHash(flagged)).toBe(base);
    });

    it("solveProjection is stable regardless of key insertion order (canonical JSON)", () => {
      const a = baseDoc("t-hash-9");
      // Same content, keys assembled in a different order.
      const b: TripDoc = {
        legOverrides: [],
        settings: { driveOverheadMin: 10, walkMax: 10 },
        tripId: "t-hash-9",
        days: [
          {
            stops: a.days[0].stops,
            dayEndMin: 1320,
            dayStartMin: 540,
            date: "2026-07-05",
          },
        ],
      };
      expect(computeSolveHash(a)).toBe(computeSolveHash(b));
      expect(solveProjection(a)).toEqual(solveProjection(b));
    });
  });

  // ---------------------------------------------------------------- stampPlan / persistPlanned

  it("stampPlan is pure (no I/O) and persistPlanned writes the given plans as-is, without recomputing", async () => {
    const doc = baseDoc("t-persist");
    const days = await Promise.all(doc.days.map((_, i) => planServiceModule.planTripDay(doc, i)));
    const engine = { name: ENGINE_NAME, version: ENGINE_VERSION, seed: seedFor(doc) };

    const stamped = stampPlan(doc, days, engine);
    expect(stamped.plan!.days).toBe(days); // same array reference — not recomputed
    expect(stamped.plan!.engine).toEqual(engine);
    expect(stamped.plan!.solveHash).toBe(computeSolveHash(doc));
    expect(await getTripStore().get("t-persist")).toBeNull(); // stampPlan alone never writes

    const spy = jest.spyOn(planServiceModule, "planTripDay");
    const persisted = await persistPlanned(doc, days, engine);
    expect(spy).not.toHaveBeenCalled(); // persistPlanned never recomputes either
    expect(persisted.plan!.days).toBe(days);
    expect(await getTripStore().get("t-persist")).toEqual(persisted);
  });

  // ---------------------------------------------------------------- fileStore invariant

  it("fileStore.put throws when doc.plan.solveHash is stale (dev/test loud-failure invariant)", async () => {
    const doc = baseDoc("t-invariant");
    const saved = await savePlanned(doc);

    const tampered: TripDoc = {
      ...saved,
      days: [{ ...saved.days[0], stops: saved.days[0].stops.map((s) => ({ ...s, durationMin: 5 })) }],
    };
    expect(tampered.plan!.solveHash).not.toBe(computeSolveHash(tampered));

    await expect(getTripStore().put(tampered)).rejects.toThrow(/solveHash is stale/);
  });

  // ---------------------------------------------------------------- E3 hours advisory

  describe("savePlanned — opening-hours advisory (E3)", () => {
    // Guildhall Museum (fx-03) is hand-written in fixtureCity.ts as
    // Monday-closed, open 09:00-17:00 the rest of the week.
    const guildhall = FIXTURE_STOPS.find((f) => f.id === "fx-03")!;

    it("adds a margin note for a stop visited on its closed weekday", async () => {
      const doc = baseDoc("t-hours-closed", {
        date: "2026-03-16", // a real, verified Monday
        stops: [stop("fx-03")],
      });
      const saved = await savePlanned(doc);
      const day0 = saved.plan!.days[0];
      expect(day0.status).toBe("ok");
      if (day0.status !== "ok") return;
      expect(day0.marginNotes).toEqual([
        `Heads up — ${guildhall.name} looks closed on Mondays.`,
      ]);
    });

    it("adds no margin note when the stop is open at the visited time", async () => {
      const doc = baseDoc("t-hours-open", {
        date: "2026-03-17", // the following Tuesday — fx-03 is open 09:00-17:00
        stops: [stop("fx-03")],
      });
      const saved = await savePlanned(doc);
      const day0 = saved.plan!.days[0];
      expect(day0.status).toBe("ok");
      if (day0.status !== "ok") return;
      expect(day0.marginNotes ?? []).toEqual([]);
    });

    it("skips the check when the day carries a dayLabel, even on a closed weekday date", async () => {
      const doc = baseDoc("t-hours-label", {
        date: "2026-03-16", // Monday — would otherwise trigger the note
        dayLabel: "Day 1",
        stops: [stop("fx-03")],
      });
      const saved = await savePlanned(doc);
      const day0 = saved.plan!.days[0];
      expect(day0.status).toBe("ok");
      if (day0.status !== "ok") return;
      expect(day0.marginNotes ?? []).toEqual([]);
    });
  });

  it("fileStore.put allows a doc with a correct solveHash, and one with no plan at all", async () => {
    const doc = baseDoc("t-invariant-ok");
    const saved = await savePlanned(doc); // already round-tripped through put() once, successfully

    await expect(getTripStore().put(saved)).resolves.toBeUndefined();

    const withoutPlan = baseDoc("t-invariant-ok-2");
    await expect(getTripStore().put(withoutPlan)).resolves.toBeUndefined();
  });
});

// E3 audit minor 3 -> E5b MUST-DO 1: the story flips here. At E3, the
// no-mass-staleness argument rested on hours being OUTSIDE the solve
// projection because the legacy solver never read them (see this test's own
// git history for the old assertion, which pinned the OPPOSITE fact). Now
// that planEngine.ts's engine compiles TripStop.hours into hard, day-concrete
// constraints (src/lib/engine/problem.ts's `hoursFromDoc`), a hours-only edit
// can change what the engine solves — so solveHash MUST change too, or a
// corrected opening time would silently serve a stale plan built against the
// wrong hours. This is also what stales every pre-E5b stored plan exactly
// once (see plan/solveProjection.ts's header) — a one-time, zero-spend heal
// on next read, not a migration.
it("adding hours to a stop changes solveHash (E5b — hours are load-bearing on the engine)", () => {
  const plain = baseDoc("t-hours-hash");
  const withHours: TripDoc = {
    ...plain,
    days: [
      {
        ...plain.days[0],
        stops: plain.days[0].stops.map((s) => ({
          ...s,
          hours: { byWeekday: [[], [], [], [], [], [], []] },
        })),
      },
    ],
  };
  expect(computeSolveHash(withHours)).not.toBe(computeSolveHash(plain));
});

// ---------------------------------------------------------------------------
// E5b audit F9: the toggle fast path — the most delicate branch in the live
// save path — pinned directly. Plus F5/F6 regressions.
// ---------------------------------------------------------------------------
describe("toggle fast path (E5b)", () => {
  let tmpDir: string;
  let prevMapsProvider: string | undefined;
  let prevTripsDir: string | undefined;

  beforeEach(() => {
    prevMapsProvider = process.env.MAPS_PROVIDER;
    prevTripsDir = process.env.TRIPS_DIR;
    process.env.MAPS_PROVIDER = "fixture";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "planstore-fast-"));
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
  it("a legacy-engine stored plan MISSES the fast path and re-solves", async () => {
    const doc = baseDoc("t-fast-legacy");
    const saved = await savePlanned(doc);
    // Rewrite the stored plan as if stamped by the old engine, hash intact.
    const legacy: TripDoc = {
      ...saved,
      plan: { ...saved.plan!, engine: { name: "legacy-exhaustive", version: "1", seed: 0 } },
    };
    fs.writeFileSync(path.join(tmpDir, "t-fast-legacy.json"), JSON.stringify(legacy));

    const resaved = await savePlanned({ ...doc, legOverrides: [] });
    // Fast path requires engine.name === current engine — a legacy stamp must
    // force a real re-plan, which restamps with the current engine name.
    expect(resaved.plan!.engine.name).not.toBe("legacy-exhaustive");
  });

  it("carries conflicts/proposals forward across a fast-path retime", async () => {
    const doc = baseDoc("t-fast-carry");
    const saved = await savePlanned(doc);
    // Plant a conflict on the stored plan (hash still matches — conflicts are
    // not part of the projection).
    const withConflict: TripDoc = {
      ...saved,
      plan: {
        ...saved.plan!,
        conflicts: [
          {
            id: "c1",
            code: "hours",
            message: "planted conflict for the carry-forward pin",
            stopIds: ["fx-03"],
            violatedByMin: 0,
            constraintRef: { path: "stops.fx-03.hours", provenance: { source: "google" } },
          },
        ],
      },
    };
    fs.writeFileSync(path.join(tmpDir, "t-fast-carry.json"), JSON.stringify(withConflict));

    // A pure legOverrides change hits the fast path (same solveHash)...
    const spy = jest.spyOn(planServiceModule, "planTripDay");
    const toggled = await savePlanned({ ...doc });
    expect(spy).not.toHaveBeenCalled(); // engine bypassed entirely
    // ...and the planted conflict survives the retime (a toggle must not erase
    // a real constraint conflict from the UI).
    expect(toggled.plan!.conflicts).toHaveLength(1);
    expect(toggled.plan!.conflicts![0].id).toBe("c1");
  });

  it("ignores the INCOMING doc's plan — the store's copy is the only honest prior (F6)", async () => {
    const doc = baseDoc("t-fast-forged");
    await savePlanned(doc);
    // A crafted client PUT carries a fabricated plan with a hostile order that
    // would throw inside rescheduleDay if trusted (non-permutation), plus a
    // fake quality label. savePlanned must consult the STORE's prior instead.
    const forged: TripDoc = {
      ...doc,
      plan: {
        version: 1,
        engine: { name: "alns-ts", version: "999", seed: 1 },
        computedAt: new Date().toISOString(),
        solveHash: computeSolveHash(doc),
        days: [
          {
            status: "ok",
            order: ["nope", "nope", "nope"],
            entries: [],
            legs: [],
            quality: "optimal",
            totalTravelMin: 0,
            daySlackMin: 9999,
          },
        ],
      },
    };
    const result = await savePlanned(forged);
    // Not a throw, and not the forged content: the honest stored order wins.
    expect(result.plan!.days[0].status).toBe("ok");
    const day0 = result.plan!.days[0];
    if (day0.status === "ok") {
      expect(day0.order).not.toEqual(["nope", "nope", "nope"]);
      expect(day0.order.length).toBe(4);
    }
  });
});

// ---------------------------------------------------------------------------
// E5c — day-scoped solving (STATE.md's "CHRIS DECISIONS on the E5b product
// flags"): an ordinary edit re-solves ONLY the day it touched; a settings
// edit stales every day but each still solves day-scoped, independently;
// explicit re-cook (day/trip scope) is the only place a fresh solve happens
// without a hash mismatch driving it.
// ---------------------------------------------------------------------------
describe("day-scoped solving (E5c)", () => {
  let tmpDir: string;
  let prevMapsProvider: string | undefined;
  let prevTripsDir: string | undefined;

  beforeEach(() => {
    prevMapsProvider = process.env.MAPS_PROVIDER;
    prevTripsDir = process.env.TRIPS_DIR;
    process.env.MAPS_PROVIDER = "fixture";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "planstore-dayscope-"));
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

  // A 3-day doc, two stops each, from three different (mutually feasible —
  // the fixture city's drive matrix is total) fixture clusters, so each
  // day's engine problem is small, fast, and easy to tell apart by node count.
  const threeDayDoc = (tripId: string): TripDoc => ({
    tripId,
    days: [
      { date: "2026-07-05", dayStartMin: 540, dayEndMin: 1320, stops: [stop("fx-01"), stop("fx-02")] },
      { date: "2026-07-06", dayStartMin: 540, dayEndMin: 1320, stops: [stop("fx-05"), stop("fx-06")] },
      { date: "2026-07-07", dayStartMin: 540, dayEndMin: 1320, stops: [stop("fx-09"), stop("fx-10")] },
    ],
    settings: { walkMax: 10, driveOverheadMin: 10 },
    legOverrides: [],
  });

  it("editing day 1 (0-indexed 0) of a 3-day doc re-solves ONLY that day", async () => {
    const doc = threeDayDoc("t-scope-edit");
    const saved = await savePlanned(doc);
    expect(saved.plan!.days.every((d) => d.status === "ok")).toBe(true);

    // Solve-relevant edit confined to day 0 (a duration bump).
    const edited: TripDoc = {
      ...saved,
      days: saved.days.map((d, i) =>
        i === 0 ? { ...d, stops: d.stops.map((s, j) => (j === 0 ? { ...s, durationMin: s.durationMin + 15 } : s)) } : d
      ),
    };
    // Only day 0's own projection/hash may change.
    expect(computeDayHash(edited, 0)).not.toBe(computeDayHash(saved, 0));
    expect(computeDayHash(edited, 1)).toBe(computeDayHash(saved, 1));
    expect(computeDayHash(edited, 2)).toBe(computeDayHash(saved, 2));

    const solveSpy = jest.spyOn(alnsEngine, "solve");
    const resaved = await savePlanned(edited);

    expect(solveSpy).toHaveBeenCalledTimes(1); // exactly one engine call
    const problemArg = solveSpy.mock.calls[0][0];
    expect(problemArg.nodes.length).toBe(2); // ONLY day 0's 2 stops reached the engine

    // Days 2 and 3 (untouched) are the SAME stored DayPlan objects, not
    // recomputed — reference-equal, which also proves deep-equal.
    expect(resaved.plan!.days[1]).toEqual(saved.plan!.days[1]);
    expect(resaved.plan!.days[2]).toEqual(saved.plan!.days[2]);
    expect(resaved.plan!.days[0]).not.toEqual(saved.plan!.days[0]);
  });

  it("a settings change stales every day but solves each one day-scoped (not one joint call)", async () => {
    const doc = threeDayDoc("t-scope-settings");
    const saved = await savePlanned(doc);

    const edited: TripDoc = { ...saved, settings: { ...saved.settings, walkMax: saved.settings.walkMax + 1 } };
    for (let i = 0; i < 3; i++) {
      expect(computeDayHash(edited, i)).not.toBe(computeDayHash(saved, i));
    }

    const solveSpy = jest.spyOn(alnsEngine, "solve");
    const resaved = await savePlanned(edited);

    // Three SEPARATE day-scoped calls, not one joint whole-trip call — each
    // problem argument only ever contains ONE day's worth of nodes (2).
    expect(solveSpy).toHaveBeenCalledTimes(3);
    for (const call of solveSpy.mock.calls) {
      expect(call[0].nodes.length).toBe(2);
    }
    expect(resaved.plan!.days.every((d) => d.status === "ok")).toBe(true);
  });

  it("a pure legOverrides toggle stays on the fast path — no engine call at all", async () => {
    const doc = threeDayDoc("t-scope-toggle");
    const saved = await savePlanned(doc);

    const toggled: TripDoc = {
      ...saved,
      legOverrides: [{ dayIndex: 0, fromId: "fx-01", toId: "fx-02", mode: "drive" }],
    };
    const solveSpy = jest.spyOn(alnsEngine, "solve");
    const resaved = await savePlanned(toggled);

    expect(solveSpy).not.toHaveBeenCalled();
    expect(resaved.plan!.solveHash).toBe(saved.plan!.solveHash); // legOverrides isn't in the projection
  });

  it("recookDay clears a manual order and hands that day back to a fresh engine solve", async () => {
    const doc = threeDayDoc("t-recook-manual");
    const withManual: TripDoc = {
      ...doc,
      days: doc.days.map((d, i) => (i === 0 ? { ...d, manualOrder: ["fx-02", "fx-01"] } : d)),
    };
    const saved = await savePlanned(withManual);
    expect(saved.plan!.days[0]).toMatchObject({ status: "ok", quality: "manual", order: ["fx-02", "fx-01"] });

    const solveSpy = jest.spyOn(alnsEngine, "solve");
    const recooked = await recookDay(saved, 0);

    expect(recooked.days[0].manualOrder).toBeUndefined(); // cleared on the DOC itself
    expect(solveSpy).toHaveBeenCalledTimes(1); // handed back to the engine
    expect(recooked.plan!.days[0].status).toBe("ok");
    if (recooked.plan!.days[0].status === "ok") {
      expect(recooked.plan!.days[0].quality).not.toBe("manual");
    }
    // Other days untouched — same stored DayPlan objects.
    expect(recooked.plan!.days[1]).toEqual(saved.plan!.days[1]);
    expect(recooked.plan!.days[2]).toEqual(saved.plan!.days[2]);
  });

  it("recookDay force-solves even when nothing changed — ignores an already-matching hash", async () => {
    const doc = threeDayDoc("t-recook-force");
    const saved = await savePlanned(doc);
    expect(saved.plan!.days[0].status).toBe("ok");

    const solveSpy = jest.spyOn(alnsEngine, "solve");
    const recooked = await recookDay(saved, 0);

    // day 0's hash is UNCHANGED (nothing was edited) — a plain incremental
    // save would have kept it verbatim and never called the engine at all.
    expect(computeDayHash(recooked, 0)).toBe(computeDayHash(saved, 0));
    expect(solveSpy).toHaveBeenCalledTimes(1); // forced anyway
    expect(recooked.plan!.days[1]).toEqual(saved.plan!.days[1]);
    expect(recooked.plan!.days[2]).toEqual(saved.plan!.days[2]);
  });

  it("recookTrip clears every manual order and runs one joint whole-trip solve", async () => {
    const doc = threeDayDoc("t-recook-trip");
    const withManual: TripDoc = {
      ...doc,
      days: doc.days.map((d, i) => (i !== 1 ? { ...d, manualOrder: [...d.stops].reverse().map((s) => s.id) } : d)),
    };
    const saved = await savePlanned(withManual);
    expect(saved.days[0].manualOrder).toBeDefined();
    expect(saved.days[2].manualOrder).toBeDefined();

    const solveSpy = jest.spyOn(alnsEngine, "solve");
    const recooked = await recookTrip(saved);

    expect(solveSpy).toHaveBeenCalledTimes(1); // ONE joint call, not one per day
    const problemArg = solveSpy.mock.calls[0][0];
    expect(problemArg.nodes.length).toBe(6); // every day's stops in play at once
    expect(recooked.days.every((d) => d.manualOrder === undefined)).toBe(true);
    expect(recooked.plan!.days.every((d) => d.status === "ok")).toBe(true);
  });

  it("a tampered SINGLE day in a multi-day doc heals just that day", async () => {
    const doc = threeDayDoc("t-heal-single");
    const saved = await savePlanned(doc);

    const tampered: TripDoc = {
      ...saved,
      days: saved.days.map((d, i) =>
        i === 1 ? { ...d, stops: d.stops.map((s, j) => (j === 0 ? { ...s, durationMin: 999 } : s)) } : d
      ),
    };
    fs.writeFileSync(path.join(tmpDir, "t-heal-single.json"), JSON.stringify(tampered));

    const spy = jest.spyOn(planEngineModule, "solveDayWithEngine");
    const wholeTripSpy = jest.spyOn(planEngineModule, "planTripWithEngine");
    const healed = await readPlanned("t-heal-single");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(wholeTripSpy).not.toHaveBeenCalled();
    expect(healed!.plan!.days[0]).toEqual(saved.plan!.days[0]);
    expect(healed!.plan!.days[2]).toEqual(saved.plan!.days[2]);
    expect(healed!.plan!.days[1].status).toBe("ok");
    expect(healed!.plan!.solveHash).toBe(computeSolveHash(tampered));
  });

  // ------------------------------------------------------ fileStore invariant

  it("fileStore.put throws when dayHashes is present but the wrong length", async () => {
    const doc = threeDayDoc("t-invariant-length");
    const saved = await savePlanned(doc);
    const bad: TripDoc = { ...saved, plan: { ...saved.plan!, dayHashes: saved.plan!.dayHashes!.slice(0, 2) } };
    await expect(getTripStore().put(bad)).rejects.toThrow(/dayHashes/);
  });

  it("fileStore.put throws when a dayHash doesn't match the recomputed value", async () => {
    const doc = threeDayDoc("t-invariant-mismatch");
    const saved = await savePlanned(doc);
    const bad: TripDoc = {
      ...saved,
      plan: {
        ...saved.plan!,
        dayHashes: saved.plan!.dayHashes!.map((h, i) => (i === 1 ? "deadbeef" : h)),
      },
    };
    await expect(getTripStore().put(bad)).rejects.toThrow(/dayHashes/);
  });

  it("fileStore.put allows a doc whose dayHashes are absent (pre-E5c shape)", async () => {
    const doc = threeDayDoc("t-invariant-legacy-shape");
    const saved = await savePlanned(doc);
    const { dayHashes: _drop, ...planWithoutDayHashes } = saved.plan!;
    const legacyShaped: TripDoc = { ...saved, plan: planWithoutDayHashes as TripDoc["plan"] };
    await expect(getTripStore().put(legacyShaped)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// E5c audit F1 + F2 — both repro'd by the auditor, pinned here.
// ---------------------------------------------------------------------------
describe("E5c audit regressions", () => {
  let tmpDir: string;
  let prevMapsProvider: string | undefined;
  let prevTripsDir: string | undefined;

  beforeEach(() => {
    prevMapsProvider = process.env.MAPS_PROVIDER;
    prevTripsDir = process.env.TRIPS_DIR;
    process.env.MAPS_PROVIDER = "fixture";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "planstore-e5c-audit-"));
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

  // F1: the auditor's exact repro — fx-05 (day 1) wished before fx-01 (day 0).
  const crossDayDoc = (tripId: string): TripDoc => ({
    tripId,
    days: [
      {
        date: "2026-07-05",
        dayStartMin: 540,
        dayEndMin: 1320,
        stops: [stop("fx-01"), stop("fx-02")],
      },
      {
        date: "2026-07-06",
        dayStartMin: 540,
        dayEndMin: 1320,
        stops: [stop("fx-05"), stop("fx-06")],
        precedence: [{ beforeId: "fx-05", afterId: "fx-01" }],
      },
    ],
    settings: { walkMax: 10, driveOverheadMin: 10 },
    legOverrides: [],
  });

  it("F1: the cross-day precedence note survives a day-scoped incremental save", async () => {
    const doc = crossDayDoc("t-f1-note");
    const saved = await savePlanned(doc);

    const noteOn = (d: TripDoc, i: number): string[] => {
      const day = d.plan!.days[i];
      return day.status === "ok" ? (day.marginNotes ?? []) : [];
    };
    // The wish (day-1 stop before day-0 stop) is violated by the day
    // assignment; the note lives on the BEFORE endpoint's day (day 1).
    expect(noteOn(saved, 1).some((n) => n.startsWith("Worth noting — "))).toBe(true);

    // Edit day 0 (duration change) → day-scoped save; the note must SURVIVE.
    const edited: TripDoc = {
      ...saved,
      days: [
        { ...saved.days[0], stops: saved.days[0].stops.map((s) => ({ ...s, durationMin: 45 })) },
        saved.days[1],
      ],
    };
    const resaved = await savePlanned(edited);
    expect(noteOn(resaved, 1).some((n) => n.startsWith("Worth noting — "))).toBe(true);

    // Remove the wish → the note disappears (not carried stale).
    const { precedence: _drop, ...day1NoPrec } = resaved.days[1];
    const satisfied: TripDoc = { ...resaved, days: [resaved.days[0], day1NoPrec] };
    const resatisfied = await savePlanned(satisfied);
    expect(noteOn(resatisfied, 1).some((n) => n.startsWith("Worth noting — "))).toBe(false);
  });

  it("F2: a toggle is honoured even when another day's stored plan is rejected", async () => {
    // Two walkable old-town stops -> at least one eligible walk leg.
    const doc = baseDoc("t-f2-toggle");
    const saved = await savePlanned(doc);
    const day0 = saved.plan!.days[0];
    if (day0.status !== "ok") throw new Error("expected ok");
    const walkLeg = day0.legs.find((l) => l.mode === "walk");
    expect(walkLeg).toBeDefined();

    // Mark a phantom second day rejected in the stored plan (declines the
    // toggle fast path), matching hashes for day 0.
    const twoDay: TripDoc = {
      ...saved,
      days: [saved.days[0], { date: "2026-07-06", dayStartMin: 540, dayEndMin: 1320, stops: [] }],
    };
    const restamped = await savePlanned(twoDay);
    const broken: TripDoc = {
      ...restamped,
      plan: {
        ...restamped.plan!,
        days: [restamped.plan!.days[0], { status: "rejected", message: "transient blip" }],
      },
    };
    fs.writeFileSync(path.join(tmpDir, "t-f2-toggle.json"), JSON.stringify(broken));

    // Toggle the walk leg to drive. Fast path declines (rejected day) — the
    // kept day must STILL be retimed with the new override.
    const toggled: TripDoc = {
      ...broken,
      legOverrides: [{ dayIndex: 0, fromId: walkLeg!.fromId, toId: walkLeg!.toId, mode: "drive" }],
    };
    const resaved = await savePlanned(toggled);
    const resavedDay0 = resaved.plan!.days[0];
    if (resavedDay0.status !== "ok") throw new Error("expected ok");
    const leg = resavedDay0.legs.find(
      (l) => l.fromId === walkLeg!.fromId && l.toId === walkLeg!.toId
    );
    expect(leg?.mode).toBe("drive");
    expect(leg?.chosenBy).toBe("user");
  });
});
