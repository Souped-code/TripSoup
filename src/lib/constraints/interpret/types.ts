// E7 — the constraint compiler's port (the parse module's ParseProvider
// pattern, verbatim in spirit). Adapters emit TYPED EMISSIONS, not raw
// ConstraintPatches: a small closed vocabulary the orchestrator
// (interpretConstraints.ts) validates, tethers to evidence, resolves to stop
// keys and only THEN converts into E2's wire shape — so a model can never
// smuggle an arbitrary patch past the safety layer by emitting it directly.
//
// Every emission carries `evidence`: the VERBATIM span of the user's text
// that justifies it. The orchestrator drops any emission whose evidence is
// not actually a substring of the input (the hallucination tether); the
// schema merely requires the field to exist.

import { z } from "zod";

const MinutesSchema = z.number().int().min(0).max(1800);
const EvidenceSchema = z.string().min(1).max(200);
const StopNameSchema = z.string().min(1).max(120);

export const ConstraintEmissionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pace"),
    preset: z.enum(["relaxed", "balanced", "packed"]),
    evidence: EvidenceSchema,
  }),
  z.object({
    kind: z.literal("stopWindow"),
    stopName: StopNameSchema,
    startMin: MinutesSchema,
    endMin: MinutesSchema,
    evidence: EvidenceSchema,
  }),
  z.object({
    kind: z.literal("lastEntry"),
    stopName: StopNameSchema,
    lastEntryMin: MinutesSchema,
    evidence: EvidenceSchema,
  }),
  z.object({
    kind: z.literal("duration"),
    stopName: StopNameSchema,
    minMin: MinutesSchema,
    typicalMin: MinutesSchema,
    maxMin: MinutesSchema,
    evidence: EvidenceSchema,
  }),
  z.object({
    kind: z.literal("priority"),
    stopName: StopNameSchema,
    priority: z.enum(["must", "should", "could"]),
    evidence: EvidenceSchema,
  }),
  z.object({
    kind: z.literal("pinnedDay"),
    stopName: StopNameSchema,
    dayIndex: z.number().int().min(0).max(30),
    evidence: EvidenceSchema,
  }),
  z.object({
    kind: z.literal("quietBlock"),
    startMin: MinutesSchema,
    endMin: MinutesSchema,
    label: z.string().max(60).optional(),
    evidence: EvidenceSchema,
  }),
]);

export const ConstraintEmissionsSchema = z.object({
  constraints: z.array(ConstraintEmissionSchema).max(30),
});

export type ConstraintEmission = z.infer<typeof ConstraintEmissionSchema>;
export type ConstraintEmissions = z.infer<typeof ConstraintEmissionsSchema>;

/** What an adapter sees of the trip: enough to name stops EXACTLY and to
 * bound day references — never the whole doc. */
export type CompileContext = {
  stops: ReadonlyArray<{ name: string; dayIndex: number }>;
  dayCount: number;
};

export interface ConstraintCompileProvider {
  compile(text: string, context: CompileContext): Promise<ConstraintEmissions>;
}
