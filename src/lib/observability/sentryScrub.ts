// Sentry event scrubbing (M0.3) — users paste private travel itineraries into
// this app (see app/api/pipeline/route.ts, which receives that text as
// `body.text`). NO pasted text, request body, or itinerary content may ever
// leave the process via Sentry. This module is the single place that
// guarantee is enforced, so beforeSend/beforeSendTransaction in every Sentry
// config (client, server, edge) must route through it.
//
// Defensive by construction: every step is optional-chained, and the whole
// thing is wrapped in try/catch. If scrubbing itself throws, we DROP the
// event (return null) rather than risk forwarding a partially-scrubbed event
// that might still carry pasted text — failing closed, not open.
import type { Event } from "@sentry/nextjs";

// Matches any extra/context/tag KEY that could plausibly hold pasted content.
// We redact by key name, not by pattern-matching the value — pasted itinerary
// text is unbounded free-form prose, so there's no reliable value-side regex.
const SENSITIVE_KEY = /paste|itinerary|text|body|raw|input|prompt|caption/i;
const REDACTED = "[redacted]";

function redactSensitiveKeys(record: Record<string, unknown> | null | undefined): void {
  if (!record || typeof record !== "object") return;
  for (const key of Object.keys(record)) {
    if (SENSITIVE_KEY.test(key)) {
      record[key] = REDACTED;
    }
  }
}

/**
 * Scrub an Event (or TransactionEvent — same shape for our purposes) in place
 * and return it. Throws are never allowed to escape; call sites still get a
 * usable event back, or should treat a thrown error as "drop the event".
 */
export function scrubSentryEvent<T extends Event>(event: T): T {
  // 1. POST bodies — e.g. the pipeline route's `{ text: "<pasted itinerary>" }`.
  if (event.request && "data" in event.request) {
    delete event.request.data;
  }

  // 2. `extra` — redact any suspiciously-named key.
  redactSensitiveKeys(event.extra as Record<string, unknown> | undefined);

  // 3. `contexts` — each named context is itself a record; redact keys inside each.
  if (event.contexts) {
    for (const ctxKey of Object.keys(event.contexts)) {
      redactSensitiveKeys(
        event.contexts[ctxKey] as unknown as Record<string, unknown> | undefined
      );
    }
  }

  // 4. `tags` — same idea, belt-and-braces beyond the extra/contexts the spec
  // calls out, since tag values are also free-form strings set by call sites.
  redactSensitiveKeys(event.tags as unknown as Record<string, unknown> | undefined);

  // 5. breadcrumbs — fetch/xhr/console breadcrumbs can embed request payloads
  // in `.data` (e.g. the fetch integration records request/response bodies).
  // Strip `data` outright rather than trying to scrub inside arbitrary shapes.
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => {
      if (!crumb || typeof crumb !== "object" || !("data" in crumb)) return crumb;
      const { data: _data, ...rest } = crumb;
      return rest;
    });
  }

  // 6. STACKTRACE FRAMES — the vector a live send-test caught (M0.3 verify).
  // Sentry's default integrations attach, per frame:
  //   - `vars`: LOCAL VARIABLE VALUES (LocalVariables integration). If any code
  //     throws while the pasted itinerary is in local scope (e.g. `text` inside
  //     the pipeline), the paste ships verbatim. This is an AUTOMATIC leak — no
  //     developer mistake required — so it must be scrubbed at the chokepoint.
  //   - `context_line`/`pre_context`/`post_context`: SOURCE lines around the
  //     frame (ContextLines). Our source is static and never contains user data,
  //     but we strip it too: on a privacy-first product, guaranteeing that
  //     NOTHING from a stack frame leaves is worth losing source context in the
  //     Sentry UI. (The error type, message, file, and line still ship.)
  // Applies to both exception and thread stacktraces.
  scrubStacktraceValues(event.exception?.values);
  scrubStacktraceValues(
    (event as { threads?: { values?: unknown } }).threads?.values
  );

  return event;
}

/** Strip runtime values + source context from every frame of every stacktrace. */
function scrubStacktraceValues(values: unknown): void {
  if (!Array.isArray(values)) return;
  for (const entry of values) {
    const frames = (entry as { stacktrace?: { frames?: unknown } } | null)
      ?.stacktrace?.frames;
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (!frame || typeof frame !== "object") continue;
      const f = frame as Record<string, unknown>;
      delete f.vars;
      delete f.context_line;
      delete f.pre_context;
      delete f.post_context;
    }
  }
}

/** beforeSend / beforeSendTransaction — shared by every Sentry.init() call site. */
export function sentryBeforeSend<T extends Event>(event: T): T | null {
  try {
    return scrubSentryEvent(event);
  } catch {
    // Fail closed: if scrubbing itself broke, don't ship a maybe-unscrubbed
    // event. Losing an error report is cheap; leaking a pasted itinerary isn't.
    return null;
  }
}
