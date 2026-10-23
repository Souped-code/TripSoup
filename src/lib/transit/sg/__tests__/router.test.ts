// The SG router against Chris's rules (2026-10-23), on the real dataset.
// Goldens assert the SHAPE a local would recognise (lines, changes, where a
// bus is allowed), not exact minutes — those move with every data refresh.

import { planSgJourney, type Journey, type JourneyStep } from "../router";
import { interchangeWalkMin, inSingapore } from "../network";
import { createRng } from "../../../util/rng";

const P = {
  universalStudios: { lat: 1.254, lng: 103.8238 },
  chinatownPoint: { lat: 1.2852, lng: 103.8448 },
  jewel: { lat: 1.3602, lng: 103.9894 },
  bugisJunction: { lat: 1.2995, lng: 103.8556 },
  zoo: { lat: 1.4043, lng: 103.793 },
  botanicTanglinGate: { lat: 1.3076, lng: 103.8155 },
  tiongBahruMarket: { lat: 1.2851, lng: 103.8326 },
  somerset313: { lat: 1.3014, lng: 103.8382 },
};

const kinds = (j: Journey | null) => j!.steps.map((s) => s.kind);
const rides = (j: Journey | null) => j!.steps.filter((s): s is Extract<JourneyStep, { kind: "mrt" }> => s.kind === "mrt");
const buses = (j: Journey | null) => j!.steps.filter((s): s is Extract<JourneyStep, { kind: "bus" }> => s.kind === "bus");

describe("SG router — trips a local would recognise", () => {
  it("Universal Studios → Chinatown: Sentosa Express, then the NEL — no bus", () => {
    const j = planSgJourney(P.universalStudios, P.chinatownPoint);
    expect(buses(j)).toHaveLength(0);
    expect(rides(j).map((r) => r.line)).toEqual(["SE", "NE"]);
  });

  it("Jewel → Bugis: airport branch, cross-platform at Tanah Merah, EWL", () => {
    const j = planSgJourney(P.jewel, P.bugisJunction);
    expect(rides(j).map((r) => r.line)).toEqual(["CG", "EW"]);
    const change = j!.steps.find((s) => s.kind === "change");
    expect(change).toMatchObject({ at: "Tanah Merah", walkMin: 1 });
    expect(rides(j)[1].towards).toBe("Tuas Link");
  });

  it("Zoo → Botanic Gardens: no station walkable, so ONE feeder bus first, then MRT", () => {
    const j = planSgJourney(P.zoo, P.botanicTanglinGate);
    const ks = kinds(j);
    expect(buses(j)).toHaveLength(1);
    expect(ks.indexOf("bus")).toBeLessThan(ks.indexOf("mrt"));
  });

  it("a direct bus is allowed when it clearly beats the MRT (Tiong Bahru → Somerset)", () => {
    const j = planSgJourney(P.tiongBahruMarket, P.somerset313);
    expect(kinds(j).filter((k) => k !== "walk")).toEqual(["bus"]);
  });
});

describe("SG router — interchange walks", () => {
  it("knows cross-platform from the long ones", () => {
    expect(interchangeWalkMin("City Hall", "NS", "EW")).toBe(1);
    expect(interchangeWalkMin("Raffles Place", "EW", "NS")).toBe(1);
    expect(interchangeWalkMin("Dhoby Ghaut", "NS", "NE")).toBeGreaterThanOrEqual(6);
  });
});

describe("SG router — rules hold on 200 random trips", () => {
  const rng = createRng(20261023);
  const point = () => ({ lat: 1.28 + rng.next() * 0.15, lng: 103.7 + rng.next() * 0.26 });
  const trips = Array.from({ length: 200 }, () => [point(), point()] as const);

  it("buses: at most one per end, never back to back, never between two trains", () => {
    for (const [a, b] of trips) {
      const j = planSgJourney(a, b);
      if (!j) continue;
      const ks = kinds(j).filter((k) => k !== "walk" && k !== "change");
      expect(ks.filter((k) => k === "bus").length).toBeLessThanOrEqual(2);
      for (let i = 1; i < ks.length; i++) expect(ks[i - 1] === "bus" && ks[i] === "bus").toBe(false);
      const firstMrt = ks.indexOf("mrt");
      const lastMrt = ks.lastIndexOf("mrt");
      ks.forEach((k, i) => {
        if (k === "bus" && firstMrt >= 0) expect(i < firstMrt || i > lastMrt).toBe(true);
      });
    }
  });

  it("every step says what a rider needs to know", () => {
    for (const [a, b] of trips) {
      const j = planSgJourney(a, b);
      if (!j) continue;
      for (const s of j.steps) {
        if (s.kind === "bus") {
          expect(s.service).toBeTruthy();
          expect(s.towards).toBeTruthy();
          expect(s.board.code).toMatch(/^\d{5}$/);
          expect(s.alight.code).toMatch(/^\d{5}$/);
          expect(s.stops).toBeGreaterThan(0);
        }
        if (s.kind === "mrt") {
          expect(s.towards ?? s.nextStop).toBeTruthy();
          expect(s.stops).toBeGreaterThan(0);
        }
        if (s.kind === "walk") expect(s.minutes).toBeLessThanOrEqual(15);
      }
      expect(j.minutes).toBeGreaterThan(0);
    }
  });

  it("is fast enough to fill a 20-stop day's matrix", () => {
    const pts = trips.slice(0, 20).map(([a]) => a);
    planSgJourney(pts[0], pts[1]); // first-use index build
    const t0 = Date.now();
    for (const a of pts) for (const b of pts) if (a !== b) planSgJourney(a, b);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("inSingapore", () => {
  it("is a bounding box around the island", () => {
    expect(inSingapore(P.zoo)).toBe(true);
    expect(inSingapore({ lat: 1.448, lng: 103.77 })).toBe(true); // Woodlands Checkpoint
    expect(inSingapore({ lat: 1.4927, lng: 103.7414 })).toBe(false); // Johor Bahru
    expect(inSingapore({ lat: 51.45, lng: -2.6 })).toBe(false);
  });
});

describe("inSingapore excludes Johor", () => {
  it("JB Sentral, Danga Bay and Legoland Malaysia are out; Woodlands and Kranji are in", () => {
    expect(inSingapore({ lat: 1.4628, lng: 103.7643 })).toBe(false); // JB Sentral
    expect(inSingapore({ lat: 1.4652, lng: 103.7187 })).toBe(false); // Danga Bay
    expect(inSingapore({ lat: 1.4269, lng: 103.6296 })).toBe(false); // Legoland Malaysia
    expect(inSingapore({ lat: 1.4536, lng: 103.7802 })).toBe(true); // Woodlands Waterfront
    expect(inSingapore({ lat: 1.4466, lng: 103.7299 })).toBe(true); // Sungei Buloh
    expect(inSingapore({ lat: 1.3, lng: 103.63 })).toBe(true); // Tuas
  });
});

describe("bus directions riders can match to the bus display", () => {
  it("a loop service names its far end, not the interchange it started from", () => {
    const j = planSgJourney({ lat: 1.3504, lng: 103.8487 }, P.zoo); // Bishan -> Zoo
    const bus = buses(j).find((b) => b.service === "138");
    expect(bus).toBeDefined();
    expect(bus!.loopVia).toBeTruthy();
    expect(bus!.loopVia).not.toBe(bus!.towards);
  });

  it("names the exit on the way out of a station", () => {
    const j = planSgJourney(P.jewel, P.bugisJunction);
    const last = j!.steps[j!.steps.length - 1];
    expect(last.kind === "walk" && last.to).toMatch(/Exit/);
  });
});
