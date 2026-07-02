# itinerary-optimiser — Progress Summary (context handoff)

_Last updated: 2026-07-02_

## What this project is
A Next.js (App Router) + TypeScript app to optimise travel itineraries. Current work is a
**de-risking spike only** — proving one piece of the pipeline before any UI or optimiser is
built. Location: `C:\Users\65881\dev\itinerary-optimiser\`.

## The spike's goal (now COMPLETE ✅)
Build **one server-side module** that turns a messy list of Google Maps share links and/or
plain place names into clean, canonical place objects — resolving everything to a Google
`place_id` as the canonical key. This was explicitly a "prove the pipeline, nothing else" spike.

## Files delivered
| File | Purpose |
|---|---|
| `resolvePlaces.ts` | Core module. Exports `resolvePlaces(inputs: string[]) → Promise<{ stops: Stop[]; failures: { source; reason }[] }>`. Pure/importable, shaped to drop straight into a future Next API route. Reads key from `process.env.GOOGLE_MAPS_API_KEY` — **server-only, never sent to client**. |
| `spike.ts` | Hardcoded 10-input runner. Logs `input → place_id`, then prints full Stops + failures. |
| `parsecheck.ts` / `redircheck.ts` | Verification scripts used during the spike. |
| `.gitignore` | Ignores `.env`, `.env.*`, `node_modules/`. |
| `.env` | **Removed / purged.** Not present. To run, recreate it with a single line `GOOGLE_MAPS_API_KEY=<your_key>` (gitignored). |

## `Stop` output shape
```ts
type Stop = {
  id: string;              // Google place_id — canonical
  name: string;
  location: { lat: number; lng: number };
  address: string;
  openingHours?: unknown;  // raw Places (New) regularOpeningHours
  source: string;          // original input string, for debugging
};
// resolvePlaces returns: { stops: Stop[]; failures: { source: string; reason: string }[] }
```

## Pipeline (all steps verified working)
1. **Short goo.gl link** → server-side `fetch(url, { redirect: "follow" })` with a **browser
   User-Agent** → final full `/maps/place/…` URL via `res.url`.
2. **Parse full Maps URL** → extract place name from `/maps/place/<NAME>/` and coords from
   `@lat,lng` (fallbacks: `!3d…!4d…` data blob, `?q=lat,lng`). Hex place-refs (`0x..:0x..`)
   correctly rejected as names.
3. **Resolve to canonical** via **Places API (New) Text Search**
   (`POST https://places.googleapis.com/v1/places:searchText`, `X-Goog-Api-Key` header, field
   mask for id/displayName/formattedAddress/location/regularOpeningHours), **biased by parsed
   coords** (`locationBias.circle`, 500m radius).
4. **Plain name** → straight to step 3 (no bias).
5. **Anything that fails** → pushed to `failures` with a legible reason (404 / consent-wall /
   no-redirect / no-name / no-match are all distinct). **Never dropped silently.**

## Verification results (ran live, 3 times)
- **Run 1** (fabricated goo.gl IDs): 7/10 — the 5 full URLs + 2 plain names resolved to correct
  canonical place_ids; the 3 fake short links failed as expected.
- **Run 2** (3 real bare `maps.app.goo.gl` links): **10/10, 0 failures.**
- **Run 3** (3 real mobile `?g_st=ic` shares — ASTONS, McDonald's Bishan Park, Buffalo Wings
  Rojak Popiah): **10/10, 0 failures.**
- Cumulatively: **6 real short links (desktop + mobile formats), 5 full URLs, 2 plain names —
  all resolved correctly**, with plausible SG coords, real addresses, and opening hours.
- Coord `locationBias` proven to disambiguate chain outlets (two different "Tiong Bahru Bakery"
  place_ids from coord-biased URL vs plain name).

## Constraints honoured
Minimum code · no caching/DB/rate-limiting · only Places API (New) + `fetch`, no extra
libraries · key never reaches client.

## Known remaining edge (not a blocker)
Dropped-pin / coords-only shares (a short link that redirects to a URL with **no place name** —
e.g. `/maps/search/` or bare `@coords`) are **untested**. The code handles them defensively →
they land in `failures` with a reason rather than mis-resolving. Worth a variety test before
the optimiser depends on it, but the common desktop + mobile share paths are proven.

## How to run
```powershell
cd C:\Users\65881\dev\itinerary-optimiser
npx tsx --env-file=.env spike.ts
```

## Next step (not started)
Wrap the existing `resolvePlaces()` in a trivial `app/api/resolve/route.ts` — a few lines, since
the module is already API-shaped. After that: UI and the actual route optimiser (the project's
real purpose), neither of which exists yet.

---
**Status: spike objective met and de-risked. No open blockers.**
