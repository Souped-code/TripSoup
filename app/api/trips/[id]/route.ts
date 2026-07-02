// GET  /api/trips/[id] — fetch the trip document.
// PUT  /api/trips/[id] — replace the trip document (boundary-validated).
import { NextResponse } from "next/server";
import { getTripStore } from "@/lib/config";
import type { TripDoc } from "@/lib/store/types";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const doc = await getTripStore().get(id);
  if (!doc) return NextResponse.json({ error: "trip not found" }, { status: 404 });
  return NextResponse.json(doc);
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const doc = (await req.json()) as TripDoc;
  if (doc.tripId !== id || !Array.isArray(doc.days) || !doc.settings || !Array.isArray(doc.legOverrides)) {
    return NextResponse.json({ error: "malformed trip document" }, { status: 400 });
  }
  await getTripStore().put(doc);
  return NextResponse.json({ ok: true });
}
