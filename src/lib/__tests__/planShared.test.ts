// E6b — applyDocPatch (client-side accept flow) + dismissal keying. Pure unit
// tests, no server-only deps — this module must stay importable from
// "use client" components, which is exactly what makes it testable this way.

import { applyDocPatch, dismissalKeyForConflict, isConflictDismissed } from "../planShared";
import type { DocPatch, Conflict } from "../engine/types";
import type { TripDoc } from "../store/types";

function baseDoc(): TripDoc {
  return {
    tripId: "t-1",
    days: [
      {
        date: "2026-08-17",
        dayStartMin: 540,
        dayEndMin: 1200,
        stops: [
          { id: "a", name: "A", location: { lat: 0, lng: 0 }, durationMin: 30 },
          { id: "b", name: "B", location: { lat: 0, lng: 0 }, durationMin: 30, anchor: { startMin: 700 } },
        ],
      },
      {
        date: "2026-08-18",
        dayStartMin: 540,
        dayEndMin: 1200,
        stops: [{ id: "c", name: "C", location: { lat: 0, lng: 0 }, durationMin: 30 }],
      },
    ],
    settings: { walkMax: 10, driveOverheadMin: 10 },
    legOverrides: [{ dayIndex: 0, fromId: "a", toId: "b", mode: "walk" }],
  };
}

describe("applyDocPatch — removeStop", () => {
  it("removes the stop and any legOverrides touching it", () => {
    const doc = baseDoc();
    const patch: DocPatch = { op: "removeStop", dayIndex: 0, stopId: "a" };
    const result = applyDocPatch(doc, patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.days[0].stops.map((s) => s.id)).toEqual(["b"]);
    expect(result.doc.legOverrides).toEqual([]);
    // untouched day / original doc unmutated
    expect(result.doc.days[1]).toBe(doc.days[1]);
    expect(doc.days[0].stops).toHaveLength(2);
  });

  it("clears manualOrder on the touched day", () => {
    const doc = baseDoc();
    doc.days[0].manualOrder = ["b", "a"];
    const result = applyDocPatch(doc, { op: "removeStop", dayIndex: 0, stopId: "a" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.days[0].manualOrder).toBeUndefined();
  });

  it("reports staleness for a day that no longer exists", () => {
    const doc = baseDoc();
    const result = applyDocPatch(doc, { op: "removeStop", dayIndex: 9, stopId: "a" });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("day") });
  });

  it("reports staleness for a stop already gone", () => {
    const doc = baseDoc();
    const result = applyDocPatch(doc, { op: "removeStop", dayIndex: 0, stopId: "zzz" });
    expect(result.ok).toBe(false);
  });
});

