// POST /api/trips — create a trip with one empty day.
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getTripStore } from "@/lib/config";
import type { TripDoc } from "@/lib/store/types";

export async function POST() {
  const tripId = randomBytes(6).toString("hex");
  const doc: TripDoc = {
    tripId,
    days: [{ date: new Date().toISOString().slice(0, 10), dayStartMin: 540, dayEndMin: 1320, stops: [] }],
    settings: { walkMax: 10, driveOverheadMin: 10 },
    legOverrides: [],
  };
  await getTripStore().put(doc);
  return NextResponse.json(doc);
}
