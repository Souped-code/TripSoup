// Runtime wiring for the prose module — mirrors src/lib/parse/parseItinerary.ts's
// getParseProvider() exactly: env-driven adapter selection, silent-by-design
// fallback so development/CI/a capability-off user can never accidentally
// spend on the LLM, and prose is decorative on top of that (a thrown error
// from either adapter is caught here and turned into `null` — the caller,
// GET /api/trips/[id]/explain, logs and returns `{ prose: null }` rather than
// a 500; the sidebar renders its cards fully either way).
//
// PROSE_PROVIDER=llm only takes effect when ANTHROPIC_API_KEY is also present
// AND the caller holds `explain.tradeoffs`; otherwise this falls back to the
// deterministic fixture adapter — same two-gate philosophy as parseItinerary's
// "Gate 1 of 2" comment (here there is only one billable action to gate, so
// only one consult, at adapter-selection time; there is no analogous second
// checkpoint downstream the way resolvePlaces is for parse).

import { getEntitlements, type Entitlements } from "../entitlements/entitlements";
import { createExplainTradeoffsFixtureAdapter } from "./explainTradeoffsFixtureAdapter";
import type { ProseInput, ProseProvider } from "./types";

export type ExplainOptions = {
  /** Injected by the API route; defaults to the process-wide stub. */
  entitlements?: Entitlements;
};

function getProseProvider(entitlements: Entitlements): ProseProvider {
  const allowed = entitlements.has("explain.tradeoffs");
  const wantsLlm = process.env.PROSE_PROVIDER === "llm";

  if (wantsLlm && process.env.ANTHROPIC_API_KEY && allowed) {
    // Lazy import keeps @anthropic-ai/sdk out of every bundle that never uses it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createExplainTradeoffsLlmAdapter } =
      require("./explainTradeoffsLlmAdapter") as typeof import("./explainTradeoffsLlmAdapter");
    return createExplainTradeoffsLlmAdapter();
  }

  return createExplainTradeoffsFixtureAdapter();
}

/**
 * Returns the decorative prose, or `null` on ANY failure (bad key, network,
 * rate-limited-upstream, whatever) — logged, never thrown. Structured
 * trade-off cards are the API; this is garnish.
 */
export async function explainTradeoffs(
  input: ProseInput,
  opts: ExplainOptions = {}
): Promise<string | null> {
  if (input.conflicts.length === 0) return null;
  try {
    const entitlements = opts.entitlements ?? getEntitlements();
    const provider = getProseProvider(entitlements);
    return await provider.explain(input);
  } catch (e) {
    console.error("explainTradeoffs: prose generation failed (decorative, continuing without it)", e);
    return null;
  }
}
