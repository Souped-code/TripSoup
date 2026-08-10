// POST /api/trips/[id]/plan — explicit re-plan: re-solves EVERY day (E4 —
// src/lib/planStore.ts's savePlanned) and persists the result, returning the
// requested day's plan (kept — src/ui/board/TripBoard.tsx's optimize button
// still calls this and expects a bare DayPlan back).
// GET  /api/trips/[id]/plan — return the stored plan, no recompute (E4 —
// planStore.ts's readPlanned; self-heals a missing/stale plan exactly once).
import { NextResponse } from "next/server";
import { getTripStore } from "@/lib/config";
import { readPlanned, savePlanned } from "@/lib/planStore";
import { checkRateLimit } from "@/lib/rateLimit";

// E5b: savePlanned's POST path re-solves every day through the real engine
// now (see app/api/trips/[id]/route.ts's PUT for the same reasoning).
export const maxDuration = 120;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const doc = await readPlanned(id);
  if (!doc) return NextResponse.json({ error: "trip not found" }, { status: 404 });
  return NextResponse.json(doc.plan);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { limited } = await checkRateLimit("plan", req);
  if (limited) {
    return NextResponse.json(
      { error: "You've been planning up a storm — give it a short breather and try again soon." },
      { status: 429 }
    );
  }
  try {
    const { id } = await ctx.params;
    const { dayIndex } = (await req.json()) as { dayIndex: number };
    const doc = await getTripStore().get(id);
    if (!doc) return NextResponse.json({ error: "trip not found" }, { status: 404 });
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= doc.days.length) {
      return NextResponse.json({ error: "bad dayIndex" }, { status: 400 });
    }
    const saved = await savePlanned(doc);
    return NextResponse.json(saved.plan!.days[dayIndex]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
