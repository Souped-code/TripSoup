// E7 audit — the verification reproductions, as PERMANENT regression nets.
// The fresh-context audit proved findings 1/2/5/6 with live repro scripts;
// its verification pass was cut short (model limit) after read-verifying the
// fixes, so each repro lands here instead: stronger than a one-off script.

import { compileFromDoc } from "../compile";
import { constraintSetForSolve, sanitizeConstraintPatch } from "../persisted";
import { buildProblem } from "../../engine/problem";
import { DROP_PENALTY_SHOULD } from "../../engine/problem";
import { stableHash } from "../../util/stableHash";
import type { TripDoc } from "../../store/types";
import type { WeeklyHours } from "../types";

const HOURS: WeeklyHours = {
  byWeekday: [[], [{ startMin: 540, endMin: 1020 }], [], [], [], [], []],
};

const doc = (): TripDoc => ({
  tripId: "t-audit",
  days: [
    {
      date: "2026-07-06",
      dayStartMin: 540,
      dayEndMin: 1320,
      stops: [
        { id: "fx-01", name: "Market Hall", location: { lat: 51.45, lng: -2.6 }, durationMin: 60 },
        {
          id: "fx-03",
          name: "Guildhall Museum",
          location: { lat: 51.4491, lng: -2.5979 },
          durationMin: 60,
          hours: HOURS,
        },
      ],
    },
  ],
  settings: { walkMax: 10, driveOverheadMin: 10 },
  legOverrides: [],
});

describe("audit finding 1 — a soft must can never be cheaper to drop than a could", () => {
  it("floors the soft-must drop penalty at the should-price", () => {
    const d: TripDoc = {
      ...doc(),
      constraints: {
        stops: {
          "fx-01": {
            priority: {
              value: "must",
              provenance: { source: "llm", confirmed: false, evidence: "must see" },
              hardness: { soft: { weight: 30 } },
            },
          },
        },
      },
    };
    const set = constraintSetForSolve(d);
    const problem = buildProblem(d, set, [{}]);
    const node = problem.nodes.find((n) => n.key === "fx-01")!;
    expect(node.priority.value).toBe("must");
    expect(node.priority.hard).toBe(false);
    expect(node.dropPenalty).toBeGreaterThanOrEqual(DROP_PENALTY_SHOULD);
  });
});

describe("audit finding 2 — rank adjudicates the hours slot", () => {
  const llmHours = (confirmed: boolean) => ({
    value: { ...HOURS, lastEntryMin: 960 },
    provenance: { source: "llm" as const, confirmed, evidence: "last entry 4pm" },
    hardness: confirmed ? ("hard" as const) : { soft: { weight: 30 } },
  });

  it("google hours live in the compiled base; an unconfirmed llm lastEntry loses to them", () => {
    const base = compileFromDoc(doc());
    expect(base.stops["fx-03"].hours?.provenance.source).toBe("google");

    const d: TripDoc = { ...doc(), constraints: { stops: { "fx-03": { hours: llmHours(false) } } } };
    const merged = constraintSetForSolve(d);
    expect(merged.stops["fx-03"].hours!.provenance.source).toBe("google");
    expect(merged.stops["fx-03"].hours!.value.lastEntryMin).toBeUndefined();
  });

  it("a CONFIRMED llm lastEntry wins — carrying the real weekly hours, not an invented week", () => {
    const d: TripDoc = { ...doc(), constraints: { stops: { "fx-03": { hours: llmHours(true) } } } };
    const merged = constraintSetForSolve(d);
    const h = merged.stops["fx-03"].hours!;
    expect(h.provenance.source).toBe("llm");
    expect(h.value.lastEntryMin).toBe(960);
    expect(h.value.byWeekday[1]).toEqual([{ startMin: 540, endMin: 1020 }]);
    expect(h.value.byWeekday[0]).toEqual([]); // Monday stays closed
  });
});

describe("audit finding 5 — the boundary never stores an explicit-undefined husk", () => {
  it("an evidence-less llm slot beside a kept one drops cleanly and the patch hashes", () => {
    const sane = sanitizeConstraintPatch(
      {
        stops: {
          "fx-01": {
            window: {
              value: { startMin: 1050, endMin: 1170 },
              provenance: { source: "llm", confirmed: false }, // no evidence → dropped
              hardness: { soft: { weight: 30 } },
            },
            priority: {
              value: "should",
              provenance: { source: "llm", confirmed: false, evidence: "if we have time" },
              hardness: { soft: { weight: 30 } },
            },
          },
        },
      },
      doc()
    );
    expect(sane).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(sane!.stops!["fx-01"], "window")).toBe(false);
    // the crash the audit reproduced: canonicalJson throws on own-property undefined
    expect(() => stableHash(sane)).not.toThrow();
  });
});

describe("audit finding 6 — scoped solves keep constraints on their own occurrence", () => {
  it("a day-scoped engineDoc remaps keys instead of retargeting the duplicate", () => {
    // Market Hall visited on day 0 AND day 1: full-doc keys fx-01 / fx-01@d1.
    const full: TripDoc = {
      tripId: "t-dup",
      days: [
        {
          date: "2026-07-06",
          dayStartMin: 540,
          dayEndMin: 1320,
          stops: [{ id: "fx-01", name: "Market Hall", location: { lat: 51.45, lng: -2.6 }, durationMin: 60 }],
        },
        {
          date: "2026-07-07",
          dayStartMin: 540,
          dayEndMin: 1320,
          stops: [{ id: "fx-01", name: "Market Hall", location: { lat: 51.45, lng: -2.6 }, durationMin: 60 }],
        },
      ],
      settings: { walkMax: 10, driveOverheadMin: 10 },
      legOverrides: [],
      constraints: {
        stops: {
          // day 0's occurrence: a hard user booking; day 1's: a confirmed sunset window
          "fx-01": {
            window: { value: { startMin: 600, endMin: 660 }, provenance: { source: "user" }, hardness: "hard" },
          },
          "fx-01@d1": {
            window: {
              value: { startMin: 1050, endMin: 1170 },
              provenance: { source: "llm", confirmed: true, evidence: "sunset" },
              hardness: "hard",
            },
          },
        },
      },
    };
    // day-1-scoped solve: day 0 emptied → day 1's occurrence keys as bare fx-01
    const engineDoc: TripDoc = {
      ...full,
      days: full.days.map((d, i) => (i === 1 ? d : { ...d, stops: [] })),
    };
    const set = constraintSetForSolve(engineDoc, full);
    // Pre-fix: day-0's booked 600–660 landed here. Post-fix: day-1's own window.
    expect(set.stops["fx-01"].window!.value).toEqual({ startMin: 1050, endMin: 1170 });
    expect(set.stops["fx-01"].window!.provenance.evidence).toBe("sunset");
  });
});
