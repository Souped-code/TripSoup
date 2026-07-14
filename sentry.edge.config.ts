// Sentry — Edge runtime init. Loaded from instrumentation.ts when
// NEXT_RUNTIME === "edge" (edge middleware / edge route handlers, if any run
// there). Same PII-scrub contract as sentry.server.config.ts — see
// src/lib/observability/sentryScrub.ts.
import * as Sentry from "@sentry/nextjs";
import { sentryBeforeSend } from "@/lib/observability/sentryScrub";

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  sendDefaultPii: false,
  beforeSend: sentryBeforeSend,
  beforeSendTransaction: sentryBeforeSend,
});
