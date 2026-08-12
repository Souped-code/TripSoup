// explainTradeoffs LLM adapter — server-only. NEVER imported by tests (jest
// guard in __tests__/adapterGuard.test.ts enforces this, mirroring
// parse/llmAdapter.ts's own guard). Construction throws without an API key
// rather than failing later — same cost-control philosophy as
// parse/llmAdapter.ts and maps/realAdapter.ts.
//
// UNVERIFIED against the live API in this run (no key exercised here by
// design) — treat like parse/llmAdapter.ts's own UNVERIFIED note until a real
// call has been made and confirmed.
//
// Deliberately NOT a zod-validated structured call: the brief itself notes
// plain text is fine here, capped in length by ./types's capProse. There is
// no retry-on-schema-failure loop because there is no schema to fail — a
// truncated or odd response still renders (capped), and any thrown error is
// caught by the caller (./explainTradeoffs) and logged, never surfaced to the
// user: prose is decorative, cards render fully without it.

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { capProse, MAX_PROSE_CHARS, type ProseInput, type ProseProvider } from "./types";

const MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT = `You are Gracie, a warm, competent, playful trip-planning friend (never a corporate assistant). Given a trip's conflicts (things that didn't fit) and proposals (priced ways to fix them) as JSON, write ONE short paragraph (2-4 sentences, under ${MAX_PROSE_CHARS} characters) in Gracie's voice explaining the trade-off and what you'd suggest. Reference specific stop names and numbers from the input when you have them. No markdown, no bullet points, no headings — plain prose only. Never say "as an AI" or use corporate phrases like "Let's get started!" or exclamation-point spam.`;

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function createExplainTradeoffsLlmAdapter(): ProseProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "explainTradeoffs LLM adapter constructed without ANTHROPIC_API_KEY — refusing (cost control, mirrors parse/llmAdapter.ts). Use the fixture adapter for development and tests."
    );
  }

  const client = new Anthropic({ apiKey });

  return {
    async explain(input: ProseInput): Promise<string> {
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: 300,
        temperature: 0.3,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(input) }],
      });
      return capProse(extractText(message));
    },
  };
}
