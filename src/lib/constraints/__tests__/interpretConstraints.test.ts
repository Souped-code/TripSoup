// E7 — the compile orchestrator: gated selection, the hallucination tether,
// stop resolution, and wire conversion — all through the FIXTURE adapter
// (MAPS_PROVIDER=fixture), which emits the same evidence contract the live
// model is held to.

import { compileConstraintPatch } from "../interpret/interpretConstraints";
import { LLM_SOFT_WEIGHT } from "../persisted";
import { createEntitlements, ALL_CAPABILITIES } from "../../entitlements/entitlements";
import type { TripDoc } from "../../store/types";

const allOn = createEntitlements({
  tier: "pass",
  capabilities: ALL_CAPABILITIES,
  maxStops: 40,
  watermark: false,
});
const noConstraints = createEntitlements({
  tier: "free",
  capabilities: ALL_CAPABILITIES.filter((c) => c !== "interpret.constraints"),
  maxStops: 40,
  watermark: false,
});

const doc = (): TripDoc => ({
  tripId: "t-e7-interpret",
  days: [
    {
      date: "2026-07-06",
      dayStartMin: 540,
      dayEndMin: 1320,
      stops: [
        { id: "fx-01", name: "Market Hall", location: { lat: 51.45, lng: -2.6 }, durationMin: 60 },
        {
          id: "fx-03",
          name: "Guildhall Museum",
          location: { lat: 51.4491, lng: -2.5979 },
          durationMin: 60,
          hours: {
            byWeekday: [[], [{ startMin: 540, endMin: 1020 }], [], [], [], [], []],
          },
        },
      ],
    },
  ],
  settings: { walkMax: 10, driveOverheadMin: 10 },
  legOverrides: [],
});

// Scrub every env the provider chooser reads (audit finding 4 — the guard
// test catches imports, not the orchestrator's own gated require: a shell
// with CONSTRAINTS_PROVIDER=llm + a key would otherwise bill from jest).
const SCRUB = ["MAPS_PROVIDER", "CONSTRAINTS_PROVIDER", "ANTHROPIC_API_KEY"] as const;
const prev: Partial<Record<(typeof SCRUB)[number], string | undefined>> = {};
beforeEach(() => {
  for (const k of SCRUB) prev[k] = process.env[k];
  delete process.env.CONSTRAINTS_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.MAPS_PROVIDER = "fixture";
});
afterEach(() => {
  for (const k of SCRUB) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
});

describe("compileConstraintPatch (fixture compiler)", () => {
  it("compiles pace, a sunset window, last entry and a must-see — evidence carried, everything soft llm", async () => {
    const text = [
      "mum walks slow so keep it chill",
      "Market Hall at sunset would be lovely",
      "Guildhall Museum last entry 4pm i think — must see it",
    ].join("\n");
    const patch = await compileConstraintPatch(text, doc(), allOn);
    expect(patch).not.toBeNull();

    const pace = patch!.trip!.pacePreset!;
    expect(pace.value).toBe("relaxed");
    expect(pace.provenance).toMatchObject({ source: "llm", confirmed: false });
    expect(pace.provenance.evidence).toBeDefined();
    expect(text.toLowerCase()).toContain(pace.provenance.evidence!.toLowerCase());
    expect(pace.hardness).toEqual({ soft: { weight: LLM_SOFT_WEIGHT } });

    const hall = patch!.stops!["fx-01"];
    expect(hall.window!.value).toEqual({ startMin: 1050, endMin: 1170 });
    expect(hall.window!.provenance.evidence).toMatch(/sunset/i);

    const museum = patch!.stops!["fx-03"];
    expect(museum.hours!.value.lastEntryMin).toBe(16 * 60);
    // the stop's REAL weekly hours ride along — a later confirm must not
    // replace Google's hours with an invented all-open week
    expect(museum.hours!.value.byWeekday[1]).toEqual([{ startMin: 540, endMin: 1020 }]);
    expect(museum.priority!.value).toBe("must");
  });

  it("returns null when the capability is off, when the text is empty, and when nothing matches", async () => {
    expect(await compileConstraintPatch("mum walks slow", doc(), noConstraints)).toBeNull();
    expect(await compileConstraintPatch("   ", doc(), allOn)).toBeNull();
    expect(await compileConstraintPatch("nothing constraint-like here", doc(), allOn)).toBeNull();
  });

  it("gate matrix (audit finding 14): live-maps config without an explicit llm opt-in is OFF", async () => {
    // live maps (no fixture, key present), no CONSTRAINTS_PROVIDER: hard off —
    // never bills, never falls back to the fixture compiler on real money.
    process.env.MAPS_PROVIDER = "real";
    process.env.GOOGLE_MAPS_API_KEY = "test-key-never-called";
    try {
      expect(await compileConstraintPatch("mum walks slow", doc(), allOn)).toBeNull();
    } finally {
      delete process.env.GOOGLE_MAPS_API_KEY;
      process.env.MAPS_PROVIDER = "fixture";
    }
    // CONSTRAINTS_PROVIDER=llm WITHOUT a key: still off (never constructs the
    // adapter, which would throw), degrades to fixture only when fixture maps
    // are in play.
    process.env.CONSTRAINTS_PROVIDER = "llm";
    const patch = await compileConstraintPatch("mum walks slow so keep it chill", doc(), allOn);
    expect(patch?.trip?.pacePreset?.value).toBe("relaxed"); // fixture fallback, $0
  });

  it("drops emissions naming stops the doc doesn't have", async () => {
    const patch = await compileConstraintPatch("Mystery Palace at sunset", doc(), allOn);
    // "Mystery Palace" resolves to nothing; no stop entry appears
    expect(patch?.stops).toBeUndefined();
  });

  it("the hallucination tether drops any emission whose evidence isn't in the text", async () => {
    // Adapter double: emits one tethered and one fabricated-evidence emission.
    const fake = {
      compile: async () => ({
        constraints: [
          { kind: "pace" as const, preset: "relaxed" as const, evidence: "keep it chill" },
          {
            kind: "priority" as const,
            stopName: "Market Hall",
            priority: "must" as const,
            evidence: "the whole reason we're going", // NOT in the text
          },
        ],
      }),
    };
    jest.resetModules();
    jest.doMock("../interpret/fixtureConstraintsAdapter", () => ({
      createFixtureConstraintsAdapter: () => fake,
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { compileConstraintPatch: compile } =
      require("../interpret/interpretConstraints") as typeof import("../interpret/interpretConstraints");

    const patch = await compile("ok but keep it chill please", doc(), allOn);
    jest.dontMock("../interpret/fixtureConstraintsAdapter");

    expect(patch!.trip!.pacePreset!.value).toBe("relaxed");
    expect(patch!.stops).toBeUndefined(); // the fabricated must-see died at the tether
  });
});
