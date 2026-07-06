// POST /api/route-geometry — turn consecutive stop pairs into simplified
// road-following polylines for the reveal map's road-following pen line.
// DECORATIVE: every leg that can't be resolved comes back null and the map
// falls back to its hand-sketched line — see src/lib/maps/routeGeometry.ts's
// header for the full fail-open philosophy this route inherits (opposite of
// the matrix cache's throw-to-protect-billing design).
import { NextResponse } from "next/server";
import { createRouteGeometrySource, type GeoPoint } from "@/lib/maps/routeGeometry";
import { checkRateLimit } from "@/lib/rateLimit";

// AWS geo-routes calls can be slow one at a time and this route fans out up
// to 25 of them (capped below) at 4-in-flight — give it more room than the
// default.
export const maxDuration = 30;

// Spend guard: each leg can become a billed AWS routing call — cap per
// request (mirrors the resolve route's 40-input cap rationale). A 15-stop
// day is 14 legs; 25 leaves headroom without opening the door to abuse.
const MAX_LEGS = 25;

function isFiniteCoord(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function isValidPoint(p: unknown): p is GeoPoint {
  if (typeof p !== "object" || p === null) return false;
  const { lat, lng } = p as { lat?: unknown; lng?: unknown };
  return (
    isFiniteCoord(lat) &&
    isFiniteCoord(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export async function POST(req: Request) {
  const { limited } = await checkRateLimit("route-geometry", req);
  if (limited) {
    return NextResponse.json(
      { error: "You've been planning up a storm — give it a short breather and try again soon." },
      { status: 429 }
    );
  }

  try {
    const body = (await req.json()) as { legs?: unknown };
    const legs = body.legs;
    if (!Array.isArray(legs) || legs.length === 0 || legs.length > MAX_LEGS) {
      return NextResponse.json(
        {
          error:
            "That's an odd-sized batch of legs — send 1 to 25 at a time so the road lines can keep up.",
        },
        { status: 400 }
      );
    }

    const pairs: Array<{ from: GeoPoint; to: GeoPoint }> = [];
    for (const leg of legs) {
      if (typeof leg !== "object" || leg === null) {
        return NextResponse.json(
          { error: "each leg needs a from point and a to point" },
          { status: 400 }
        );
      }
      const { from, to } = leg as { from?: unknown; to?: unknown };
      if (!isValidPoint(from) || !isValidPoint(to)) {
        return NextResponse.json(
          { error: "each leg's from/to needs a finite lat/lng within range — one of these didn't look like a place on Earth." },
          { status: 400 }
        );
      }
      pairs.push({ from, to });
    }

    const geometries = await createRouteGeometrySource().getLegGeometries(pairs);
    return NextResponse.json({ legs: geometries });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
