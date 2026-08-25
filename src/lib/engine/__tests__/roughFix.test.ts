// E7.2 — the rough-fix tier (Chris: "'Skip it' can't be the only option"):
// when a conflict's every constructive candidate got filtered for
// introducing a new (smaller) breach, the least-bad one is surfaced anyway,
// marked `imperfect` and priced honestly.

import { solveWithAlns } from "../alnsEngine";
import { docOf, problemFor, tripStop, withHours, closedOn } from "../__fixtures__/tripFixtures";

const OPTS = { seed: 4242, timeBudgetMs: 2000, iterCap: 3000 };

// Day 0 = Monday 2026-03-16 with the Monday-closed museum (unavoidable hours
// breach; the stop is a hard must, so skipping is the only CLEAN fix). Day 1
// = Tuesday, deliberately so tight that moving the museum there overruns the
// day window a little — the clean filter rejects the move, the rough tier
// must resurrect it.
const doc = () =>
  docOf([
    {
      date: "2026-03-16",
      dayStartMin: 540,
      dayEndMin: 1320,
      stops: [
        tripStop("fx-01", 60),
        withHours(tripStop("fx-03", 60), closedOn(0, 540, 1020)),
      ],
    },
    {
      date: "2026-03-17",
      dayStartMin: 540,
      dayEndMin: 645, // fx-02 fits (540–600); adding the museum overruns
      stops: [tripStop("fx-02", 60)],
    },
  ]);

describe("E7.2 rough-fix tier", () => {
  it("a closed-day conflict whose only clean fix is Skip also gets the least-bad move, marked imperfect", async () => {
    const solution = solveWithAlns(await problemFor(doc()), OPTS);

    const hoursConflict = solution.conflicts.find((c) => c.code === "hours" && c.closedDay);
    expect(hoursConflict).toBeDefined();

    const forThis = solution.proposals.filter((p) => p.resolves.includes(hoursConflict!.id));
    const skip = forThis.find((p) => p.kind === "dropStop");
    const rough = forThis.find((p) => p.kind !== "dropStop");

    expect(skip).toBeDefined();
    // The whole point: a constructive option exists alongside Skip…
    expect(rough).toBeDefined();
    // …flagged as imperfect (it introduces a smaller breach elsewhere).
    expect(rough!.imperfect).toBe(true);
  });

  it("clean fixes never carry the imperfect flag", async () => {
    // Roomy two-day trip: moving the closed-Monday museum to Tuesday is a
    // clean fix and must stay unflagged.
    const roomy = docOf([
      {
        date: "2026-03-16",
        dayStartMin: 540,
        dayEndMin: 1320,
        stops: [tripStop("fx-01", 60), withHours(tripStop("fx-03", 60), closedOn(0, 540, 1020))],
      },
      { date: "2026-03-17", dayStartMin: 540, dayEndMin: 1320, stops: [tripStop("fx-02", 60)] },
    ]);
    const solution = solveWithAlns(await problemFor(roomy), OPTS);
    const hoursConflict = solution.conflicts.find((c) => c.code === "hours" && c.closedDay);
    expect(hoursConflict).toBeDefined();
    const move = solution.proposals.find(
      (p) => p.kind === "moveDay" && p.resolves.includes(hoursConflict!.id)
    );
    expect(move).toBeDefined();
    expect(move!.imperfect).toBeUndefined();
  });
});
