// E4 — plan persistence: solve once, store, read back. Fixture mode only
// (mirrors pipeline.test.ts's isolation: fresh TRIPS_DIR temp dir per test,
// MAPS_PROVIDER=fixture — no live Maps/LLM calls are ever made here).

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { savePlanned, readPlanned, stampPlan, persistPlanned } from "../planStore";
import { solveProjection, computeSolveHash } from "../plan/solveProjection";
import * as planServiceModule from "../planService";
import { getTripStore } from "../config";
import type { TripDoc, TripStop } from "../store/types";
import { FIXTURE_STOPS } from "../maps/fixtureCity";

const stop = (id: string, extra: Partial<TripStop> = {}): TripStop => {
  const f = FIXTURE_STOPS.find((s) => s.id === id)!;
  return { id: f.id, name: f.name, location: f.location, durationMin: 60, ...extra };
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
    expect(saved.plan!.engine).toEqual({ name: "legacy-exhaustive", version: "1", seed: 0 });
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

    const spy = jest.spyOn(planServiceModule, "planTripDay");
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

    const spy = jest.spyOn(planServiceModule, "planTripDay");
    const read = await readPlanned("t-rej-aged");
    expect(spy).toHaveBeenCalled(); // aged rejection: retried
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

    const stamped = stampPlan(doc, days);
    expect(stamped.plan!.days).toBe(days); // same array reference — not recomputed
    expect(stamped.plan!.solveHash).toBe(computeSolveHash(doc));
    expect(await getTripStore().get("t-persist")).toBeNull(); // stampPlan alone never writes

    const spy = jest.spyOn(planServiceModule, "planTripDay");
    const persisted = await persistPlanned(doc, days);
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

  it("fileStore.put allows a doc with a correct solveHash, and one with no plan at all", async () => {
    const doc = baseDoc("t-invariant-ok");
    const saved = await savePlanned(doc); // already round-tripped through put() once, successfully

    await expect(getTripStore().put(saved)).resolves.toBeUndefined();

    const withoutPlan = baseDoc("t-invariant-ok-2");
    await expect(getTripStore().put(withoutPlan)).resolves.toBeUndefined();
  });
});
