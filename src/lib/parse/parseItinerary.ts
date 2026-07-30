// Runtime wiring for the parse module — mirrors src/lib/config.ts's
// getMapsProvider(): env-driven provider selection, silent-by-design
// fallback so development/CI can never accidentally spend on the LLM.
//
// PARSE_PROVIDER=llm only takes effect when ANTHROPIC_API_KEY is also
// present AND the caller holds `interpret.names`; otherwise this falls back to
// a non-billing adapter without erroring — same cost-safety philosophy as
// MAPS_PROVIDER=fixture being the default absent a key.

import type { ParsedItinerary, ParseProvider } from "./types";
import { createHeuristicAdapter } from "./heuristicAdapter";
import { createFixtureParseAdapter } from "./fixtureParseAdapter";
import { getEntitlements, type Entitlements } from "../entitlements/entitlements";

// ---------------------------------------------------------------------------
// LOCKED RULE, as amended by M1 (interpretation spec §4.3 — this supersedes the
// links-only wording, it does not abandon it):
//
//   The ONLY strings that may ever reach resolvePlaces / the Places API are
//     (a) `item.url`        — a URL extracted VERBATIM from the pasted text, and
//     (b) `item.placeQuery` — a deliberate, adapter-identified place search
//                             string, and ONLY when the caller holds the
//                             `interpret.names` capability.
//
//   `item.label` and `item.raw` are STILL NEVER queries. They are display and
//   context text. Any code wiring parse output into resolvePlaces must read
//   `url`/`placeQuery` and nothing else — never "helpfully" fall back to the
//   label or the raw line for a label-only item.
//
// Why the relaxation is safe: `placeQuery` is not arbitrary text. It is emitted
// only for items an adapter judged to be a real place, it is gated behind a
// capability that M3 turns off for the free tier, and it shares the same
// combined 40-lookup spend cap as links. The rule existed to stop unbounded
// billed lookups on arbitrary prose; all three of those guards preserve that.
//
// The gate is consulted TWICE, deliberately (spec §4.1): here, so a free-tier
// paste never triggers a paid LLM parse at all, and again at the resolve
// checkpoint, so a stray placeQuery from any source still cannot be billed.
// ---------------------------------------------------------------------------

export type ParseOptions = {
  /** Injected by runPipeline; defaults to the process-wide stub. */
  entitlements?: Entitlements;
};

// Mirrors config.ts's getMapsProvider() predicate EXACTLY. Tying the fixture
// parse adapter to the fixture MAPS adapter is what guarantees a Casterbridge
// placeQuery can never be sent to the real Places API: if we would spend real
// money on resolution, we do not emit synthetic place names to resolve.
function fixtureMapsInPlay(): boolean {
  return process.env.MAPS_PROVIDER === "fixture" || !process.env.GOOGLE_MAPS_API_KEY;
}

function getParseProvider(entitlements: Entitlements): ParseProvider {
  const namesAllowed = entitlements.has("interpret.names");

  // Gate 1 of 2. Without `interpret.names` there is nothing an LLM parse could
  // legally produce that the heuristic cannot — placeQuery would be discarded
  // at the resolve checkpoint — so calling it would bill Anthropic for output
  // we are contractually required to throw away.
  const wantsLlm = process.env.PARSE_PROVIDER === "llm";
  if (wantsLlm && process.env.ANTHROPIC_API_KEY && namesAllowed) {
    // Lazy import keeps @anthropic-ai/sdk out of every bundle that never uses it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createLlmAdapter } = require("./llmAdapter") as typeof import("./llmAdapter");
    return createLlmAdapter();
  }

  // No key (or no entitlement) but fixture maps are serving resolution: use the
  // fixture parse adapter so the text-only path is exercisable end to end at
  // zero spend (spec §4.6). Still gated on `interpret.names` — the free-tier
  // path must behave identically in tests and in production.
  if (namesAllowed && fixtureMapsInPlay()) {
    return createFixtureParseAdapter();
  }

  return createHeuristicAdapter();
}

export async function parseItinerary(
  text: string,
  opts: ParseOptions = {}
): Promise<ParsedItinerary> {
  const entitlements = opts.entitlements ?? getEntitlements();
  const provider = getParseProvider(entitlements);
  return provider.parse(text);
}
