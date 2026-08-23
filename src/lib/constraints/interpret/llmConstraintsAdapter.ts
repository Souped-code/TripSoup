// E7 — the LIVE constraint compiler: claude-haiku + zod retry loop, cloned
// from parse/llmAdapter.ts (same model, same streaming call, same
// retry-with-feedback shape, same construction-time key gate). Selected ONLY
// by interpretConstraints.ts's gated chooser; the adapter-guard test forbids
// any test from importing this file.

import Anthropic from "@anthropic-ai/sdk";
import {
  ConstraintEmissionsSchema,
  type CompileContext,
  type ConstraintCompileProvider,
  type ConstraintEmissions,
} from "./types";

const MODEL = "claude-haiku-4-5";
const MAX_RETRIES = 2; // total attempts = 1 + MAX_RETRIES

const SYSTEM_PROMPT = `You read a traveller's trip notes and extract SCHEDULING CONSTRAINTS as JSON. Output ONLY minified JSON matching:

{"constraints":[
  {"kind":"pace","preset":"relaxed"|"balanced"|"packed","evidence":string},
  {"kind":"stopWindow","stopName":string,"startMin":number,"endMin":number,"evidence":string},
  {"kind":"lastEntry","stopName":string,"lastEntryMin":number,"evidence":string},
  {"kind":"duration","stopName":string,"minMin":number,"typicalMin":number,"maxMin":number,"evidence":string},
  {"kind":"priority","stopName":string,"priority":"must"|"should"|"could","evidence":string},
  {"kind":"pinnedDay","stopName":string,"dayIndex":number,"evidence":string},
  {"kind":"quietBlock","startMin":number,"endMin":number,"label":string?,"evidence":string}
]}

Rules (do not deviate):
1. "evidence" is a VERBATIM quote from the input — copy the exact characters of the shortest span that justifies the constraint. A constraint whose evidence is not literally present in the input will be DISCARDED, so never paraphrase.
2. Times are minutes from midnight (14:30 -> 870). Map fuzzy vocabulary honestly: "sunset" -> a stopWindow of roughly 1050-1170; "morning" -> 540-720; "afternoon" -> 720-1050; "evening"/"dinner time" -> 1080-1260. Only when the text ties the vocabulary to a SPECIFIC listed stop.
3. "stopName" must EXACTLY match one of the provided stop names (the list is in the user message). If the note's place isn't in the list, emit nothing for it.
4. "pace": only from statements about the party's energy/speed ("mum walks slow", "keep it chill", "pack it all in"). Never infer pace from the number of stops.
5. "priority" "must" only for explicit insistence ("must see", "can't miss", "the whole reason we're going"); "could" for explicit take-it-or-leave-it ("if we have time", "maybe skip").
6. "pinnedDay": only when the text explicitly commits a stop to a day ("the museum HAS to be on day 2", "temple on the monday" when days are dated). dayIndex is 0-based.
7. "lastEntry": from statements like "last entry 5pm". "duration": from statements like "budget 3 hours there" (make minMin/typicalMin/maxMin honest: a stated time is typicalMin; give ±25% unless the text bounds it).
8. "quietBlock": from recurring party needs ("nap 1-3pm every day", "prayers at noon") — never from one-off bookings.
9. Emit NOTHING when the text contains no constraint statements. Fewer, well-evidenced constraints beat many guesses.
10. Output ONLY the JSON object. No prose, no fences.`;

export class ConstraintCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConstraintCompileError";
  }
}

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function tryParseJson(raw: string): unknown {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  return JSON.parse(stripped);
}

export function createLlmConstraintsAdapter(): ConstraintCompileProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Construction-time gate, same as parse/llmAdapter: this adapter must be
    // impossible to instantiate without a key.
    throw new ConstraintCompileError("llm constraints adapter requires ANTHROPIC_API_KEY");
  }
  const client = new Anthropic({ apiKey });

  return {
    async compile(text: string, context: CompileContext): Promise<ConstraintEmissions> {
      const contextBlock = [
        `Trip has ${context.dayCount} day(s). Stops (use these EXACT names):`,
        ...context.stops.map((s) => `- ${s.name} (day ${s.dayIndex + 1})`),
        "",
        "Traveller's notes:",
        text,
      ].join("\n");

      let feedback: string | null = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const userMessage = feedback
          ? `The previous response failed schema validation with this error:\n${feedback}\n\nRe-emit corrected JSON only, for this input:\n${contextBlock}`
          : contextBlock;

        const stream = client.messages.stream({
          model: MODEL,
          max_tokens: 8000,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        });
        const message = await stream.finalMessage();

        if (message.stop_reason === "max_tokens") {
          throw new ConstraintCompileError("notes too large to compile in one go");
        }

        const raw = extractText(message);
        let candidate: unknown;
        try {
          candidate = tryParseJson(raw);
        } catch (err) {
          feedback = `Response was not valid JSON: ${(err as Error).message}`;
          continue;
        }

        const result = ConstraintEmissionsSchema.safeParse(candidate);
        if (result.success) return result.data;
        feedback = result.error.message;
      }

      throw new ConstraintCompileError(
        `constraint compile failed schema validation after ${MAX_RETRIES + 1} attempts. Last error: ${feedback}`
      );
    },
  };
}
