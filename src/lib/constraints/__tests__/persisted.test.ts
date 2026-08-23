// E7 — the persisted constraint layer: boundary sanitization (the
// hallucination tether + soft-until-confirmed, ENFORCED IN DATA), stored-patch
// merge precedence, and the solve-time merge.

import { sanitizeConstraintPatch, mergeStoredPatches, constraintSetForSolve, LLM_SOFT_WEIGHT } from "../persisted";
import type { ConstraintPatch } from "../types";
import type { TripDoc } from "../../store/types";

const doc = (): TripDoc => ({
  tripId: "t-e7",
  days: [
    {
      date: "2026-07-06",
      dayStartMin: 540,
      dayEndMin: 1320,
      stops: [
        { id: "fx-01", name: "Market Hall", location: { lat: 51.45, lng: -2.6 }, durationMin: 60 },
        { id: "fx-02", name: "Clock Tower Square", location: { lat: 51.4536, lng: -2.5915 }, durationMin: 60 },
      ],
    },
  ],
  settings: { walkMax: 10, driveOverheadMin: 10 },
  legOverrides: [],
});

const llmWindow = (evidence?: string, hardness: ConstraintPatch["stops"] extends undefined ? never : unknown = { soft: { weight: 30 } }) => ({
  value: { startMin: 1050, endMin: 1170 },
  provenance: { source: "llm" as const, confirmed: false, ...(evidence ? { evidence } : {}) },
  hardness: hardness as "hard" | { soft: { weight: number } },
});

describe("sanitizeConstraintPatch", () => {
  it("drops an llm constraint without evidence (the tether), keeps a quoted one", () => {
    const sane = sanitizeConstraintPatch(
      {
        stops: {
          "fx-01": { window: llmWindow("sunset") },
          "fx-02": { window: llmWindow(undefined) },
        },
      },
      doc()
    );
    expect(sane).not.toBeNull();
    expect(sane!.stops!["fx-01"].window).toBeDefined();
    expect(sane!.stops!["fx-02"]).toBeUndefined();
  });

  it("clamps an llm-unconfirmed HARD constraint to soft; confirmed hard passes", () => {
    const sane = sanitizeConstraintPatch(
      {
        stops: {
          "fx-01": { window: llmWindow("by sunset", "hard") },
          "fx-02": {
            window: {
              value: { startMin: 600, endMin: 700 },
              provenance: { source: "llm", confirmed: true, evidence: "confirmed by me" },
              hardness: "hard",
            },
          },
        },
      },
      doc()
    );
    expect(sane!.stops!["fx-01"].window!.hardness).toEqual({ soft: { weight: LLM_SOFT_WEIGHT } });
    expect(sane!.stops!["fx-02"].window!.hardness).toBe("hard");
  });

  it("drops unknown stop keys and out-of-range day indexes; rejects broken shapes outright", () => {
    const sane = sanitizeConstraintPatch(
      {
        stops: { "not-a-stop": { window: llmWindow("x") } },
        days: { 5: { window: { value: { startMin: 540, endMin: 600 }, provenance: { source: "user" }, hardness: "hard" } } },
      },
      doc()
    );
    expect(sane).toEqual({});

    expect(sanitizeConstraintPatch({ stops: { "fx-01": { window: { value: { startMin: 700, endMin: 600 }, provenance: { source: "user" }, hardness: "hard" } } } }, doc())).toBeNull();
    expect(sanitizeConstraintPatch({ trip: 42 }, doc())).toBeNull();
  });

  it("user constraints pass untouched (no tether, no clamp)", () => {
    const sane = sanitizeConstraintPatch(
      {
        trip: { pacePreset: { value: "relaxed", provenance: { source: "user" }, hardness: "hard" } },
      },
      doc()
    );
    expect(sane!.trip!.pacePreset).toEqual({
      value: "relaxed",
      provenance: { source: "user" },
      hardness: "hard",
    });
  });
});

describe("mergeStoredPatches", () => {
  it("a fresh llm emission replaces the old llm one, but never a user edit", () => {
    const prevLlm: ConstraintPatch = {
      stops: { "fx-01": { window: llmWindow("old quote") } },
    };
    const nextLlm: ConstraintPatch = {
      stops: { "fx-01": { window: { ...llmWindow("new quote"), value: { startMin: 900, endMin: 960 } } } },
    };
    const replaced = mergeStoredPatches(prevLlm, nextLlm);
    expect(replaced.stops!["fx-01"].window!.value).toEqual({ startMin: 900, endMin: 960 });

    const userEdit: ConstraintPatch = {
      stops: {
        "fx-01": {
          window: { value: { startMin: 800, endMin: 860 }, provenance: { source: "user" }, hardness: "hard" },
        },
      },
    };
    const held = mergeStoredPatches(mergeStoredPatches(prevLlm, userEdit), nextLlm);
    expect(held.stops!["fx-01"].window!.provenance.source).toBe("user");
    expect(held.stops!["fx-01"].window!.value).toEqual({ startMin: 800, endMin: 860 });
  });
});

describe("constraintSetForSolve", () => {
  it("no stored patch = compileFromDoc verbatim; a stored pace overrides the derived default", () => {
    const plain = constraintSetForSolve(doc());
    expect(plain.trip.pacePreset.value).toBe("balanced");
    expect(plain.trip.pacePreset.provenance.source).toBe("derived");

    const withPace: TripDoc = {
      ...doc(),
      constraints: {
        trip: { pacePreset: { value: "relaxed", provenance: { source: "user" }, hardness: "hard" } },
      },
    };
    const merged = constraintSetForSolve(withPace);
    expect(merged.trip.pacePreset.value).toBe("relaxed");
    expect(merged.trip.pacePreset.provenance.source).toBe("user");
  });

  it("an llm window lands on the stop, soft, with its evidence carried", () => {
    const withWin: TripDoc = {
      ...doc(),
      constraints: { stops: { "fx-01": { window: llmWindow("sunset at the park") } } },
    };
    const merged = constraintSetForSolve(withWin);
    const w = merged.stops["fx-01"].window!;
    expect(w.value).toEqual({ startMin: 1050, endMin: 1170 });
    expect(w.hardness).toEqual({ soft: { weight: 30 } });
    expect(w.provenance.evidence).toBe("sunset at the park");
  });
});
