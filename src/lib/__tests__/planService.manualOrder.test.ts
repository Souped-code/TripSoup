// D2.3 (audit finding 12): manualOrder skips the solver and retimes the
// user-pinned order. Fixture mode only (no key → fixture provider), same
// cost-guard as every other suite.
import { planTripDay } from "../planService";
import type { TripDoc, TripStop } from "../store/types";
import { FIXTURE_STOPS } from "../maps/fixtureCity";

const stop = (id: string, extra: Partial<TripStop> = {}): TripStop => {
  const f = FIXTURE_STOPS.find((s) => s.id === id)!;
  return { id: f.id, name: f.name, location: f.location, durationMin: 60, ...extra };
};

// Four walkable old-town stops → always feasible in the fixture city.
const baseDoc = (day: Partial<TripDoc["days"][number]>): TripDoc => ({
  tripId: "t1",
  days: [
    {
      date: "2026-07-05",
      dayStartMin: 540,
      dayEndMin: 1320,
      stops: [stop("fx-01"), stop("fx-02"), stop("fx-03"), stop("fx-04")],
      ...day,
    },
  ],
  settings: { walkMax: 10, driveOverheadMin: 10 },
  legOverrides: [],
});

describe("planTripDay manualOrder (D2.3)", () => {
  it("honors a valid manual order verbatim and labels it 'manual'", async () => {
    const manualOrder = ["fx-04", "fx-03", "fx-02", "fx-01"];
    const plan = await planTripDay(baseDoc({ manualOrder }), 0);
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    expect(plan.quality).toBe("manual");
    expect(plan.order).toEqual(manualOrder); // exactly the pinned order, solver skipped
  });

  it("ignores a stale/invalid manual order and lets the solver own ordering", async () => {
    // Wrong length + an unknown id → not a permutation of the day's stops.
    const plan = await planTripDay(baseDoc({ manualOrder: ["fx-01", "fx-99"] }), 0);
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    expect(plan.quality).not.toBe("manual"); // fell back to the solver
  });

  it("a manual order that breaks an anchor's time is reported infeasible", async () => {
    // fx-02 must START at the day's opening (09:00), but the manual order puts
    // fx-01 (60m) ahead of it, so fx-02 cannot begin at 540 → infeasible.
    const days = baseDoc({}).days;
    days[0].stops = [stop("fx-01"), stop("fx-02", { anchor: { startMin: 540 } })];
    const doc: TripDoc = {
      ...baseDoc({}),
      days: [{ ...days[0], manualOrder: ["fx-01", "fx-02"] }],
    };
    const plan = await planTripDay(doc, 0);
    expect(plan.status).toBe("infeasible");
  });
});
