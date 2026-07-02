// Fixture adapter — §3. The ONLY adapter tests and unattended development use.
// Resolution matches inputs against the synthetic city; the matrix comes from
// the fixture formula. No network, no key, no spend.

import type { ResolveResult, Stop, Failure } from "../../../resolvePlaces";
import type { MapsProvider, MatrixStop, TravelMatrix, TravelMode } from "./types";
import { FIXTURE_STOPS, fixtureDriveMinutes, type FixtureStop } from "./fixtureCity";

function findFixtureStop(input: string): FixtureStop | undefined {
  const norm = input.trim().toLowerCase().replace(/,\s*casterbridge$/i, "");
  return FIXTURE_STOPS.find((s) => s.id === norm || s.name.toLowerCase() === norm);
}

export function createFixtureAdapter(): MapsProvider {
  return {
    async resolvePlaces(inputs: string[]): Promise<ResolveResult> {
      const stops: Stop[] = [];
      const failures: Failure[] = [];
      for (const input of inputs) {
        const match = findFixtureStop(input);
        if (match) {
          stops.push({
            id: match.id,
            name: match.name,
            location: match.location,
            address: match.address,
            source: input,
          });
        } else {
          failures.push({ source: input, reason: "no match in fixture city" });
        }
      }
      return { stops, failures };
    },

    async getTravelMatrix(stops: MatrixStop[], _mode: TravelMode): Promise<TravelMatrix> {
      const byId = new Map(FIXTURE_STOPS.map((s) => [s.id, s]));
      const matrix: TravelMatrix = {};
      for (const from of stops) {
        const f = byId.get(from.id);
        if (!f) throw new Error(`unknown fixture stop: ${from.id}`);
        matrix[from.id] = {};
        for (const to of stops) {
          const t = byId.get(to.id);
          if (!t) throw new Error(`unknown fixture stop: ${to.id}`);
          matrix[from.id][to.id] = fixtureDriveMinutes(f, t);
        }
      }
      return matrix;
    },
  };
}
