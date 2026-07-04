// Fixture adapter — §3. The ONLY adapter tests and unattended development use.
// Resolution matches inputs against the synthetic city; the matrix comes from
// the fixture formula. No network, no key, no spend.

import type { ResolveResult, Stop, Failure } from "../../../resolvePlaces";
import type { MapsProvider, MatrixStop, TravelMatrix, TravelMode } from "./types";
import { FIXTURE_STOPS, fixtureDriveMinutes, type FixtureStop } from "./fixtureCity";

// Mirrors resolvePlaces.ts's isUrl test exactly — same test, same intent:
// only http(s) inputs get URL-shaped extraction; bare names/ids fall straight
// through to the existing matching below.
function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

// Fixture-mode mirror of resolvePlaces.ts's parseMapsUrl name extraction.
// This is deliberately a *simplified* echo of that logic (no redirects, no
// coords, no Places API) — it exists only so fixture mode exercises the real
// "pasted Maps URL -> place name -> resolved stop" path end to end, the same
// shape production traffic takes. Never wired into the real adapter.
function extractCandidateNameFromUrl(fullUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(fullUrl.trim());
  } catch {
    return null;
  }
  const path = decodeURIComponent(url.pathname);

  // .../maps/place/<NAME>/... (mirrors resolvePlaces.ts's placeMatch regex)
  const placeMatch = path.match(/\/(?:maps\/)?place\/([^/@]+)/);
  if (placeMatch) {
    return placeMatch[1].replace(/\+/g, " ").trim();
  }

  // ?q=<name> or ?query=<name> — URLSearchParams already decodes '+' as space.
  const q = url.searchParams.get("q") || url.searchParams.get("query");
  if (q && q.trim()) return q.trim();

  // fallback: last non-empty path segment, e.g. /search/<name>
  const segments = path.split("/").filter(Boolean);
  if (segments.length > 0) {
    return segments[segments.length - 1].replace(/\+/g, " ").trim();
  }

  return null;
}

function findFixtureStop(input: string): FixtureStop | undefined {
  // If the input is a Maps-style URL, extract the candidate place name first;
  // otherwise match on the bare name/id exactly as before.
  const candidate = isUrl(input) ? extractCandidateNameFromUrl(input) ?? input : input;
  const norm = candidate.trim().toLowerCase().replace(/,\s*casterbridge$/i, "");
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
