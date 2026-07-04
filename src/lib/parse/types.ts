// The parse contract (LLM output shape) — mirrors src/lib/maps/types.ts in
// spirit: this file is the port, zod-validated so untrusted model output
// (or a malformed heuristic result) can never silently corrupt downstream
// solver/schedule input.
//
// orderConstraint.before entries reference OTHER items' `raw` strings
// (not indices) — the raw text is the stable join key across adapters.

import { z } from "zod";

export const ParsedItemSchema = z.object({
  kind: z.enum(["link", "label"]),
  raw: z.string(),
  url: z.string().optional(),
  label: z.string().optional(),
  dateHint: z.string().optional(),
  timeHint: z.string().optional(),
  anchorLikely: z.boolean(),
  anchorReason: z.string().optional(),
  orderConstraint: z
    .object({
      before: z.array(z.string()).optional(),
      reason: z.string(),
    })
    .optional(),
  groupHint: z.string().optional(),
});

export const ParsedDaySchema = z.object({
  dateHint: z.string().optional(),
  itemRefs: z.array(z.number()),
});

export const SplitGroupSchema = z.object({
  name: z.string(),
  itemRefs: z.array(z.number()),
});

export const ParsedItinerarySchema = z.object({
  items: z.array(ParsedItemSchema),
  days: z.array(ParsedDaySchema),
  splitGroups: z.array(SplitGroupSchema),
});

export type ParsedItem = z.infer<typeof ParsedItemSchema>;
export type ParsedDay = z.infer<typeof ParsedDaySchema>;
export type SplitGroup = z.infer<typeof SplitGroupSchema>;
export type ParsedItinerary = z.infer<typeof ParsedItinerarySchema>;

// The parse-side adapter port — mirrors MapsProvider (maps/types.ts). Each
// adapter (heuristic, llm) implements this single method.
export interface ParseProvider {
  parse(text: string): Promise<ParsedItinerary>;
}
