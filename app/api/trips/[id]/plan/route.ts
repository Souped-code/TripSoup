// POST /api/trips/[id]/plan — compute one day's plan from the stored document.
import { NextResponse } from "next/server";
import { getTripStore } from "@/lib/config";
import { planTripDay } from "@/lib/planService";
import { checkRateLimit } from "@/lib/rateLimit";

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
    return NextResponse.json(await planTripDay(doc, dayIndex));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
