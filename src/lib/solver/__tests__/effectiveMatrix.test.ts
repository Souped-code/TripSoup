// P2 done-check: comparison-rule goldens, verbatim from the §5 P2 row:
//   walk 5 vs drive 10 -> walk
//   walk 8 vs drive 4 + overhead 10 -> walk
//   walk estimate beyond walkMax -> drive regardless
//   exact-walkMax boundary

import { buildEffectiveLeg, buildEffectiveMatrix, effectiveMinutes } from "../effectiveMatrix";
import { DEFAULT_SETTINGS } from "../../maps/types";

const S = DEFAULT_SETTINGS; // walkMax 10, driveOverheadMin 10

describe("comparison-rule goldens (§2)", () => {
  it("walk 5 vs drive 10 -> walk", () => {
    const leg = buildEffectiveLeg(10, 5, S);
    expect(leg.mode).toBe("walk");
    expect(effectiveMinutes(leg, S)).toBe(5);
  });

  it("walk 8 vs drive 4 + overhead 10 -> walk", () => {
    const leg = buildEffectiveLeg(4, 8, S);
    expect(leg.mode).toBe("walk"); // 8 <= 4 + 10
    expect(effectiveMinutes(leg, S)).toBe(8);
  });

  it("walk estimate beyond walkMax -> drive regardless (even when walking would be faster)", () => {
    const leg = buildEffectiveLeg(60, 10.5, S); // walk 10.5 > walkMax 10, drive raw 60
    expect(leg.mode).toBe("drive");
    expect(leg.walkMin).toBeNull(); // ineligible pairs carry no walk offer
    expect(effectiveMinutes(leg, S)).toBe(70); // drive + overhead
  });

  it("exact-walkMax boundary: walk of exactly walkMax is still eligible", () => {
    const leg = buildEffectiveLeg(60, 10, S);
    expect(leg.mode).toBe("walk"); // eligible (<=) and 10 <= 60 + 10
    expect(leg.walkMin).toBe(10);
  });

  it("eligible but slower than drive + overhead -> drive, both times retained", () => {
    const leg = buildEffectiveLeg(2, 9, S); // walk 9 vs drive 2 + 10 = 12 -> walk... check
    // 9 <= 12 so walk wins; use a case where drive genuinely wins:
    const leg2 = buildEffectiveLeg(2, 9, { ...S, driveOverheadMin: 5 }); // 9 vs 7 -> drive
    expect(leg.mode).toBe("walk");
    expect(leg2.mode).toBe("drive");
    expect(leg2.walkMin).toBe(9); // decide-then-offer: both times retained
    expect(leg2.driveMin).toBe(2);
    expect(effectiveMinutes(leg2, { ...S, driveOverheadMin: 5 })).toBe(7);
  });

  it("tie between walk and drive + overhead -> walk (deterministic)", () => {
    const leg = buildEffectiveLeg(0, 10, S); // walk 10 vs drive 0 + 10 = 10
    expect(leg.mode).toBe("walk");
  });
});

describe("buildEffectiveMatrix", () => {
  it("builds legs for every off-diagonal pair using coordinates for walk times", () => {
    const drive = { a: { a: 0, b: 3 }, b: { a: 3, b: 0 } };
    // ~157 m apart -> walk ~2.55 min, eligible; 2.55 <= 3 + 10 -> walk
    const locations = {
      a: { lat: 51.45, lng: -2.6 },
      b: { lat: 51.4512, lng: -2.5988 },
    };
    const m = buildEffectiveMatrix(drive, locations, S);
    expect(m.a.b.mode).toBe("walk");
    expect(m.a.b.walkMin).toBeGreaterThan(2);
    expect(m.a.b.walkMin).toBeLessThan(3);
    expect(m.a.b.driveMin).toBe(3);
    expect(m.a.a).toBeUndefined();
  });
});
