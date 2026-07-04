// Runtime wiring for the parse module — mirrors src/lib/config.ts's
// getMapsProvider(): env-driven provider selection, silent-by-design
// fallback so development/CI can never accidentally spend on the LLM.
//
// PARSE_PROVIDER=llm only takes effect when ANTHROPIC_API_KEY is also
// present; otherwise (unset, "heuristic", or "llm" with no key) this falls
// back to the heuristic adapter without erroring — same cost-safety
// philosophy as MAPS_PROVIDER=fixture being the default absent a key.

import type { ParsedItinerary, ParseProvider } from "./types";
import { createHeuristicAdapter } from "./heuristicAdapter";

// ---------------------------------------------------------------------------
// LOCKED RULE (do not relax without re-reading the production plan): only
// URLs that the parser extracted verbatim from the pasted text are ever
// allowed to reach resolvePlaces / the Places API. `label` text — anything
// the parser derived to describe an item for display — is NEVER used as a
// Places query. Labels are display names and context only. Any code that
// wires parse output into resolvePlaces MUST read `item.url`, never
// `item.label` or `item.raw` for label-only items.
// ---------------------------------------------------------------------------

function getParseProvider(): ParseProvider {
  const wantsLlm = process.env.PARSE_PROVIDER === "llm";
  if (wantsLlm && process.env.ANTHROPIC_API_KEY) {
    // Lazy import keeps @anthropic-ai/sdk out of every bundle that never uses it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createLlmAdapter } = require("./llmAdapter") as typeof import("./llmAdapter");
    return createLlmAdapter();
  }
  return createHeuristicAdapter();
}

export async function parseItinerary(text: string): Promise<ParsedItinerary> {
  const provider = getParseProvider();
  return provider.parse(text);
}
