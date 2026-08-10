// E5a — DocPatch application. E6 renders a proposal as a button; this is what
// the button does. Two properties matter more than any individual op:
//
//   PURE — the input doc is never mutated, so a rejected proposal leaves no
//          trace and a preview can be rendered without committing.
//   TOTAL — a STALE patch (the stop moved, the day was deleted since the plan
//          was computed) is a NO-OP, not a throw and not a corruption. E6's
//          flow is "apply, validate, refresh"; a patch that half-applies is the
//          failure mode that turns a stale UI into a wrong itinerary.

import { compileFromDoc } from "../../constraints/compile";
import { applyConstraintPatch, applyDocPatch, applyPatch, keyOnDay } from "../patch";
import type { DocPatch } from "../types";
import { docOf, problemFor, tripStop } from "../__fixtures__/tripFixtures";
import type { TripDoc } from "../../store/types";

const baseDoc = (): TripDoc => ({
  ...docOf([
    {
      date: "2026-07-07",
      dayStartMin: 9 * 60,
      dayEndMin: 20 * 60,
      stops: [tripStop("fx-01", 30), tripStop("fx-02", 30, 12 * 60)],
      manualOrder: ["fx-02", "fx-01"],
    },
    {
      date: "2026-07-08",
      dayStartMin: 9 * 60,
      dayEndMin: 20 * 60,
      stops: [tripStop("fx-14", 45)],
      manualOrder: ["fx-14"],
    },
  ]),
  legOverrides: [{ dayIndex: 0, fromId: "fx-01", toId: "fx-02", mode: "walk" }],
});

describe("E5a applyDocPatch", () => {
  it("removeStop drops the stop, its leg overrides and the day's stale pinned order", () => {
    const doc = baseDoc();
    const next = applyDocPatch(doc, { op: "removeStop", dayIndex: 0, stopId: "fx-01" });
    expect(next.days[0].stops.map((s) => s.id)).toEqual(["fx-02"]);
    expect(next.days[0].manualOrder).toBeUndefined();
    expect(next.legOverrides).toEqual([]);
    expect(next.days[1]).toBe(doc.days[1]); // untouched days keep their identity
    expect(doc.days[0].stops).toHaveLength(2); // input untouched
  });

  it("moveStop relocates a stop and clears the pinned order on BOTH days", () => {
    const doc = baseDoc();
    const next = applyDocPatch(doc, {
      op: "moveStop",
      fromDayIndex: 0,
      toDayIndex: 1,
      stopId: "fx-02",
    });
    expect(next.days[0].stops.map((s) => s.id)).toEqual(["fx-01"]);
    expect(next.days[1].stops.map((s) => s.id)).toEqual(["fx-14", "fx-02"]);
    expect(next.days[0].manualOrder).toBeUndefined();
    expect(next.days[1].manualOrder).toBeUndefined();
    // The moved stop keeps its booked time — moving a day does not un-book it.
    expect(next.days[1].stops[1].anchor).toEqual({ startMin: 720 });
  });

  it("setAnchor books and un-books", () => {
    const doc = baseDoc();
    const booked = applyDocPatch(doc, {
      op: "setAnchor",
      dayIndex: 0,
      stopId: "fx-01",
      startMin: 600,
    });
    expect(booked.days[0].stops[0].anchor).toEqual({ startMin: 600 });

    const freed = applyDocPatch(booked, {
      op: "setAnchor",
      dayIndex: 0,
      stopId: "fx-02",
      startMin: null,
    });
    expect(freed.days[0].stops[1].anchor).toBeUndefined();
    expect("anchor" in freed.days[0].stops[1]).toBe(false);
  });

  it("setDuration and setDayWindow rewrite exactly one field", () => {
    const doc = baseDoc();
    expect(
      applyDocPatch(doc, { op: "setDuration", dayIndex: 0, stopId: "fx-01", durationMin: 15 })
        .days[0].stops[0].durationMin
    ).toBe(15);
    const widened = applyDocPatch(doc, { op: "setDayWindow", dayIndex: 1, endMin: 22 * 60 });
    expect(widened.days[1].dayEndMin).toBe(1320);
    expect(widened.days[1].dayStartMin).toBe(540); // untouched
  });

  it("a STALE patch is a no-op, never a throw and never a partial write", () => {
    const doc = baseDoc();
    const stale: DocPatch[] = [
      { op: "removeStop", dayIndex: 9, stopId: "fx-01" },
      { op: "removeStop", dayIndex: 0, stopId: "fx-99" },
      { op: "setAnchor", dayIndex: 9, stopId: "fx-01", startMin: 600 },
      { op: "moveStop", fromDayIndex: 0, toDayIndex: 0, stopId: "fx-01" },
      { op: "moveStop", fromDayIndex: 1, toDayIndex: 0, stopId: "fx-01" },
      { op: "setDayWindow", dayIndex: 4 },
      { op: "setDuration", dayIndex: 7, stopId: "fx-01", durationMin: 10 },
    ];
    for (const patch of stale) expect(applyDocPatch(doc, patch)).toBe(doc);
  });

  it("setPacePreset is constraint-level: the doc is untouched, the set is not", () => {
    const doc = baseDoc();
    const patch: DocPatch = { op: "setPacePreset", preset: "packed" };
    expect(applyDocPatch(doc, patch)).toBe(doc);

    const set = compileFromDoc(doc);
    expect(set.trip.pacePreset.value).toBe("balanced");
    expect(set.trip.pacePreset.provenance.source).toBe("derived");

    const patched = applyConstraintPatch(set, patch);
    expect(patched.trip.pacePreset.value).toBe("packed");
    // The human accepted the trade-off, so it is now their statement — which is
    // what makes it outrank a later `derived` default.
    expect(patched.trip.pacePreset.provenance.source).toBe("user");
    expect(patched.trip.pacePreset.hardness).toEqual(set.trip.pacePreset.hardness);
    expect(applyConstraintPatch(set, { op: "removeStop", dayIndex: 0, stopId: "fx-01" })).toBe(set);
  });

  it("applyPatch closes the loop: patched doc -> recompile -> patched set", () => {
    const doc = baseDoc();
    const { doc: nextDoc, setPatch } = applyPatch(doc, compileFromDoc(doc), {
      op: "setPacePreset",
      preset: "relaxed",
    });
    const nextSet = setPatch(compileFromDoc(nextDoc));
    expect(nextSet.trip.pacePreset.value).toBe("relaxed");
    expect(Object.keys(nextSet.stops).sort()).toEqual(["fx-01", "fx-02", "fx-14"]);
  });
});

describe("E5a keyOnDay", () => {
  it("resolves a bare stop id to its occurrence key on a given day", async () => {
    const doc = docOf([
      { date: "2026-07-07", dayStartMin: 540, dayEndMin: 1200, stops: [tripStop("fx-10", 30)] },
      { date: "2026-07-08", dayStartMin: 540, dayEndMin: 1200, stops: [tripStop("fx-10", 30)] },
    ]);
    const problem = await problemFor(doc);
    expect(keyOnDay(problem, 0, "fx-10")).toBe("fx-10");
    expect(keyOnDay(problem, 1, "fx-10")).toBe("fx-10@d1");
    expect(keyOnDay(problem, 0, "fx-99")).toBeNull();
    expect(keyOnDay(problem, 5, "fx-10")).toBeNull();
  });
});
