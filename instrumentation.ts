// Next.js server/edge instrumentation entrypoint (App Router convention,
// stable since Next 15 — no experimental flag needed). Runs once per runtime
// process; loads whichever Sentry config matches the actual runtime, and
// surfaces errors Next.js catches internally (Server Components, Route
// Handlers, Middleware) that would otherwise never reach
// Sentry.captureException. The PII scrub applies uniformly via each config's
// beforeSend — see src/lib/observability/sentryScrub.ts.
import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
