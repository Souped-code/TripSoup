// D2.3 (T2): the old editable trip board, relocated from /trip/[id] to
// /debug/trip/[id] per the master plan (old board -> /debug, env-gated, its
// Playwright specs updated to hit /debug, kept green). Same gate as
// app/debug/design/page.tsx and app/debug/pipeline/page.tsx: notFound()
// unless DEBUG_BOARD=1, so it never appears in a normal production build.
// This Server Component only enforces the gate; the interactive board is
// TripBoard (client component) — see src/ui/board/TripBoard.tsx for why the
// gate check can't just live inline in a "use client" file.
import { notFound } from "next/navigation";
import { TripBoard } from "@/ui/board/TripBoard";

export default function TripBoardPage({ params }: { params: Promise<{ id: string }> }) {
  if (process.env.DEBUG_BOARD !== "1") notFound();
  return <TripBoard params={params} />;
}
