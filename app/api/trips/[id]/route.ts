// GET  /api/trips/[id] — fetch the trip document.
// PUT  /api/trips/[id] — replace the trip document (boundary-validated), then
//      re-plan it (E4 — src/lib/planStore.ts's savePlanned) and return the
//      freshly-planned doc, so callers never need a follow-up POST /plan.
//
// E5b design point 6: PUT now runs the E5a engine (up to ENGINE_BUDGET_MS per
// day set it re-plans from scratch — the toggle-only fast path in
// planStore.savePlanned keeps a leg toggle cheap, but a stop add/remove/
// anchor edit is a real engine solve now). checkRateLimit closes E4
// observation 9 PARTIALLY: it caps requests per owner-IP per hour (20/hr
// default — see rateLimit.ts's ROUTE_LIMITS, "plan" bucket, shared with
// POST /api/trips/[id]/plan), not the engine-seconds actually spent per
// request; a request that edits many days still costs one call to this
// route's 20/hr budget regardless of how many days it re-plans.
import { NextResponse } from "next/server";
import { getTripStore } from "@/lib/config";
import { savePlanned } from "@/lib/planStore";
import { checkRateLimit } from "@/lib/rateLimit";
import { isValidWeeklyHoursShape } from "@/lib/maps/openingHours";
import { sanitizeConstraintPatch } from "@/lib/constraints/persisted";
import type { TripDoc } from "@/lib/store/types";

// A full multi-day re-plan is a real engine solve now (up to ENGINE_BUDGET_MS
// per day set, run serially — see planStore.savePlanned/planEngine.ts); the
// platform default function timeout is too tight for that on a many-day trip.
// Mirrors app/api/pipeline/route.ts's same reasoning/value.
export const maxDuration = 120;

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
    // M1.5: additive/optional display label used in place of `date` when the
    // paste gave no real calendar date (src/lib/store/types.ts).
    if (day.dayLabel !== undefined && typeof day.dayLabel !== "string") return "day dayLabel";
    if (!Array.isArray(day.stops)) return "day stops";
    for (const s of day.stops) {
      if (typeof s.id !== "string" || typeof s.name !== "string") return "stop id/name";
      if (!s.location || !isNum(s.location.lat) || !isNum(s.location.lng)) return "stop location";
      if (!isNum(s.durationMin)) return "stop duration";
      if (s.anchor !== undefined && !isNum(s.anchor.startMin)) return "stop anchor";
      // D2.3 (T4b): duplicateOf is additive/optional — set only on a same-day
      // duplicate occurrence (see src/lib/store/types.ts, pipeline.ts's
      // markDuplicateStops). Validated like every other optional stop field.
      if (s.duplicateOf !== undefined && typeof s.duplicateOf !== "string")
        return "stop duplicateOf";
      // E3: additive/optional — reject a hand-crafted or corrupted hours
      // payload at the boundary rather than let it reach the advisory check
      // (src/lib/plan/hoursAdvisory.ts) or the constraint compiler malshaped.
      if (s.hours !== undefined && !isValidWeeklyHoursShape(s.hours)) return "stop hours";
    }
    if (day.precedence !== undefined) {
      if (!Array.isArray(day.precedence)) return "day precedence";
      for (const p of day.precedence) {
        if (typeof p.beforeId !== "string" || typeof p.afterId !== "string")
          return "precedence pair";
        if (p.reason !== undefined && typeof p.reason !== "string") return "precedence reason";
      }
    }
    if (day.manualOrder !== undefined) {
      if (!Array.isArray(day.manualOrder) || day.manualOrder.some((x) => typeof x !== "string"))
        return "day manualOrder";
    }
  }
  for (const o of doc.legOverrides) {
    if (!isNum(o.dayIndex) || typeof o.fromId !== "string" || typeof o.toId !== "string")
      return "override shape";
    if (o.mode !== "walk" && o.mode !== "drive") return "override mode";
  }
  // E6c — additive/optional home base (src/lib/store/types.ts): same
  // boundary philosophy as `hours`/`dismissedProposals` below.
  if (doc.homeBase !== undefined) {
    const hb = doc.homeBase;
    if (!hb || typeof hb.id !== "string" || typeof hb.name !== "string") return "homeBase";
    if (!hb.location || !isNum(hb.location.lat) || !isNum(hb.location.lng))
      return "homeBase location";
    if (hb.source !== "paste" && hb.source !== "user") return "homeBase source";
  }
  // E6b — additive/optional (src/lib/store/types.ts). Reject a hand-crafted
  // or corrupted dismissal list at the boundary, same philosophy as `hours`
  // above, rather than let a malshaped entry reach JournalSidebar's filter.
  if (doc.dismissedProposals !== undefined) {
    if (!Array.isArray(doc.dismissedProposals)) return "dismissedProposals";
    for (const d of doc.dismissedProposals) {
      if (!d || typeof d.id !== "string" || typeof d.dayHash !== "string") {
        return "dismissedProposals entry";
      }
    }
  }
  return null;
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { limited } = await checkRateLimit("plan-put", req);
  if (limited) {
    return NextResponse.json(
      { error: "You've been planning up a storm — give it a short breather and try again soon." },
      { status: 429 }
    );
  }
  const { id } = await ctx.params;
  const doc = (await req.json()) as TripDoc;
  const bad = malformed(doc, id);
  if (bad) return NextResponse.json({ error: `malformed trip document: ${bad}` }, { status: 400 });
  // E7 — the constraint patch is boundary-normalized: structurally invalid →
  // 400; stale/ruleless parts (unknown stops, llm-without-evidence,
  // llm-unconfirmed-hard) are dropped/clamped so what's STORED is canonical
  // (the solve projection hashes it — equivalent docs must hash equal).
  if (doc.constraints !== undefined) {
    const sane = sanitizeConstraintPatch(doc.constraints, doc);
    if (sane === null) {
      return NextResponse.json({ error: "malformed trip document: constraints" }, { status: 400 });
    }
    if (Object.keys(sane).length === 0) delete doc.constraints;
    else doc.constraints = sane;
  }
  const saved = await savePlanned(doc);
  return NextResponse.json({ doc: saved });
}
