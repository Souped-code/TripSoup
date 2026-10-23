# IMPROVEMENT-PLAN-2026-10.md — reliability, smoothness, engine quality

- **Date:** 2026-10-23 · **Trigger:** Chris: "my main gripe is reliability, smoothness and
  seamlessness of the UX, and that the routing engine is still far from good."
- **Branch:** `reliability-pass` (12 commits on `d0bb681`, NOT merged — `main` auto-deploys).
- **Evidence:** every claim below is tagged. [Measured] = reproduced in this session (script
  paths given); [Code] = read in the source (file:line); [Researched] = external docs via search
  extracts, not loaded directly — confirm prices with a test request before relying on them.

## The one-paragraph diagnosis

The ALNS search is not what makes plans bad. Run on a realistic Singapore trip through the
production solve path, it returns the optimum of the problem it is given — but that problem is
fiction: every stop lasts 60 minutes (Universal Studios, the Zoo, a hawker lunch alike), every
leg is a taxi or a walk of at most 10 minutes (no MRT/bus), every day leaves the hotel at 09:00
whatever is booked, a paste without day headers becomes ONE day, and the engine has no idea
which stops are meals. On top of that it spends 100–200× the compute a solve needs, so every
edit waits seconds, and production has no error reporting, no analytics, and 1-hour log
retention — so nobody can see any of this happening to real users.

## Evidence

Probe: `bench/sg-probe.ts` — a 3-day SG paste (MBS base, 18 real
places with real coordinates and Google-like hours) through `solveWithPreparedMatrices`, with a
synthetic drive matrix (road factor 1.4, 28 km/h, +3 min) because no Maps key exists here.

| # | What the user sees | Root cause | Tag |
|---|---|---|---|
| E1 | Zoo 60 min, USS 60 min, Maxwell 60 min; Zoo → Orchard → Tiong Bahru → Botanic → back north to Night Safari (255 min of taxis) | `durationMin: 60` for every stop (`pipeline.ts:497`); no duration source; no duration editing on the reveal page | [Measured][Code] |
| E2 | 18 places pasted without day headers → one day ending 08:42 the next morning, 8 conflicts, proposals "Run day 1 8h 23min later" | no day markers → one day (`pipeline.ts:520`); every stop hard-pinned to its paste day ("launch mode") although the engine supports soft day pins | [Measured][Code] |
| E3 | Zoo booked 09:00, hotel 59 min away → lands 09:59; offered "Leave out Singapore Zoo" or "Move the booking" | the base departure is bounded by the 09:00 day window; no "leave earlier" proposal existed | [Measured] — **proposal fixed** |
| E4 | Day leaves the hotel at 12:50 to avoid waiting for a 19:00 dinner (ALNS path); or finishes everything by 16:00 and idles 2h46m (exhaustive path) | objective prices wait at 0.3/min and has no "start of day" preference; the exhaustive floor's objective is travel-only; underfilled days (E1) make this worse | [Measured] |
| E5 | Every leg is "drive" (+10 min overhead) unless ≤ 10 min walking | Routes API `travelMode: "DRIVE"` only (`realAdapter.ts:44`); walk = haversine × 1.3 ÷ 80 m/min (`walkEstimator.ts`) | [Code] |
| E6 | Meals land anywhere (Maxwell at 15:00, Clarke Quay at lunch) | the engine has no place types; meal blocks exist in the constraint model but nothing populates them | [Measured][Code] |
| E7 | "Jewel Changi gets 1h 1min — it needs 1h–1h", plus Skip/Move proposals in the decision modal | float noise (1.1e-13 min) counted as a violation | [Measured] — **fixed** |
| E8 | Sidebar shows "09:60" | `fmtTime` rounded minutes after splitting hours | [Measured] — **fixed** |
| E9 | "Big day — this is Gracie's best quick route" on a 4-stop day | every ALNS day (= any day with Google hours) is labelled heuristic | [Code] — **fixed** (> 9 stops only) |
| E10 | A day with one unroutable pair (e.g. Pulau Ubin, ferry-only) is rejected whole, with raw place ids in the message | `ROUTE_NOT_FOUND` throws (`realAdapter.ts:59`) → `matrixForDay` rejects the day | [Code] |

