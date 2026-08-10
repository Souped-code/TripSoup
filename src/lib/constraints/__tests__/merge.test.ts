// E2 — mergePatches: the documented precedence order, applied to every slot and
// every list member by exactly one rule.
//
//   user > llm-confirmed > google > llm-unconfirmed > derived > legacy
//
// with ties broken by "later wins" (base counts as earliest), nothing ever
// deleted, and no ability to create stops or days.

import { compileFromDoc, mergePatches } from "../compile";
import { provenanceRank, relationId, type Constraint, type ConstraintPatch, type ConstraintSet, type Hardness, type PacePreset, type Provenance, type Relation, type Window } from "../types";
import type { TripDoc, TripStop } from "../../store/types";
import { FIXTURE_STOPS } from "../../maps/fixtureCity";

const stop = (id: string, durationMin: number): TripStop => {
  const f = FIXTURE_STOPS.find((s) => s.id === id)!;
  return { id: f.id, name: f.name, location: f.location, durationMin };
};

const baseDoc = (): TripDoc => ({
  tripId: "merge-base",
  days: [
    {
      date: "2026-07-05",
      dayStartMin: 540,
      dayEndMin: 1200,
      stops: [stop("fx-01", 60), stop("fx-02", 45)],
      precedence: [{ beforeId: "fx-01", afterId: "fx-02" }],
    },
    {
      date: "2026-07-06",
      dayStartMin: 600,
      dayEndMin: 1260,
      stops: [stop("fx-03", 30)],
    },
  ],
  settings: { walkMax: 10, driveOverheadMin: 10 },
  legOverrides: [],
});

const base = (): ConstraintSet => compileFromDoc(baseDoc());

const con = <T>(value: T, provenance: Provenance, hardness: Hardness = "hard"): Constraint<T> => ({
  value,
  provenance,
  hardness,
});

// Ascending precedence, the documented order.
const ASCENDING: { label: string; provenance: Provenance }[] = [
  { label: "legacy", provenance: { source: "legacy" } },
  { label: "derived", provenance: { source: "derived" } },
  { label: "llm-unconfirmed", provenance: { source: "llm", confirmed: false } },
  { label: "google", provenance: { source: "google" } },
  { label: "llm-confirmed", provenance: { source: "llm", confirmed: true } },
  { label: "user", provenance: { source: "user" } },
];

const pacePatch = (p: Provenance, value: PacePreset): ConstraintPatch => ({
  trip: { pacePreset: con(value, p) },
});

describe("provenanceRank", () => {
  it("is a strict total order in the documented direction", () => {
    for (let i = 1; i < ASCENDING.length; i++) {
      expect(provenanceRank(ASCENDING[i].provenance)).toBeGreaterThan(
        provenanceRank(ASCENDING[i - 1].provenance)
      );
    }
  });

  it("treats an unconfirmed llm constraint as strictly weaker than a confirmed one", () => {
    expect(provenanceRank({ source: "llm" })).toBe(provenanceRank({ source: "llm", confirmed: false }));
    expect(provenanceRank({ source: "llm", confirmed: true })).toBeGreaterThan(
      provenanceRank({ source: "llm" })
    );
  });
});

