import type { Event } from "@sentry/nextjs";
import { scrubSentryEvent, sentryBeforeSend } from "../sentryScrub";

describe("scrubSentryEvent", () => {
  it("deletes the POST body (event.request.data) entirely", () => {
    const event = {
      request: { url: "/api/pipeline", data: { text: "Day 1: fly to Tokyo, stay at..." } },
    } as unknown as Event;

    const out = scrubSentryEvent(event);

    expect(out.request?.data).toBeUndefined();
    expect(out.request?.url).toBe("/api/pipeline"); // unrelated request fields survive
  });

  it("redacts extra keys whose NAME matches the sensitive pattern, leaves others alone", () => {
    const event = {
      extra: {
        pastedItinerary: "Secret trip to Paris with Jane",
        rawInput: "more secrets",
        userAgent: "Mozilla/5.0", // unrelated, must survive
      },
    } as unknown as Event;

    const out = scrubSentryEvent(event);

    expect(out.extra?.pastedItinerary).toBe("[redacted]");
    expect(out.extra?.rawInput).toBe("[redacted]");
    expect(out.extra?.userAgent).toBe("Mozilla/5.0");
  });

  it("redacts matching keys inside every named context", () => {
    const event = {
      contexts: {
        pipeline: { requestBody: "the whole pasted itinerary", stage: "parse" },
        runtime: { name: "node", version: "24" },
      },
    } as unknown as Event;

    const out = scrubSentryEvent(event);

    expect(out.contexts?.pipeline?.requestBody).toBe("[redacted]");
    expect(out.contexts?.pipeline?.stage).toBe("parse"); // non-sensitive key survives
    expect(out.contexts?.runtime?.name).toBe("node"); // untouched context untouched
  });

  it("redacts sensitive tag keys as belt-and-braces beyond the spec's extra/contexts", () => {
    const event = {
      tags: { promptCaption: "paste contents here", route: "/api/pipeline" },
    } as unknown as Event;

    const out = scrubSentryEvent(event);

    expect((out.tags as Record<string, unknown>).promptCaption).toBe("[redacted]");
    expect((out.tags as Record<string, unknown>).route).toBe("/api/pipeline");
  });

  it("strips `data` off every breadcrumb but keeps the rest of the breadcrumb", () => {
    const event = {
      breadcrumbs: [
        { category: "fetch", message: "POST /api/pipeline", data: { body: "pasted text" } },
        { category: "ui.click", message: "clicked submit" }, // no data field at all
      ],
    } as unknown as Event;

    const out = scrubSentryEvent(event);

    expect(out.breadcrumbs?.[0]).not.toHaveProperty("data");
    expect(out.breadcrumbs?.[0].message).toBe("POST /api/pipeline");
    expect(out.breadcrumbs?.[1]).toEqual({ category: "ui.click", message: "clicked submit" });
  });

  it("strips local-variable values AND source context from exception stacktrace frames", () => {
    // The vector a live send-test caught: Sentry's LocalVariables integration
    // attaches `vars` (runtime values — the pasted itinerary if it's in scope),
    // and ContextLines attaches source lines. Both must be gone.
    const event = {
      exception: {
        values: [
          {
            type: "Error",
            value: "parse failed",
            stacktrace: {
              frames: [
                {
                  filename: "pipeline.ts",
                  lineno: 42,
                  function: "runPipeline",
                  vars: { text: "PRIVATE: Day 1 Marina Bay Sands", i: 3 },
                  context_line: '  const text = "PRIVATE: Day 1 Marina Bay Sands"',
                  pre_context: ["line before"],
                  post_context: ["line after"],
                },
              ],
            },
          },
        ],
      },
    } as unknown as Event;

    const out = scrubSentryEvent(event);
    const frame = out.exception?.values?.[0].stacktrace?.frames?.[0] as Record<string, unknown>;

    expect(frame.vars).toBeUndefined();
    expect(frame.context_line).toBeUndefined();
    expect(frame.pre_context).toBeUndefined();
    expect(frame.post_context).toBeUndefined();
    // Non-sensitive frame metadata survives (still useful for debugging).
    expect(frame.filename).toBe("pipeline.ts");
    expect(frame.lineno).toBe(42);
    expect(frame.function).toBe("runPipeline");
    // And nothing paste-shaped remains anywhere in the event.
    expect(JSON.stringify(out)).not.toContain("Marina Bay Sands");
  });

  it("also strips thread stacktrace frames (not just exception frames)", () => {
    const event = {
      threads: {
        values: [
          {
            stacktrace: {
              frames: [{ filename: "a.ts", vars: { paste: "secret itinerary" } }],
            },
          },
        ],
      },
    } as unknown as Event;

    const out = scrubSentryEvent(event);
    const frame = (out as unknown as { threads: { values: { stacktrace: { frames: Record<string, unknown>[] } }[] } })
      .threads.values[0].stacktrace.frames[0];

    expect(frame.vars).toBeUndefined();
    expect(frame.filename).toBe("a.ts");
    expect(JSON.stringify(out)).not.toContain("secret itinerary");
  });

  it("is a no-op on a bare/empty event and never throws", () => {
    expect(() => scrubSentryEvent({} as Event)).not.toThrow();
    expect(scrubSentryEvent({} as Event)).toEqual({});
  });

  it("tolerates malformed shapes (null contexts entries, non-object extra) without throwing", () => {
    const event = {
      extra: { pasteText: "secret", weird: 42 },
      contexts: { broken: null, alsoBroken: "a string, not an object" },
      breadcrumbs: [null, undefined, { data: null }],
    } as unknown as Event;

    expect(() => scrubSentryEvent(event)).not.toThrow();
  });
});

describe("sentryBeforeSend", () => {
  it("returns the scrubbed event on the happy path", () => {
    const event = { extra: { pastedText: "secret" } } as unknown as Event;
    const out = sentryBeforeSend(event);
    expect(out).not.toBeNull();
    expect(out?.extra?.pastedText).toBe("[redacted]");
  });

  it("fails closed: drops the event (returns null) rather than risk leaking on a scrub error", () => {
    // Force scrubSentryEvent to throw by making `contexts` a getter that throws
    // when Object.keys() (used internally) enumerates it — simulates a
    // malformed/hostile event shape produced by some unforeseen integration.
    const hostileEvent = {} as Event;
    Object.defineProperty(hostileEvent, "contexts", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });

    expect(() => sentryBeforeSend(hostileEvent)).not.toThrow();
    expect(sentryBeforeSend(hostileEvent)).toBeNull();
  });
});
