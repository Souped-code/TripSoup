// E6b — prose adapter selection gate (mirrors parse/__tests__/parseItinerary.gate.test.ts)
// and the fixture adapter's deterministic output. Never imports the llm
// adapter or the Anthropic SDK (see adapterGuard.test.ts in this directory).

import { explainTradeoffs } from "../explainTradeoffs";
import { createExplainTradeoffsFixtureAdapter } from "../explainTradeoffsFixtureAdapter";
import { capProse, MAX_PROSE_CHARS, type ProseInput } from "../types";
import { createEntitlements, type Capability } from "../../entitlements/entitlements";

const EXPLAIN_OFF = createEntitlements({
  tier: "free",
  capabilities: ["resolve.links"] as Capability[],
  maxStops: 8,
  watermark: true,
});

const EXPLAIN_ON = createEntitlements({
  tier: "pass",
  capabilities: ["resolve.links", "explain.tradeoffs"] as Capability[],
  maxStops: 40,
  watermark: false,
});

const oneConflict: ProseInput = {
  conflicts: [{ id: "hours|0|x|fx-03", code: "hours", message: '"Guildhall Museum" is closed.', dayIndex: 0 }],
  proposals: [
    {
      id: "dropStop:x",
      kind: "dropStop",
      message: "Leave out Guildhall Museum.",
      resolves: ["hours|0|x|fx-03"],
      costDeltaMin: -5,
    },
  ],
};

describe("explainTradeoffs adapter selection", () => {
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ["PROSE_PROVIDER", "ANTHROPIC_API_KEY"];

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns null when there are no conflicts (nothing to explain, no call made)", async () => {
    const result = await explainTradeoffs({ conflicts: [], proposals: [] }, { entitlements: EXPLAIN_ON });
    expect(result).toBeNull();
  });

  it("without explain.tradeoffs, PROSE_PROVIDER=llm + a key still does NOT select the llm adapter", async () => {
    process.env.PROSE_PROVIDER = "llm";
    process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key-and-must-never-be-used";

    // If the gate leaked, this would attempt a live network call and either
    // hang/throw — instead it must return the deterministic fixture prose.
    const result = await explainTradeoffs(oneConflict, { entitlements: EXPLAIN_OFF });
    expect(result).not.toBeNull();
    expect(result).toBe(await createExplainTradeoffsFixtureAdapter().explain(oneConflict));
  });

  it("with explain.tradeoffs but no key, the fixture adapter is used", async () => {
    delete process.env.PROSE_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;

    const result = await explainTradeoffs(oneConflict, { entitlements: EXPLAIN_ON });
    expect(result).toBe(await createExplainTradeoffsFixtureAdapter().explain(oneConflict));
  });

  it("with explain.tradeoffs but PROSE_PROVIDER unset, the fixture adapter is used even with a key present", async () => {
    delete process.env.PROSE_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key-and-must-never-be-used";

    const result = await explainTradeoffs(oneConflict, { entitlements: EXPLAIN_ON });
    expect(result).toBe(await createExplainTradeoffsFixtureAdapter().explain(oneConflict));
  });
});

describe("explainTradeoffsFixtureAdapter — deterministic template prose", () => {
  const adapter = createExplainTradeoffsFixtureAdapter();

  it("is deterministic — same input, same output, twice", async () => {
    const a = await adapter.explain(oneConflict);
    const b = await adapter.explain(oneConflict);
    expect(a).toBe(b);
  });

  it("mentions the conflict and the cheapest proposal's saving", async () => {
    const prose = await adapter.explain(oneConflict);
    expect(prose).toContain("Guildhall Museum");
    expect(prose).toMatch(/saves around 5 min/);
  });

  it("names a positive cost delta as a cost, not a saving", async () => {
    const costly: ProseInput = {
      conflicts: oneConflict.conflicts,
      proposals: [{ ...oneConflict.proposals[0], costDeltaMin: 12 }],
    };
    const prose = await adapter.explain(costly);
    expect(prose).toMatch(/costs about 12 min extra/);
  });

  it("handles a conflict with zero resolving proposals without throwing", async () => {
    const stuck: ProseInput = { conflicts: oneConflict.conflicts, proposals: [] };
    const prose = await adapter.explain(stuck);
    expect(prose).toContain("couldn't find a clean fix");
  });

  it("says nothing needs deciding when there are no conflicts", async () => {
    const prose = await adapter.explain({ conflicts: [], proposals: [] });
    expect(prose).toMatch(/no trade-offs/);
  });
});

describe("capProse", () => {
  it("passes short text through unchanged (trimmed)", () => {
    expect(capProse("  hello  ")).toBe("hello");
  });

  it("truncates long text to MAX_PROSE_CHARS with an ellipsis", () => {
    const long = "x".repeat(MAX_PROSE_CHARS + 50);
    const capped = capProse(long);
    expect(capped.length).toBeLessThanOrEqual(MAX_PROSE_CHARS);
    expect(capped.endsWith("…")).toBe(true);
  });
});
