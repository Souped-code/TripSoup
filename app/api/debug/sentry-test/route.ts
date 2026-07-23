// GET /api/debug/sentry-test — M0.3 verification route ONLY. Throws on
// purpose so a captured Sentry error can be inspected to confirm the
// beforeSend PII scrub (src/lib/observability/sentryScrub.ts) is wired up
// end-to-end. Gated so it can never fire against real users in production:
// live only in non-production runtimes, or when an operator explicitly opts
// in via DEBUG_BOARD for a one-off prod check.
import { NextResponse } from "next/server";

export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV !== "production" || process.env.DEBUG_BOARD) {
    throw new Error("Sentry test error — M0.3 verification");
  }
  return NextResponse.json({ error: "not found" }, { status: 404 });
}
