// M1.6 — the FIRST of the two `interpret.names` consults: adapter selection.
//
// Why this gate exists on its own: gating only the resolve checkpoint would
// still bill Anthropic for a paid LLM parse whose placeQuery output we are then
// contractually required to throw away. A free-tier paste must never trigger a
// paid parse at all.
//
// This suite never imports the llm adapter (see adapterGuard.test.ts). It
// proves the gate the honest way: point the env at the LLM with a bogus key,
// then assert a normal heuristic result comes back — if the gate leaked, the
// adapter would have been constructed and a live call attempted.

import { parseItinerary } from "../parseItinerary";
import { createEntitlements, type Capability } from "../../entitlements/entitlements";

const NAMES_OFF = createEntitlements({
  tier: "free",
  capabilities: ["resolve.links"] as Capability[],
  maxStops: 8,
  watermark: true,
});

const NAMES_ON = createEntitlements({
  tier: "pass",
  capabilities: ["resolve.links", "interpret.names"] as Capability[],
  maxStops: 40,
  watermark: false,
});

describe("parseItinerary adapter selection", () => {
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ["PARSE_PROVIDER", "ANTHROPIC_API_KEY", "MAPS_PROVIDER", "GOOGLE_MAPS_API_KEY"];

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.MAPS_PROVIDER = "fixture";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("without interpret.names, PARSE_PROVIDER=llm + a key still does NOT select the llm adapter", async () => {
    process.env.PARSE_PROVIDER = "llm";
    process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key-and-must-never-be-used";

    const parsed = await parseItinerary("Day 1\nMarket Hall", { entitlements: NAMES_OFF });

    // Heuristic output: parsed correctly, but no placeQuery anywhere — the
    // heuristic cannot identify places in free text, which is exactly why the
    // free path stays links-only.
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].raw).toBe("Market Hall");
    expect(parsed.items.every((i) => i.placeQuery === undefined)).toBe(true);
  });

  it("without interpret.names and no key, the fixture parse adapter is not used either", async () => {
    delete process.env.PARSE_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;

    const parsed = await parseItinerary("Day 1\nMarket Hall", { entitlements: NAMES_OFF });
    expect(parsed.items[0].placeQuery).toBeUndefined();
  });

  it("with interpret.names and fixture maps in play, the fixture parse adapter supplies placeQuery", async () => {
    delete process.env.PARSE_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;

    const parsed = await parseItinerary("Day 1\nMarket Hall", { entitlements: NAMES_ON });
    expect(parsed.items[0].placeQuery).toBe("Market Hall, Casterbridge");
  });

  it("with interpret.names but REAL maps in play, no synthetic placeQuery is produced", async () => {
    // The fixture parse adapter is tied to the fixture MAPS adapter: if a
    // resolution would cost real money, we must not be emitting Casterbridge
    // place names for it to look up.
    delete process.env.PARSE_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MAPS_PROVIDER;
    process.env.GOOGLE_MAPS_API_KEY = "not-a-real-key-never-called-in-this-test";

    const parsed = await parseItinerary("Day 1\nMarket Hall", { entitlements: NAMES_ON });
    expect(parsed.items[0].placeQuery).toBeUndefined();
  });
});
