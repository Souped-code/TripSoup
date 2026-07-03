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
  try {
    const { inputs } = (await req.json()) as { inputs: string[] };
    if (!Array.isArray(inputs) || inputs.some((i) => typeof i !== "string")) {
      return NextResponse.json({ error: "inputs must be a string array" }, { status: 400 });
    }
    const trimmed = inputs.filter((i) => i.trim() !== "");
    // Spend guard: each input can become a billed Places call — cap per request.
    if (trimmed.length > 40) {
      return NextResponse.json(
        { error: "That's a lot of stops in one go — 40 per batch, please. Split the paste and try again." },
        { status: 400 }
      );
    }
    const result = await getMapsProvider().resolvePlaces(trimmed);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
