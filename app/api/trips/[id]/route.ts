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

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function malformed(doc: TripDoc, id: string): string | null {
  if (doc.tripId !== id) return "tripId mismatch";
  if (!Array.isArray(doc.days) || !Array.isArray(doc.legOverrides)) return "days/legOverrides";
  if (!doc.settings || !isNum(doc.settings.walkMax) || !isNum(doc.settings.driveOverheadMin))
    return "settings";
  for (const day of doc.days) {
    if (typeof day.date !== "string" || !isNum(day.dayStartMin) || !isNum(day.dayEndMin))
      return "day shape";
    if (!Array.isArray(day.stops)) return "day stops";
    for (const s of day.stops) {
      if (typeof s.id !== "string" || typeof s.name !== "string") return "stop id/name";
      if (!s.location || !isNum(s.location.lat) || !isNum(s.location.lng)) return "stop location";
      if (!isNum(s.durationMin)) return "stop duration";
      if (s.anchor !== undefined && !isNum(s.anchor.startMin)) return "stop anchor";
    }
    if (day.precedence !== undefined) {
      if (!Array.isArray(day.precedence)) return "day precedence";
      for (const p of day.precedence) {
        if (typeof p.beforeId !== "string" || typeof p.afterId !== "string")
          return "precedence pair";
        if (p.reason !== undefined && typeof p.reason !== "string") return "precedence reason";
      }
    }
  }
  for (const o of doc.legOverrides) {
    if (!isNum(o.dayIndex) || typeof o.fromId !== "string" || typeof o.toId !== "string")
      return "override shape";
    if (o.mode !== "walk" && o.mode !== "drive") return "override mode";
  }
  return null;
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const doc = (await req.json()) as TripDoc;
  const bad = malformed(doc, id);
  if (bad) return NextResponse.json({ error: `malformed trip document: ${bad}` }, { status: 400 });
  await getTripStore().put(doc);
  return NextResponse.json({ ok: true });
}