Latency: `bench/iteration-policies.ts` (46 random fixture problems × 2 seeds).

| # | Finding | Tag |
|---|---|---|
| L1 | One day-scoped re-solve at the prod budget: 4 stops 2.1 s, 6 stops 6.3 s, 8 stops 12 s, 10 stops 16 s (this box). A 2,000-iteration solve reaches the **identical score** in 29–95 ms | [Measured] — **fixed**: 98 / 152 / 286 / 437 ms, same scores |
| L2 | Across 14 problems × 3 seeds (quality fixtures, 42-stop/6-day, single days 5–12 stops, tight days): 2k iterations = 0.00% gap to prod's 165k–500k | [Measured] |
| L3 | The iteration cap was sized to FILL a 20 s budget (`iterCapFor`), and the loop never stops on convergence (`search.ts:1410`). Policy test: prod mean gap 0.088% at median 9.9 s / p95 30.8 s; fixed 10k 0.108% at 186 ms / 853 ms; best-of-3 × 5k 0.044% at 291 ms / 1.4 s. **Caveat (fresh-context review):** on an overfull 20-stop single day (7 conflicts), 10k was up to 6% worse on 2 of 7 seeds — the old cap took ~55 s per solve on that day and also varied by seed. Overfull single days are P3's problem (day assignment), not the iteration count's | [Measured] — **fixed**: cap 10k |
| L4 | Paste pipeline is serial end to end: place resolution one link at a time (`resolvePlaces.ts:183`), matrix one origin at a time (`matrixSource.ts`, **fixed: 4 in flight**), then a Haiku constraints call, then the 20 s-budget solve | [Code] |

Observability: [Measured via Vercel API] no `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` in the
project env → Sentry is disabled in production; Hobby plan keeps runtime logs 1 hour; no web
analytics; no product events. 0 runtime errors in 7 days means nothing — nothing is recorded.

## Where better data comes from (ranked by value per hour)

1. **Our own users' trips — free, already stored.** Every TripDoc lives in prod KV as
   `trip:<id>` with real pasted stops, real Google hours, and — where the user dragged rows —
   `manualOrder`: a human correction of the engine's order. The deployment-shared matrix cache
   holds real Google drive minutes for every pair ever solved. A read-only token already exists
   (`KV_REST_API_READ_ONLY_TOKEN`). Pulling them (script ready, NOT run:
   `scratchpad/corpus/pull-trips.mjs`) gives a real-trip regression corpus at $0 and real
   drive times to replace the synthetic matrix in every probe. **Needs Chris's OK** — docs
   contain pasted text and notes; the corpus stays local/gitignored.
2. **Turn the lights on in production (hours, mostly CHRIS-STEPs).** Set `SENTRY_DSN` +
   `NEXT_PUBLIC_SENTRY_DSN` (the code is already wired and PII-scrubbed — M0); enable Vercel Web
   Analytics + Speed Insights; add ~6 product events (plan shown, row dragged = engine order
   overridden, proposal accepted/dismissed by kind, re-cook, duration edited, leg toggled).
   "% of days the user reorders" is the engine's real report card.
3. **Visit durations.** No reputable API exposes "typical time spent" (Google keeps it out of
   Places API; Outscraper scrapes it = Maps ToS §3.2.3 risk) [Researched]. Do: add
   `primaryType,types,userRatingCount` to the Places field mask — $0 extra because
   `regularOpeningHours` already bills the request at Enterprise [Researched] — map type →
   default minutes (theme park 360, zoo 240, museum 120, food court 45 …), let the parse LLM
   carry explicit durations from the paste ("half day at USS"), and make duration editable on
   the reveal sidebar. Pilot BestTime (`duration_forecast`, ~$0.08/venue) on the top ~200 SG
   attractions to calibrate the table.
