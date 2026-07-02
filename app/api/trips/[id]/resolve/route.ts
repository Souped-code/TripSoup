// POST /api/trips/[id]/resolve — resolve pasted links/names via the maps
// provider (server-side; the key never reaches the client). Returns resolved
// stops and legible failures; the client decides where to add them.
import { NextResponse } from "next/server";
import { getMapsProvider } from "@/lib/config";

export async function POST(req: Request) {
  const { inputs } = (await req.json()) as { inputs: string[] };
  if (!Array.isArray(inputs) || inputs.some((i) => typeof i !== "string")) {
    return NextResponse.json({ error: "inputs must be a string array" }, { status: 400 });
  }
  const result = await getMapsProvider().resolvePlaces(inputs.filter((i) => i.trim() !== ""));
  return NextResponse.json(result);
}
