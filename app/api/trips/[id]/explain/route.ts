// GET /api/trips/[id]/explain?day=<index> — E6b decorative prose explaining
// the active day's trade-off cards (src/lib/prose/explainTradeoffs.ts).
// Read-only: reads the STORED plan, never triggers a solve (mirrors the
// share page's "zero compute on read" invariant) — a plan that hasn't been
// computed yet simply has no conflicts, so there is nothing to explain.
// Rate-limited (rateLimit.ts's "prose" bucket) since the LLM path bills per
// call; the fixture path is $0 either way. Never called from the share page.
//
// Response is always 200 with `{ prose: string | null }` — prose failures are
// decorative and logged server-side (explainTradeoffs itself never throws);
// this route only 4xx/5xxs on a genuinely bad request or a missing trip.
import { NextResponse } from "next/server";
import { getTripStore } from "@/lib/config";
import { checkRateLimit } from "@/lib/rateLimit";
import { explainTradeoffs } from "@/lib/prose/explainTradeoffs";
import { isConflictDismissed } from "@/lib/planShared";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { limited } = await checkRateLimit("prose", req);
  if (limited) {
    return NextResponse.json(
      { error: "You've been asking Gracie to explain a lot — give it a short breather." },
      { status: 429 }
    );
  }

  const { id } = await ctx.params;
  const doc = await getTripStore().get(id);
  if (!doc) return NextResponse.json({ error: "trip not found" }, { status: 404 });

  const url = new URL(req.url);
  const dayParam = url.searchParams.get("day");
  const dayIndex = dayParam !== null && Number.isInteger(Number(dayParam)) ? Number(dayParam) : null;

  const allConflicts = doc.plan?.conflicts ?? [];
  const allProposals = doc.plan?.proposals ?? [];
  // Same "day-scoped or trip-level" visibility JournalSidebar renders: this
  // day's conflicts plus any dayIndex-less (trip-global) ones, minus whatever
  // is currently dismissed — explaining a dismissed card would be a stray
  // prose paragraph for a card the user already told Gracie to drop.
  const visible = allConflicts.filter(
    (c) =>
      (dayIndex === null || c.dayIndex === dayIndex || c.dayIndex === undefined) &&
      !isConflictDismissed(doc, c)
  );
  const visibleIds = new Set(visible.map((c) => c.id));
  const relevantProposals = allProposals.filter((p) => p.resolves.some((r) => visibleIds.has(r)));

  const prose = await explainTradeoffs({ conflicts: visible, proposals: relevantProposals });
  return NextResponse.json({ prose });
}
