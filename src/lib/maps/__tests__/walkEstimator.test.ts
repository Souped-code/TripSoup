// P1 done-check: walk estimator goldens including exact-threshold boundary.

import {
  haversineMeters,
  isWalkEligible,
  walkMinutes,
  walkMinutesFromMeters,
} from "../walkEstimator";
import { DEFAULT_SETTINGS } from "../types";

describe("haversineMeters goldens", () => {
  // Independent reference: 1 degree of latitude (or of longitude at the
  // equator) on an R=6371 km sphere is pi*R/180 = 111,194.9266 m.
  it("1 degree latitude = 111,194.93 m", () => {
    expect(haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111194.93, 1);
  });

  it("1 degree longitude at the equator = 111,194.93 m", () => {
    expect(haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111194.93, 1);
  });

  it("zero distance for identical points", () => {
    expect(haversineMeters({ lat: 51.45, lng: -2.6 }, { lat: 51.45, lng: -2.6 })).toBe(0);
  });

  it("fixture old-town hop (Market Hall -> Clock Tower Square) is ~157 m", () => {
    const d = haversineMeters({ lat: 51.45, lng: -2.6 }, { lat: 51.4512, lng: -2.5988 });
    expect(d).toBeGreaterThan(150);
    expect(d).toBeLessThan(165);
  });
});

describe("walkMinutes goldens (detour 1.3, 80 m/min)", () => {
  it("800 m -> 13 min exactly", () => {
    // 800 * 1.3 / 80 = 13
    expect(walkMinutesFromMeters(800, DEFAULT_SETTINGS)).toBe(13);
  });

  it("400 m -> 6.5 min exactly", () => {
    expect(walkMinutesFromMeters(400, DEFAULT_SETTINGS)).toBe(6.5);
  });

  it("coordinate form matches meters form", () => {
    const a = { lat: 51.45, lng: -2.6 };
    const b = { lat: 51.4512, lng: -2.5988 };
    expect(walkMinutes(a, b, DEFAULT_SETTINGS)).toBeCloseTo(
      walkMinutesFromMeters(haversineMeters(a, b), DEFAULT_SETTINGS),
      10
    );
  });
});

describe("walk eligibility — exact-threshold boundary (§2: <= walkMax)", () => {
  it("exactly walkMax is eligible", () => {
    // Constructed to be float-exact: detour 1, 80 m/min, 800 m -> 10.0 min.
    const settings = { ...DEFAULT_SETTINGS, detourFactor: 1 };
    const min = walkMinutesFromMeters(800, settings);
    expect(min).toBe(10);
    expect(isWalkEligible(min, settings)).toBe(true);
  });

  it("just over walkMax is ineligible", () => {
    const settings = { ...DEFAULT_SETTINGS, detourFactor: 1 };
    const min = walkMinutesFromMeters(800.1, settings);
    expect(min).toBeGreaterThan(10);
    expect(isWalkEligible(min, settings)).toBe(false);
  });

  it("well under walkMax is eligible", () => {
    expect(isWalkEligible(2.5, DEFAULT_SETTINGS)).toBe(true);
  });
});
