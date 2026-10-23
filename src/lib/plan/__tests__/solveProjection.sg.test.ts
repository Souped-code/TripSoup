// Singapore trips carry a travel-model marker so plans stored before public
// transport existed re-solve once; every other trip's hash is untouched.
import { solveProjection } from "../solveProjection";
import type { TripDoc } from "../../store/types";

const doc = (lat: number, lng: number): TripDoc => ({
  tripId: "t",
  legOverrides: [],
  settings: { walkMax: 10, driveOverheadMin: 10 },
  days: [{ date: "2026-11-02", dayStartMin: 540, dayEndMin: 1320, stops: [{ id: "a", name: "A", location: { lat, lng }, durationMin: 60 }] }],
});

describe("travel-model marker", () => {
  it("is on Singapore trips only", () => {
    expect(solveProjection(doc(1.3, 103.85)).settings).toHaveProperty("travelModel");
    expect(solveProjection(doc(51.45, -2.6)).settings).not.toHaveProperty("travelModel");
  });
});
