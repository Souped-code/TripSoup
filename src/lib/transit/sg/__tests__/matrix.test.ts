// Transit as a leg mode: Singapore legs too far to walk default to public
// transport (journey attached), walkable ones walk, driving stays a toggle,
// and anything outside Singapore is untouched.

import { DEFAULT_SETTINGS } from "../../../maps/types";
import { buildEffectiveMatrix, effectiveMinutes } from "../../../solver/effectiveMatrix";
import { applyLegModes, rescheduleDay } from "../../../schedule/schedule";
import { sgTransitFor } from "../router";

const settings = DEFAULT_SETTINGS;
const sg = {
  mbs: { lat: 1.2834, lng: 103.8607 },
  gardens: { lat: 1.2816, lng: 103.8636 },
  orchard: { lat: 1.304, lng: 103.8318 },
};
const drive = (ids: string[]) =>
  Object.fromEntries(ids.map((a) => [a, Object.fromEntries(ids.map((b) => [b, a === b ? 0 : 12]))]));

describe("transit legs (Singapore)", () => {
  const matrix = buildEffectiveMatrix(drive(Object.keys(sg)), sg, settings, sgTransitFor(settings));

  it("a leg too far to walk takes public transport, with the journey attached", () => {
    const leg = matrix.mbs.orchard;
    expect(leg.mode).toBe("transit");
    expect(leg.transit!.steps.some((s) => s.kind === "mrt")).toBe(true);
    expect(effectiveMinutes(leg, settings)).toBe(leg.transit!.minutes);
  });

  it("a walkable leg is walked, with transit still on offer", () => {
    const leg = matrix.mbs.gardens;
    expect(leg.mode).toBe("walk");
    expect(leg.transit).toBeDefined();
  });

  it("Grab is a per-leg toggle, and back again", () => {
    const toDrive = applyLegModes(matrix, [{ fromId: "mbs", toId: "orchard", mode: "drive" }]);
    expect(toDrive.mbs.orchard).toMatchObject({ mode: "drive", chosenBy: "user" });
    expect(effectiveMinutes(toDrive.mbs.orchard, settings)).toBe(12 + settings.driveOverheadMin);
    const back = applyLegModes(toDrive, [{ fromId: "mbs", toId: "orchard", mode: "transit" }]);
    expect(back.mbs.orchard.mode).toBe("transit");
  });

  it("the day plan's legs carry the journey for the sidebar", () => {
    const day = {
      date: "2026-11-02",
      dayStartMin: 540,
      dayEndMin: 1320,
      stops: [
        { id: "mbs", name: "MBS", durationMin: 60 },
        { id: "orchard", name: "Orchard", durationMin: 60 },
      ],
    };
    const plan = rescheduleDay(day, ["mbs", "orchard"], matrix, settings, "manual");
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    expect(plan.legs[0].mode).toBe("transit");
    expect(plan.legs[0].transit?.steps.length).toBeGreaterThan(0);
  });
});

describe("outside Singapore", () => {
  it("no transit, and choosing it is refused", () => {
    const uk = { a: { lat: 51.45, lng: -2.6 }, b: { lat: 51.476, lng: -2.588 } };
    const m = buildEffectiveMatrix(drive(["a", "b"]), uk, settings, sgTransitFor(settings));
    expect(m.a.b.transit).toBeUndefined();
    expect(m.a.b.mode).toBe("drive");
    expect(() => applyLegModes(m, [{ fromId: "a", toId: "b", mode: "transit" }])).toThrow(/transit-eligible/);
  });
});

describe("walking beats a slower ride", () => {
  it("walks Merlion → Gardens by the Bay (19 min) rather than a 30-min transit trip", () => {
    const pts = { merlion: { lat: 1.2868, lng: 103.8545 }, gardens: { lat: 1.2816, lng: 103.8636 } };
    const m = buildEffectiveMatrix(drive(Object.keys(pts)), pts, settings, sgTransitFor(settings));
    const leg = m.merlion.gardens;
    expect(leg.transit!.minutes).toBeGreaterThan(leg.walkMin!);
    expect(leg.mode).toBe("walk");
    expect(leg.walkMin).toBeGreaterThan(settings.walkMax);
  });
});

describe("home-base legs keep their journey through a re-time", () => {
  it("rescheduleDayWithBase carries lead/back transit steps", async () => {
    const { rescheduleDayWithBase } = await import("../../../planEngine");
    const { homeBaseMatrixId } = await import("../../../maps/types");
    const base = { id: "mbs", name: "Marina Bay Sands", location: sg.mbs, source: "paste" as const };
    const pts = { [homeBaseMatrixId("mbs")]: sg.mbs, orchard: sg.orchard, gardens: sg.gardens };
    const m = buildEffectiveMatrix(drive(Object.keys(pts)), pts, settings, sgTransitFor(settings));
    const day = {
      date: "2026-11-02",
      dayStartMin: 540,
      dayEndMin: 1320,
      stops: [{ id: "orchard", name: "Orchard", durationMin: 60 }],
    };
    const doc = {
      tripId: "t",
      legOverrides: [],
      settings: { walkMax: 10, driveOverheadMin: 10 },
      homeBase: base,
      days: [{ ...day, stops: [{ ...day.stops[0], location: sg.orchard }] }],
    };
    const plan = rescheduleDayWithBase(doc, day, ["orchard"], m, settings, "manual");
    expect(plan.status).toBe("ok");
    if (plan.status !== "ok") return;
    expect(plan.baseLegs!.lead.mode).toBe("transit");
    expect(plan.baseLegs!.lead.transit?.steps.length).toBeGreaterThan(0);
    expect(plan.baseLegs!.back.transit?.steps.length).toBeGreaterThan(0);
  });
});
