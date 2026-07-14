// Sentry — Node.js server runtime init. Loaded from instrumentation.ts when
// NEXT_RUNTIME === "nodejs" (route handlers, server components, the pipeline
// API). See src/lib/observability/sentryScrub.ts for why beforeSend /
// beforeSendTransaction exist: users paste private travel itineraries into
// this app (app/api/pipeline/route.ts receives that text as `body.text`),
// and none of it may ever leave this process via an error report.
import * as Sentry from "@sentry/nextjs";
import { sentryBeforeSend } from "@/lib/observability/sentryScrub";

// Server prefers SENTRY_DSN, falling back to the public one so a single DSN
// works even when only NEXT_PUBLIC_SENTRY_DSN is configured. When neither is
// set (local dev, CI, jest) dsn is undefined — Sentry.init treats that as
// "disabled" and never sends anything, and `enabled: Boolean(dsn)` makes that
// explicit rather than relying only on the SDK's implicit behavior.
const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  sendDefaultPii: false,
  beforeSend: sentryBeforeSend,
  beforeSendTransaction: sentryBeforeSend,
});
