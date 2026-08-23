// POST /api/trips/[id]/constraints — E7's standalone compile: free-form notes
// ("mum walks slow, sunset at the park") -> evidence-tethered constraint
// patch -> merged onto the stored patch (a re-compile updates old llm entries,
// never a user's) -> ordinary re-plan. Gated + adapter-selected inside
// compileConstraintPatch; a compile that finds nothing returns the doc
// unchanged with compiled: 0 — never an error, never a blocked save.

import { NextResponse } from "next/server";
import { getTripStore } from "@/lib/config";
import { savePlanned } from "@/lib/planStore";
import { checkRateLimit } from "@/lib/rateLimit";
import { compileConstraintPatch } from "@/lib/constraints/interpret/interpretConstraints";
import { mergeStoredPatches } from "@/lib/constraints/persisted";
import type { ConstraintPatch } from "@/lib/constraints/types";

function countConstraints(patch: ConstraintPatch): number {
  let n = 0;
  for (const sp of Object.values(patch.stops ?? {})) n += Object.keys(sp).length;
  for (const dp of Object.values(patch.days ?? {})) n += Object.keys(dp).length;
  if (patch.trip?.pacePreset) n++;
  n += patch.trip?.party?.quietBlocks?.length ?? 0;
  n += patch.trip?.party?.arrivalPins?.length ?? 0;
  if (patch.trip?.party?.walkSpeedFactor) n++;
  n += patch.relations?.length ?? 0;
  return n;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { limited } = await checkRateLimit("constraints", req);
  if (limited) {
    return NextResponse.json(
      { error: "You've been planning up a storm — give it a short breather and try again soon." },
      { status: 429 }
    );
  }
  const { id } = await ctx.params;
  const doc = await getTripStore().get(id);
  if (!doc) return NextResponse.json({ error: "trip not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { notes?: unknown } | null;
  const notes = body?.notes;
  if (typeof notes !== "string" || notes.trim() === "" || notes.length > 4000) {
    return NextResponse.json({ error: "notes must be a non-empty string (max 4000 chars)" }, { status: 400 });
  }

  const patch = await compileConstraintPatch(notes, doc);
  if (!patch) return NextResponse.json({ doc, compiled: 0 });

  const next = { ...doc, constraints: mergeStoredPatches(doc.constraints ?? {}, patch) };
  const saved = await savePlanned(next);
  return NextResponse.json({ doc: saved, compiled: countConstraints(patch) });
}