4. **Transit + real walking.** Google `computeRouteMatrix` supports TRANSIT and WALK
   (WALK beta; TRANSIT ≤ 100 elements/request, `departureTime` supported) [Researched]. Fetch
   only nearest-neighbour pairs (≈100 elements/trip, not 400) to keep cost ≈ $450/mode/month
   at 1,000 trips [Researched; SKU tier for TRANSIT unconfirmed — test-bill first]. SG-only
   free alternative for verifying chosen legs: OneMap routing (pt/walk/drive, one pair per
   call, Singapore Open Data Licence). Self-hosted r5py/MOTIS on LTA's new GTFS rail feed
   (Aug 2026) is phase 2.
5. **Holiday-aware hours.** Request `currentOpeningHours` (same Enterprise tier, 7-day window
   with `specialDays`) for near trips + SG public-holiday list for the rest [Researched].
6. **Solver benchmarks (low priority).** TOPTW instances (KU Leuven OP page) test the search,
   which is not the bottleneck. Flickr User-POI visit data (8 cities, no SG) can calibrate
   durations.
7. **Cost note.** Text Search with only IDs is free; IDs-only + Place Details Enterprise is
   ≈ $380 vs ≈ $665/month today at 20k lookups [Researched].

## UX reliability audit (fresh-context agent, Playwright against a prod build, fixture maps)

Scripts/screenshots were session-local; findings re-verified after each fix with the same probes.

