// Fixture parse adapter (M1.3) — the parse-side twin of maps/fixtureAdapter.ts.
//
// WHY THIS EXISTS: the headline M1 feature is "paste plain text, get places".
// Only the LLM adapter can emit `placeQuery` from real free text, and tests
// must never call it (cost + determinism). Without this adapter there would be
// no way to exercise the text-only path end to end at zero spend — so the
// feature's own test suite would have to stop at the parse boundary. Spec
// §4.6 calls this a CORE task, not scaffolding, for exactly that reason.
//
// WHAT IT DOES: runs the real heuristic adapter (so day/time/order/group
// detection is the genuine shipping logic, not a second implementation), then
// enriches items that have NO url with a `placeQuery` when the line mentions a
// known Casterbridge place. Matching is a normalized substring scan over
// FIXTURE_STOPS names, longest-name-first so "Market Hall" wins over a shorter
// name that happens to be contained in it.
//
// The emitted query carries city context — "Market Hall, Casterbridge" — which
// is the same shape the LLM prompt (rule 9) asks for, so the resolve path sees
// realistic input rather than a bare token. fixtureAdapter.findFixtureStop
// strips that suffix, exactly as a real geocoder would resolve it.
//
// COST SAFETY: this adapter is selected ONLY when the fixture MAPS adapter is
// also in play (see parseItinerary.ts) — a Casterbridge placeQuery can never
// reach the real Places API, regardless of what a user pastes.

import type { ParsedItinerary, ParseProvider } from "./types";
import { createHeuristicAdapter } from "./heuristicAdapter";
import { FIXTURE_STOPS } from "../maps/fixtureCity";

const CITY = "Casterbridge";

// Longest name first: a substring scan must not let a shorter name shadow a
// longer one that contains it. Computed once at module load — FIXTURE_STOPS is
// static repo data.
const NAMES_BY_LENGTH: readonly string[] = [...FIXTURE_STOPS]
  .map((s) => s.name)
  .sort((a, b) => b.length - a.length);

// Collapses whitespace and lowercases so "the  MARKET hall," matches
// "Market Hall". Punctuation is left alone: it never appears mid-name in the
// fixture city, and stripping it would risk gluing separate words together.
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// The canonical fixture place named anywhere in `line`, or null. Returns the
// place's proper name (not the matched casing) so the query is stable.
function findNamedPlace(line: string): string | null {
  const haystack = normalize(line);
  for (const name of NAMES_BY_LENGTH) {
    if (haystack.includes(normalize(name))) return name;
  }
  return null;
}

// Mirror of the LLM prompt's rule 11 ("staying at…"), keyword-matched the way
// this whole adapter mirrors rule 9: enough for tests to exercise the
// homeBase path end to end at $0.
const ACCOMMODATION_CUE = /staying at|our hotel|check(?:\s|-)?in at|drop (?:our |the |my )?bags at|airbnb|hostel/i;

export function createFixtureParseAdapter(): ParseProvider {
  const heuristic = createHeuristicAdapter();

  return {
    async parse(text: string): Promise<ParsedItinerary> {
      const parsed = await heuristic.parse(text);

      const accommodationIdx = parsed.items.findIndex(
        (item) => ACCOMMODATION_CUE.test(item.raw) && findNamedPlace(item.raw) !== null
      );

      return {
        ...parsed,
        ...(accommodationIdx >= 0 ? { accommodationRef: accommodationIdx } : {}),
        items: parsed.items.map((item) => {
          // An item that already carries a URL resolves through that URL —
          // adding a placeQuery would create a second, competing source for
          // the same stop. Links win; this mirrors the resolve checkpoint's
          // links-first rule (pipeline.ts).
          if (item.url) return item;

          // Scan `raw` (the original line) rather than `label`: the heuristic
          // sets label = raw for standalone items, and `raw` is guaranteed
          // present. `label` is display text and is never itself a query — the
          // LOCKED rule holds here too; what we emit is a placeQuery derived
          // from a recognised place name, not the label string.
          const name = findNamedPlace(item.raw);
          if (!name) return item;

          return { ...item, placeQuery: `${name}, ${CITY}` };
        }),
      };
    },
  };
}
