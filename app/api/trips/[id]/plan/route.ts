// POST /api/trips/[id]/plan — two request shapes:
//   - `{ dayIndex }` (legacy — E4): an ordinary re-plan (src/lib/planStore.ts's
//     savePlanned, now day-scoped/incremental per E5c) and returns the
//     requested day's plan (kept — src/ui/board/TripBoard.tsx's optimize
//     button still calls this and expects a bare DayPlan back).
//   - `{ recook: { scope: "day", dayIndex } | { scope: "trip" } }` (E5c —
//     explicit re-cook): clears manualOrder within the given scope and
//     FORCE-solves fresh even if nothing's hash-stale, subsuming the old
//     re-optimize semantics. Returns `{ doc: TripDoc }`, same shape as the
//     PUT route, so a caller (src/ui/reveal/RevealClient.tsx) can commit it
//     the same way. Day scope leaves every other day untouched; trip scope
//     runs one joint whole-trip solve (cross-day proposals only make sense
//     there).
// GET  /api/trips/[id]/plan — return the stored plan, no recompute (E4 —
// planStore.ts's readPlanned; self-heals a missing/stale plan exactly once).
import { NextResponse } from "next/server";
import { getTripStore } from "@/lib/config";
import { readPlanned, recookDay, recookTrip, savePlanned } from "@/lib/planStore";
import { checkRateLimit } from "@/lib/rateLimit";

// E5b: a re-plan can be a real engine solve (see app/api/trips/[id]/route.ts's
// PUT for the same reasoning). E5c's day-scoped solves are individually much
// cheaper, but a trip-scope re-cook still runs the full whole-trip solve.
export const maxDuration = 120;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const doc = await readPlanned(id);
  if (!doc) return NextResponse.json({ error: "trip not found" }, { status: 404 });
  return NextResponse.json(doc.plan);
}

type Body =
  | { dayIndex: number; recook?: undefined }
  | { recook: { scope: "day"; dayIndex: number } | { scope: "trip" }; dayIndex?: undefined };

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
    const body = (await req.json()) as Body;
    const doc = await getTripStore().get(id);
    if (!doc) return NextResponse.json({ error: "trip not found" }, { status: 404 });

    if (body.recook) {
      if (body.recook.scope === "trip") {
        const saved = await recookTrip(doc);
        return NextResponse.json({ doc: saved });
      }
      if (body.recook.scope !== "day") {
        return NextResponse.json({ error: "bad recook scope" }, { status: 400 });
      }
      const { dayIndex } = body.recook;
      if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= doc.days.length) {
        return NextResponse.json({ error: "bad dayIndex" }, { status: 400 });
      }
      const saved = await recookDay(doc, dayIndex);
      return NextResponse.json({ doc: saved });
    }

    const { dayIndex } = body;
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