describe("mergePatches — precedence", () => {
  it("returns the base unchanged when given no patches", () => {
    const b = base();
    expect(mergePatches(b)).toBe(b);
  });

  it("the highest-precedence assertion wins from ANY position in the patch list", () => {
    const patches = ASCENDING.map((p, i) => pacePatch(p.provenance, i === 5 ? "packed" : "relaxed"));
    // ascending order: user last
    expect(mergePatches(base(), ...patches).trip.pacePreset.value).toBe("packed");
    // descending order: user first, and still wins
    expect(mergePatches(base(), ...[...patches].reverse()).trip.pacePreset.value).toBe("packed");
    // and the winner keeps its own provenance, not the loser's
    expect(mergePatches(base(), ...[...patches].reverse()).trip.pacePreset.provenance).toEqual({
      source: "user",
    });
  });

  it("every higher rank beats every lower rank, in both application orders", () => {
    // On `priority` (compiled `legacy`, the bottom rank) so that the base value
    // never confounds the comparison.
    const prio = (p: Provenance, value: "should" | "could"): ConstraintPatch => ({
      stops: { "fx-01": { priority: con(value, p) } },
    });
    for (let lo = 0; lo < ASCENDING.length; lo++) {
      for (let hi = lo + 1; hi < ASCENDING.length; hi++) {
        const low = prio(ASCENDING[lo].provenance, "should");
        const high = prio(ASCENDING[hi].provenance, "could");
        expect(mergePatches(base(), low, high).stops["fx-01"].priority.value).toBe("could");
        expect(mergePatches(base(), high, low).stops["fx-01"].priority.value).toBe("could");
      }
    }
  });

  it("a LATER patch of EQUAL precedence wins, at every rank", () => {
    // `priority` compiles as `legacy`, the bottom rank, so every provenance in
    // the table can reach it and the pairs below really are ties.
    const prio = (p: Provenance, value: "should" | "could"): ConstraintPatch => ({
      stops: { "fx-01": { priority: con(value, p) } },
    });
    for (const { provenance } of ASCENDING) {
      const first = prio(provenance, "should");
      const second = prio(provenance, "could");
      expect(mergePatches(base(), first, second).stops["fx-01"].priority.value).toBe("could");
      expect(mergePatches(base(), second, first).stops["fx-01"].priority.value).toBe("should");
    }
  });

  it("the compiled base itself is the EARLIEST assertion: an equal-rank patch overrides it", () => {
    // base pace is `derived`; a derived patch of equal rank still wins the tie.
    expect(base().trip.pacePreset.provenance).toEqual({ source: "derived" });
    const merged = mergePatches(base(), pacePatch({ source: "derived" }, "packed"));
    expect(merged.trip.pacePreset.value).toBe("packed");
  });

  it("a legacy patch cannot dislodge a derived base value", () => {
    const merged = mergePatches(base(), pacePatch({ source: "legacy" }, "packed"));
    expect(merged.trip.pacePreset.value).toBe("balanced");
  });

  it("promotes an llm constraint from soft-until-confirmed to hard on user confirm (E7)", () => {
    const softWindow = con<Window>({ startMin: 600, endMin: 660 }, { source: "llm", confirmed: false }, {
      soft: { weight: 30 },
    });
    const confirmed = con<Window>(
      { startMin: 600, endMin: 660 },
      { source: "llm", confirmed: true, evidence: "we have 10am tickets" },
      "hard"
    );
    const merged = mergePatches(
      base(),
      { stops: { "fx-01": { window: softWindow } } },
      { stops: { "fx-01": { window: confirmed } } }
    );
    expect(merged.stops["fx-01"].window).toEqual(confirmed);
  });
});

describe("mergePatches — a patch never deletes what it does not mention", () => {
  it("leaves untouched slots, stops, days, relations and trip alone", () => {
    const b = base();
    const merged = mergePatches(b, {
      stops: { "fx-01": { effort: con("high", { source: "user" }) } },
    });

    expect(merged.stops["fx-01"].effort.value).toBe("high");
    // same stop, other slots
    expect(merged.stops["fx-01"].duration).toEqual(b.stops["fx-01"].duration);
    expect(merged.stops["fx-01"].priority).toEqual(b.stops["fx-01"].priority);
    expect(merged.stops["fx-01"].pinnedDay).toEqual(b.stops["fx-01"].pinnedDay);
    // other stops, and everything else
    expect(merged.stops["fx-02"]).toEqual(b.stops["fx-02"]);
    expect(merged.stops["fx-03"]).toEqual(b.stops["fx-03"]);
    expect(merged.days).toEqual(b.days);
    expect(merged.trip).toEqual(b.trip);
    expect(merged.relations).toEqual(b.relations);
  });

  it("never mutates the base it merges onto", () => {
    const b = base();
    const snapshot = JSON.stringify(b);
    mergePatches(b, {
      stops: { "fx-01": { effort: con("low", { source: "user" }) } },
      days: { 0: { paceBudget: con({ maxActiveMin: 300 }, { source: "user" }) } },
      relations: [
        {
          id: relationId({ kind: "sameDay", aId: "fx-01", bId: "fx-02" }),
          ...con({ kind: "sameDay", aId: "fx-01", bId: "fx-02" } as const, { source: "user" }),
        },
      ],
    });
    expect(JSON.stringify(b)).toBe(snapshot);
  });

  it("adds optional slots that the base never had", () => {
    const hours = con(
      { byWeekday: [[], [], [], [], [], [], []] as Window[][], lastEntryMin: 990 },
      { source: "google" }
    );
    const merged = mergePatches(base(), { stops: { "fx-02": { hours } } });
    expect(merged.stops["fx-02"].hours).toEqual(hours);
    expect(base().stops["fx-02"].hours).toBeUndefined();
  });
});