| # | What happens | Status |
|---|---|---|
| U1 | **Map never draws** on a device without a local "Arial" (next/font's fallback face is `local("Arial")`; `document.fonts.load` rejects the whole family). This is the "headless CI artifact" from STATE M0 — it is a product bug (Linux; Android unverified) | **fixed** — e2e without Arial 27/41 → 41/41 |
| U2 | **Phone drag-reorder doesn't respond** — the handle let the browser scroll first | **fixed** (`touch-action: none`) — emulated; real device owed |
| U3 | **Every edit wiped the map and replayed the ~9 s intro** (stops array identity) | **fixed** — toggle 9.5 → 1.8 s, re-cook 11.7 → 2.2 s, notes 12.0 → 2.4 s, no re-sketch |
| U4 | Edits made while a decision saved were **silently dropped** (sidebar showed an unsaved order) | **fixed** — sidebar busy while syncing |
| U5 | Reload / share link mid-sync **lost the decision**; a failed save re-popped the modal over its own error | **fixed** — beforeunload warning; error shown in the modal |
| U6 | Slow network (400 kbps): 4 textures (~884 KB) each time out at 12 s and retry from zero — map never appears | open — longer timeout + paint without textures as a fallback |
| U7 | 20 stops on one day: 27.6 s cook on one "simmering" line; re-cook 26.9 s with the UI frozen | mostly fixed by the 10k cap; re-measure. The second full solve after closed-day moves (`pipeline.ts:740`) still doubles small cooks |
| U8 | Unfound places vanished without a word; garbage paste → "Your route's ready" over an empty day | **fixed** for resolve failures; an empty result still needs its own message |
| U9 | Offline mid-stream → raw "Failed to fetch"; retry duplicates the trip; reload mid-cook loses the paste; 7k-emoji paste passes the client's 20k-char check but the server's 20 KB check rejects it | open |
| U10 | Failed edits show raw status codes ("save failed: 500"); notes box cleared on failure | notes **fixed**; copy open |
| U11 | Share page animates both days' maps at once: 12.5 fps desktop, 8.8 s of long tasks | open — animate only the visible map |
| U12 | "saves around 4 min" (prose, ceil) vs "saves 3 min" (card, round); "cooking · 3.1s" / "ready in 7.2s" testing timers visible to users | open — timers are Chris's testing aid (STATE 2026-07-07): remove before public launch |
| U13 | Code-only: worker crash persists a "rejected" day with the raw error; no `error.tsx`/`global-error.tsx`; PUT route has no try/catch; stream has no cancel → orphan trips | open |
| U14 | **Share link = edit access**: `/share/<id>` and `/trip/<id>` share the id and PUT has no auth — anyone with a share link can rewrite the trip | open — design decision (separate share token, or M3 auth) |
| U15 | e2e flake: `sidebar.spec:253` waits on `sidebar-reoptimize` as proof of save, but that button is always visible now | open — wait on `data-syncing`/the PUT instead |

## Shipped on `reliability-pass` (each with a test or probe that failed before)

Engine: float-noise conflicts (E7) · "Start the day earlier" proposal (E3) · iteration cap 10k (L1/L3).
Maps: 4 concurrent matrix requests (L4; stub-tested, live Routes API UNVERIFIED).
UI: 09:60 clock (E8) · "Big day" note (E9) · font-load map failure (U1) · touch drag (U2) ·
no intro replay on edits (U3) · decision-sync races (U4/U5) · notes kept on failure (U10) ·
unfound places surfaced (U8). Gates: tsc 0 · jest 482/482 · e2e 41/41 without an Arial font.

## The plan — in order, each step with its own verify

**P0 — Merge this branch (hours).** Fresh-context review → fixes → Chris does a real paste
on the Vercel preview of `reliability-pass` (real keys, shared prod KV): concurrent matrix fetch
works live, a phone drag works on a real device, map draws on an Android phone → merge.
Verify: LIVE-CHECKLIST entries for each.

**P1 — See what users hit (≈ half a day + CHRIS-STEPs).** Sentry DSN on Vercel; Web Analytics +
Speed Insights; ~6 product events; pull the KV trip corpus (with Chris's OK). Verify: a thrown
test error shows in Sentry; the corpus loads and every trip re-solves offline with real minutes.

**P2 — Durations (≈ 2–3 days; the biggest single quality jump).** Place types in the field mask
→ default minutes by type; explicit durations from the paste via the parse LLM; a duration
control on the sidebar row. Verify: `bench/sg-probe.ts` with typed stops shows Zoo ≥ 3 h,
hawker ≤ 1 h, and the Zoo/Night Safari day stays in the north.

**P3 — Day assignment (≈ 3–5 days).** A trip-length input (or inferred "3 days" in the paste);
stops without a day become soft-pinned so the engine assigns days (it already supports this —
launch mode is a pipeline choice). Verify: the 18-place no-header probe yields 3 days, each
within its window, geographically clustered.

**P4 — Day shape (≈ 2 days).** Meal windows from place type (food → soft lunch/dinner windows);
the day's start bends to the earliest booking instead of the "start earlier" proposal; drop the
exhaustive floor's travel-only objective in favour of the full one, or add a late-start cost so
days don't begin at 12:50 to avoid waiting. Verify: probe days start 09:00–10:00, meals in
windows, no idle gap > 60 min before an evening booking.

**P5 — Transit (≈ 1–2 weeks).** "How do you get around? Grab · MRT + walk · mix" setting;
TRANSIT + WALK matrices for nearest-neighbour pairs; EffectiveLeg gains `transit`; UI toggle.
Verify: test-bill one trip first; probe SG trip legs match Google Maps within ~15%.

**P6 — Remaining UX items** U6, U9, U11–U15, and an unroutable pair (ferry-only) degrading to an
estimated leg instead of rejecting the whole day (E10).

## Decisions only Chris can make

1. Merge `reliability-pass` to `main` (auto-deploys) after the preview check?
2. Pull the prod trip corpus (read-only token; stays local, never committed)?
3. Sentry DSN + Vercel Analytics on — and which product events are OK to record?
4. Order of P2–P5 (recommendation: durations → day assignment → day shape → transit).
5. Transit spend ceiling, and Grab-vs-MRT as the default mode.
6. Share links: read-only share token now, or wait for M3 auth?
