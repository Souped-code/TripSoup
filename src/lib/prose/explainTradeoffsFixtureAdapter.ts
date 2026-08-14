// Fixture prose adapter (E6b) — the prose-side twin of parse/fixtureParseAdapter.ts
// and maps/fixtureAdapter.ts. Deterministic, $0, journal-voice: what tests and
// e2e exercise. No model call, no randomness — same input always produces the
// same output, which is what lets a jest/playwright assertion pin exact text.

import { formatDuration } from "../util/duration";
import { capProse, type ProseInput, type ProseProvider } from "./types";

function kindPhrase(kind: string): string {
  switch (kind) {
    case "dropStop":
      return "skipping one stop";
    case "shiftWindow":
      return "shifting a booking";
    case "moveDay":
      return "moving something to another day";
    case "trimDuration":
      return "trimming a visit";
    case "relaxPace":
      return "easing the pace";
    default:
      return "a small change";
  }
}

export function createExplainTradeoffsFixtureAdapter(): ProseProvider {
  return {
    async explain(input: ProseInput): Promise<string> {
      const { conflicts, proposals } = input;
      if (conflicts.length === 0) {
        return capProse("Everything fits — no trade-offs to weigh right now.");
      }

      const first = conflicts[0];
      const rest = conflicts.length - 1;
      const cheapest = [...proposals].sort((a, b) => a.costDeltaMin - b.costDeltaMin)[0];

      const opener =
        conflicts.length === 1
          ? `One thing needs a decision: ${first.message}`
          : `A few things need a decision, starting with: ${first.message}`;

      const tail = rest > 0 ? ` (${rest} more like it below.)` : "";

      if (!cheapest) {
        return capProse(`${opener} Gracie couldn't find a clean fix — have a look and adjust by hand.${tail}`);
      }

      const delta =
        cheapest.costDeltaMin === 0
          ? "about the same either way"
          : cheapest.costDeltaMin < 0
            ? `saves around ${formatDuration(Math.abs(cheapest.costDeltaMin))}`
            : `costs about ${formatDuration(cheapest.costDeltaMin)} extra`;

      return capProse(`${opener} ${kindPhrase(cheapest.kind)} is the easiest way out — ${delta}.${tail}`);
    },
  };
}