describe("mergePatches — lists merge by id", () => {
  const sameDay = (aId: string, bId: string, p: Provenance, hardness: Hardness = "hard"): Relation => {
    const value = { kind: "sameDay", aId, bId } as const;
    return { id: relationId(value), ...con(value, p, hardness) };
  };

  it("keeps base relations, replaces colliding ids by precedence, appends new ones", () => {
    const b = base();
    expect(b.relations.map((r) => r.id)).toEqual(["precedence:fx-01>fx-02"]);

    const overriding: Relation = {
      id: "precedence:fx-01>fx-02",
      ...con({ kind: "precedence", beforeId: "fx-01", afterId: "fx-02" } as const, { source: "user" }, {
        soft: { weight: 10 },
      }),
    };
    const merged = mergePatches(b, { relations: [overriding, sameDay("fx-01", "fx-02", { source: "llm" })] });

    expect(merged.relations).toHaveLength(2);
    expect(merged.relations[0]).toEqual(overriding); // base position preserved
    expect(merged.relations[1].id).toBe("sameDay:fx-01~fx-02"); // new, appended
  });

  it("canonical ids make a symmetric relation stated either way ONE constraint", () => {
    const merged = mergePatches(
      base(),
      { relations: [sameDay("fx-02", "fx-01", { source: "llm" })] },
      { relations: [sameDay("fx-01", "fx-02", { source: "user" })] }
    );
    const same = merged.relations.filter((r) => r.value.kind === "sameDay");
    expect(same).toHaveLength(1);
    expect(same[0].provenance).toEqual({ source: "user" });
  });

  it("a lower-precedence relation cannot dislodge a higher-precedence one of the same id", () => {
    const merged = mergePatches(
      base(),
      { relations: [sameDay("fx-01", "fx-02", { source: "user" })] },
      { relations: [sameDay("fx-01", "fx-02", { source: "llm" })] }
    );
    expect(merged.relations.find((r) => r.value.kind === "sameDay")!.provenance).toEqual({
      source: "user",
    });
  });

  it("merges day mealBlocks and party lists by the same rule", () => {
    const block = (id: string, startMin: number, p: Provenance) => ({
      id,
      ...con({ startMin, endMin: startMin + 60 }, p),
    });
    const merged = mergePatches(
      base(),
      { days: { 0: { mealBlocks: [block("lunch", 780, { source: "llm" })] } } },
      {
        days: { 0: { mealBlocks: [block("lunch", 800, { source: "user" }), block("dinner", 1140, { source: "llm" })] } },
        trip: {
          party: {
            walkSpeedFactor: con(1.3, { source: "user" }),
            quietBlocks: [block("nap", 840, { source: "llm" })],
          },
        },
      }
    );
    expect(merged.days[0].mealBlocks!.map((m) => m.id)).toEqual(["lunch", "dinner"]);
    expect(merged.days[0].mealBlocks![0].value.startMin).toBe(800);
    expect(merged.days[1].mealBlocks).toBeUndefined();
    expect(merged.trip.party!.walkSpeedFactor!.value).toBe(1.3);
    expect(merged.trip.party!.quietBlocks!.map((q) => q.id)).toEqual(["nap"]);
  });
});

describe("mergePatches — patches cannot create stops or days", () => {
  it("ignores an unknown stop id", () => {
    const merged = mergePatches(base(), {
      stops: { "fx-99": { effort: con("high", { source: "user" }) } },
    });
    expect(merged.stops["fx-99"]).toBeUndefined();
    expect(Object.keys(merged.stops).sort()).toEqual(["fx-01", "fx-02", "fx-03"]);
  });

  it("ignores an out-of-range or unparseable day key", () => {
    const b = base();
    const merged = mergePatches(b, {
      days: {
        7: { window: con({ startMin: 0, endMin: 1440 }, { source: "user" }) },
        [-1]: { window: con({ startMin: 0, endMin: 1440 }, { source: "user" }) },
      },
    });
    expect(merged.days).toHaveLength(2);
    expect(merged.days).toEqual(b.days);
  });

  it("still applies the in-range parts of a partly-stale patch", () => {
    const merged = mergePatches(base(), {
      stops: {
        "fx-99": { effort: con("high", { source: "user" }) },
        "fx-01": { effort: con("low", { source: "user" }) },
      },
      days: { 5: { window: con({ startMin: 0, endMin: 1 }, { source: "user" }) } },
    });
    expect(merged.stops["fx-01"].effort.value).toBe("low");
    expect(merged.stops["fx-99"]).toBeUndefined();
  });
});
