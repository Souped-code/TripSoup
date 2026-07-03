// POST /api/trips/[id]/resolve — resolve pasted links/names via the maps
// provider (server-side; the key never reaches the client). Returns resolved
// stops and legible failures; the client decides where to add them.
import { NextResponse } from "next/server";
import { getMapsProvider } from "@/lib/config";
import { checkRateLimit } from "@/lib/rateLimit";

export async function POST(req: Request) {
  const { limited } = await checkRateLimit("resolve", req);
  if (limited) {
    return NextResponse.json(
      { error: "You've been planning up a storm — give it a short breather and try again soon." },
      { status: 429 }
    );
  }
  const { inputs } = (await req.json()) as { inputs: string[] };
  if (!Array.isArray(inputs) || inputs.some((i) => typeof i !== "string")) {
    return NextResponse.json({ error: "inputs must be a string array" }, { status: 400 });
  }
  const result = await getMapsProvider().resolvePlaces(inputs.filter((i) => i.trim() !== ""));
  return NextResponse.json(result);
}
