// LLM adapter — server-only. NEVER imported by tests (jest guard in
// __tests__/adapterGuard.test.ts enforces this, mirroring maps/realAdapter.ts).
// Construction throws without an API key rather than failing later — cost
// control is spec, same philosophy as the maps real adapter.
//
// UNVERIFIED against the live API in this run (no key exercised here by
// design) — treat like realAdapter.ts's live-checklist items until a real
// call has been made and confirmed against the schema below.

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ParsedItinerarySchema, type ParsedItinerary, type ParseProvider } from "./types";

const MODEL = "claude-haiku-4-5";
const MAX_RETRIES = 2; // total attempts = 1 + MAX_RETRIES

const SYSTEM_PROMPT = `You convert a raw pasted travel itinerary (plain text, possibly copy-pasted from notes, Maps links, group chats) into strict JSON matching this contract:

{
  "items": [
    {
      "kind": "link" | "label",
      "raw": string,               // the original line/text this item came from, verbatim
      "url": string?,              // present only for kind "link" — copied VERBATIM, character for character
      "label": string?,            // human-readable description of the item
      "dateHint": string?,         // e.g. "Day 1", "Saturday", "12 July" if this item belongs to a specific day
      "timeHint": string?,         // e.g. "2pm" if a specific time is mentioned
      "anchorLikely": boolean,     // true if this item has a fixed/likely-fixed time (meal reservation, timed ticket, etc.)
      "anchorReason": string?,     // why anchorLikely is true
      "orderConstraint": { "before": string[]?, "reason": string }?, // "before" lists the raw text of OTHER items that must come after this one
      "groupHint": string?         // e.g. "Group A" if this item is scoped to a named subgroup
    }
  ],
  "days": [ { "dateHint": string?, "itemRefs": number[] } ],   // itemRefs are indices into "items"
  "splitGroups": [ { "name": string, "itemRefs": number[] } ]  // itemRefs are indices into "items"
}

Rules (do not deviate):
1. URLs must be extracted VERBATIM — copy the exact string from the input, character for character. NEVER normalize, shorten, decode, re-encode, or otherwise alter a URL.
2. Text near a link (same line, or the line immediately before/after) that describes it becomes that link's "label". Label text is a human-readable description ONLY — it is never itself a location query.
3. Phrases like "2pm lunch @ Some Place" imply a fixed time: set "timeHint" to the time text and "anchorLikely": true.
4. Reasoning like "drop bags at the hotel first" implies a sequencing constraint: set "orderConstraint" on that item with a human-readable "reason" and, when clear from context, list the raw text of the item(s) that must come after it in "before".
5. Lines like "Group A" / "Group B" / "Team X" mark a named subgroup: subsequent items until the next such marker get that "groupHint", and each named group gets an entry in "splitGroups" listing which item indices belong to it.
6. Lines like "Day 1" / "Saturday" / a date mark a new day: subsequent items until the next such marker belong to that day; add an entry in "days" with the matching itemRefs.
7. Output ONLY the JSON object. No prose, no markdown fences, no commentary.`;

export class ParseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseValidationError";
  }
}

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function tryParseJson(raw: string): unknown {
  // Models occasionally wrap JSON in fences despite instructions; strip them
  // defensively rather than failing the whole call over formatting.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  return JSON.parse(stripped);
}

export function createLlmAdapter(): ParseProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "LLM parse adapter constructed without ANTHROPIC_API_KEY — refusing (cost control, mirrors maps/realAdapter.ts). Use the heuristic adapter for development and tests."
    );
  }

  const client = new Anthropic({ apiKey });

  return {
    async parse(text: string): Promise<ParsedItinerary> {
      let feedback: string | null = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const userMessage = feedback
          ? `The previous response failed schema validation with this error:\n${feedback}\n\nRe-emit corrected JSON only, for this input:\n${text}`
          : text;

        const message = await client.messages.create({
          model: MODEL,
          max_tokens: 4096,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        });

        const raw = extractText(message);

        let candidate: unknown;
        try {
          candidate = tryParseJson(raw);
        } catch (err) {
          feedback = `Response was not valid JSON: ${(err as Error).message}`;
          continue;
        }

        const result = ParsedItinerarySchema.safeParse(candidate);
        if (result.success) {
          return result.data;
        }
        feedback = result.error.message;
      }

      throw new ParseValidationError(
        `LLM parse adapter failed schema validation after ${MAX_RETRIES + 1} attempts. Last error: ${feedback}`
      );
    },
  };
}