describe("applyDocPatch — setAnchor", () => {
  it("sets a new anchor time", () => {
    const doc = baseDoc();
    const result = applyDocPatch(doc, { op: "setAnchor", dayIndex: 0, stopId: "a", startMin: 800 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.days[0].stops[0].anchor).toEqual({ startMin: 800 });
  });

  it("un-books with startMin: null", () => {
    const doc = baseDoc();
    const result = applyDocPatch(doc, { op: "setAnchor", dayIndex: 0, stopId: "b", startMin: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.days[0].stops[1].anchor).toBeUndefined();
  });

  it("reports staleness when the stop is gone", () => {
    const doc = baseDoc();
    const result = applyDocPatch(doc, { op: "setAnchor", dayIndex: 0, stopId: "zzz", startMin: 800 });
    expect(result.ok).toBe(false);
  });
});

describe("applyDocPatch — setDayWindow / setDuration / moveStop", () => {
  it("setDayWindow updates only the given bound(s)", () => {
    const doc = baseDoc();
    const result = applyDocPatch(doc, { op: "setDayWindow", dayIndex: 0, endMin: 1260 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.days[0].dayStartMin).toBe(540);
    expect(result.doc.days[0].dayEndMin).toBe(1260);
  });

  it("setDuration trims a stop's duration", () => {
    const doc = baseDoc();
    const result = applyDocPatch(doc, { op: "setDuration", dayIndex: 0, stopId: "a", durationMin: 15 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.days[0].stops[0].durationMin).toBe(15);
  });

  it("moveStop relocates a stop and drops its legOverrides on the FROM day", () => {
    const doc = baseDoc();
    const result = applyDocPatch(doc, { op: "moveStop", fromDayIndex: 0, toDayIndex: 1, stopId: "a" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.days[0].stops.map((s) => s.id)).toEqual(["b"]);
    expect(result.doc.days[1].stops.map((s) => s.id)).toEqual(["c", "a"]);
    expect(result.doc.legOverrides).toEqual([]);
  });

  it("moveStop to the same day is a reported no-op", () => {
    const doc = baseDoc();
    const result = applyDocPatch(doc, { op: "moveStop", fromDayIndex: 0, toDayIndex: 0, stopId: "a" });
    expect(result.ok).toBe(false);
  });

  it("moveStop for a stop already gone is stale", () => {
    const doc = baseDoc();
    const result = applyDocPatch(doc, { op: "moveStop", fromDayIndex: 0, toDayIndex: 1, stopId: "zzz" });
    expect(result.ok).toBe(false);
  });
});

describe("applyDocPatch — setPacePreset (honest gap)", () => {
  it("is reported as not-applicable rather than silently accepted-but-inert", () => {
    const doc = baseDoc();
    const result = applyDocPatch(doc, { op: "setPacePreset", preset: "packed" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/pace/i);
  });
});

describe("dismissalKeyForConflict / isConflictDismissed", () => {
  function docWithPlan(): TripDoc {
    const doc = baseDoc();
    return {
      ...doc,
      plan: {
        version: 1,
        engine: { name: "alns-ts", version: "1", seed: 1 },
        computedAt: new Date().toISOString(),
        solveHash: "solve-hash-1",
        dayHashes: ["day-hash-0", "day-hash-1"],
        days: [],
      },
    };
  }

  const conflict: Conflict = {
    id: "hours|0|stops.a.hours|a",
    code: "hours",
    stopIds: ["a"],
    dayIndex: 0,
    violatedByMin: 0,
    constraintRef: { path: "stops.a.hours", provenance: { source: "google" } },
    message: "closed",
  };

  it("keys to the conflict's own day hash", () => {
    const doc = docWithPlan();
    expect(dismissalKeyForConflict(doc, conflict)).toBe("day-hash-0");
  });

  it("falls back to solveHash for a dayIndex-less (trip-level) conflict", () => {
    const doc = docWithPlan();
    expect(dismissalKeyForConflict(doc, { dayIndex: undefined })).toBe("solve-hash-1");
  });

  it("returns null when there's no stored plan yet", () => {
    const doc = baseDoc();
    expect(dismissalKeyForConflict(doc, conflict)).toBeNull();
  });

  it("isConflictDismissed is false with no dismissal recorded", () => {
    const doc = docWithPlan();
    expect(isConflictDismissed(doc, conflict)).toBe(false);
  });

  it("isConflictDismissed is true once dismissed at the current day hash", () => {
    const doc = { ...docWithPlan(), dismissedProposals: [{ id: conflict.id, dayHash: "day-hash-0" }] };
    expect(isConflictDismissed(doc, conflict)).toBe(true);
  });

  it("a dismissal expires when the day's hash changes (the day was edited)", () => {
    const doc = {
      ...docWithPlan(),
      dismissedProposals: [{ id: conflict.id, dayHash: "STALE-day-hash-0" }],
    };
    expect(isConflictDismissed(doc, conflict)).toBe(false);
  });

  it("a dismissal for a different conflict id doesn't match", () => {
    const doc = { ...docWithPlan(), dismissedProposals: [{ id: "some-other-id", dayHash: "day-hash-0" }] };
    expect(isConflictDismissed(doc, conflict)).toBe(false);
  });
});
