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
