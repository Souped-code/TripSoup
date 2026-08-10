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
  // M1.2 — a DISAMBIGUATED place search string (name + city/area context drawn
  // from the paste, e.g. "Maxwell Food Centre, Singapore"), present ONLY for
  // items an adapter judges to be a real, searchable place.
  //
  // Deliberately distinct from `label`: `label` is display/context text and is
  // NEVER a query. `placeQuery` is the only text-derived string the pipeline
  // will geocode, and only when the caller holds `interpret.names` (see the
  // resolve checkpoint in pipeline.ts). The heuristic adapter cannot identify
  // places in free text and therefore never emits this field — which is why
  // the free/no-key path stays links-only, unchanged.
  placeQuery: z.string().optional(),
  dateHint: z.string().optional(),
  timeHint: z.string().optional(),
  // Required in spirit, tolerant in shape: the LIVE model (caught on prod,
  // 2026-08-10, E0 verify) omits this field for items with no time cue, and at
  // temperature 0 every retry omits it identically — so a hard requirement
  // burns all attempts on a guaranteed failure. Missing/null coerce to false
  // (the only sensible reading of "no anchor signal"); any other non-boolean
  // still fails validation and triggers the retry-with-feedback loop.
  anchorLikely: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
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
