// Sentry — browser runtime init. Next.js (15.3+) auto-loads this file before
// hydration by filename convention — nothing needs to import it explicitly,
// same as instrumentation.ts on the server side. Same PII-scrub contract as
// the server/edge configs — see src/lib/observability/sentryScrub.ts.
import * as Sentry from "@sentry/nextjs";
import { sentryBeforeSend } from "@/lib/observability/sentryScrub";

// The client only ever has access to NEXT_PUBLIC_* env vars (baked in at
// build time). No DSN -> Sentry.init disables itself; init never throws.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  sendDefaultPii: false,
  beforeSend: sentryBeforeSend,
  beforeSendTransaction: sentryBeforeSend,
});
