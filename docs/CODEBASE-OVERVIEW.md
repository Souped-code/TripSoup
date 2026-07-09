# TripSoup — codebase overview (for Polsia)

A technical map of the codebase: structure, key files, how the optimizer works, how the map
engine renders, and what's wired vs still stubbed. Written so an AI advisor can retain durable
context and write precise implementation briefs.

> Product context (short): paste a messy itinerary (Maps links / plain text) → an optimized,
> timed, day-by-day plan shown as a hand-drawn "journal map" you can reorder and share.
> Monetized by a one-time SGD 6.90 Trip Pass (payments not built yet).

---

## 1. Stack & shape

- **Next.js 15 (App Router), React 19, TypeScript.** Deployed on **Vercel**, auto-deploys from `main`.
- **Persistence:** Vercel KV (Upstash Redis) in prod; a file store for local/dev/tests.
- **External services (all cost-gated):** Google Places API (New) `searchText`; Google Routes API
  `computeRouteMatrix`; AWS Location / GrabMaps `geo-routes v2`; Anthropic `claude-haiku-4-5`.
- **Map:** a bespoke canvas render engine (Rough.js + AI watercolor textures over OpenFreeMap
  vector tiles) — **not** MapLibre.
- **Testing:** jest (119 unit), Playwright (26 e2e), fixture mode (zero external spend),
  `@axe-core/playwright` (a11y gate).

**Layering (strict, one direction):** pure engine (`src/lib/*`, no React/HTTP) → API routes
(`app/api/*`) → UI (`src/ui/*`, `app/*`). The engine is deterministic and I/O-free except the
adapters.

```
resolvePlaces.ts                 # repo ROOT: Maps link / place-name -> canonical Google place_id + coords
src/lib/
  parse/          types.ts (ParsedItinerary zod contract) · heuristicAdapter.ts · llmAdapter.ts (claude-haiku-4-5) · parseItinerary.ts (provider select)
  maps/           types.ts (MapsProvider port, Settings) · fixtureAdapter.ts · realAdapter.ts (Routes API) · fixtureCity.ts (20-stop fixture) ·
                  matrixSource.ts (cache+batching) · kvMatrixCache.ts · walkEstimator.ts · routeGeometry.ts (AWS road pen proxy)
  solver/         types.ts · effectiveMatrix.ts (walk/drive decide-then-offer) · solver.ts (optimize())
  schedule/       types.ts · schedule.ts (planDay / rescheduleDay / applyLegModes / validateDay)
  pipeline/       pipeline.ts (runPipeline generator + parseTimeHint)
  store/          types.ts (TripDoc/TripDay/TripStop, TripStore port) · fileStore.ts · kvStore.ts
  map/            map-render-core.js (the render engine) · map-style-defaults.mjs (LOCKED art config)
  config.ts       # adapter + store wiring (which impl serves this process)
  planService.ts  # planTripDay / rescheduleDay — bridges store doc -> solver/schedule
  rateLimit.ts    # per-IP fixed-window limiter (KV); no-ops without KV
app/
  page.tsx                         # landing (post-it hero)
  trip/[id]/page.tsx               # reveal (journal map + sidebar)
  share/[id]/page.tsx              # read-only share
  layout.tsx                       # global chrome (TripSoup wordmark home nav)
  api/pipeline/route.ts            # POST -> SSE stream of runPipeline
  api/trips/route.ts               # POST create
  api/trips/[id]/route.ts          # GET / PUT
  api/trips/[id]/resolve/route.ts  # POST resolve URLs (server-side; key never hits client)
  api/trips/[id]/plan/route.ts     # POST re-plan a day
  api/route-geometry/route.ts      # POST AWS road-geometry proxy
  debug/{design,pipeline,trip,trip/[id]}   # env-gated DEBUG_BOARD=1 (dev only)
src/ui/
  greeting/Greeting.tsx            # landing client (paste -> pipeline)
  pipeline/{LoadingView,usePipeline,PipelineDebug}
  reveal/{RevealClient,RevealMap,JournalSidebar,ShareTimeline}.tsx + reveal.css
  journal/{PaperCard,JournalInput,InkButton,SketchDivider,GracieScene,WashiTag}.tsx  # design-system atoms
  board/{TripBoard,NewTripButton}.tsx  # LEGACY editable board, now behind /debug
  PlanView.tsx                     # LEGACY text timeline (still used by /debug board)
docs/superpowers/specs/2026-07-09-itinerary-interpretation-design.md  # approved spec, not built
STATE.md                          # the phase-by-phase build ledger (~1,200 lines, tool-verified)
design.md                         # the design system (palette/type/mascot/art rules)
```

---

## 2. Core data model (`src/lib/store/types.ts`)

- **`TripDoc`** = `{ tripId, days: TripDay[], settings: { walkMax, driveOverheadMin }, legOverrides[] }`.
- **`TripDay`** = `{ date, dayStartMin, dayEndMin, stops: TripStop[], manualOrder?, precedence?, ... }`.
  (`manualOrder` = a user-pinned order; `precedence` = intra-day "before" constraints.)
- **`TripStop`** = `{ id (=place_id, or `place#2` for same-place duplicates), name, location{lat,lng},
  address, durationMin, source, anchor?{startMin}, duplicateOf? }`.
- Times are **minutes-from-midnight** throughout; scheduling never uses wall-clock dates.

---

## 3. The pipeline (paste → plan) — `src/lib/pipeline/pipeline.ts`

`runPipeline(text)` is an **async generator** that yields progress and returns a result; the
`/api/pipeline` route streams it as SSE. Stages (with progress weights):

1. **parse (0→15):** `parseItinerary(text)` → a zod-validated `ParsedItinerary`.
2. **resolve (15→55):** collect `item.url` for `kind:"link"` items → `resolvePlaces(urls)` →
   `Stop`s. **Capped at 40 lookups/paste** (overflow → failure-panel entries).
   **LOCKED policy:** only extracted URLs reach Places — `label`/`raw` text is never a query.
3. **assemble:** each resolved item → a `TripStop` (label overrides display name; `timeHint`+
   `anchorLikely` → `anchor`). Days come from `parsed.days` (or one day if none). Same-place
   duplicates within a day are flagged (`place#2` + `duplicateOf`), never dropped. `orderConstraint`
   → `day.precedence`.
4. **matrix + solve (55→100), per day:** `planTripDay(doc, i)` pulls the driving travel matrix
   (cached) then runs the solver + schedule builder.

Idempotent/resumable: re-running the same text re-derives the same stop ids, so the matrix cache
(keyed `(fromId,toId,mode)`) resumes instead of re-billing.

### Parse contract (`src/lib/parse/types.ts`)
`ParsedItinerary = { items: ParsedItem[], days: {dateHint?, itemRefs[]}[], splitGroups[] }`.
`ParsedItem = { kind:"link"|"label", raw, url?, label?, dateHint?, timeHint?, anchorLikely,
anchorReason?, orderConstraint?{before[], reason}, groupHint? }`. Two adapters implement the port:
- **heuristicAdapter** — regex URL extraction + line-adjacency labels + time/day/group markers. The
  free, no-key, test path.
- **llmAdapter** — `claude-haiku-4-5`, temp 0, strict-JSON system prompt, zod-validated with 2
  retries feeding the error back. **Server-only, construction-throws without a key** (a jest guard
  forbids tests importing it). Live in prod (`PARSE_PROVIDER=llm`).

---

## 4. The optimizer — `src/lib/solver/solver.ts` (pure, deterministic, LOCKED)

`optimize(segment, matrix, settings, precedence) -> { status:"ok", order, schedule, quality } |
{status:"infeasible", constraint, violatedByMin, message} | {status:"rejected", message}`.

A **segment** is a run of flexible stops between two fixed boundaries (day-start/anchor →
next-anchor/day-end). The schedule layer (§5) splits a day into segments at anchors and calls the
solver per segment.

- **Caps:** `n > maxHeuristic (15)` → **rejected** (actionable message). `n ≤ maxExhaustive (9)` →
  exhaustive; `10–15` → heuristic.
- **Exhaustive:** enumerate permutations in **lexicographic stop-id order**; keep the
  precedence-satisfying feasible order with least total travel. Determinism: lexicographic
  enumeration + strict-improvement → ties resolve to the lexicographically smallest order; input
  array order never matters.
- **Heuristic (10–15):** topological-greedy **nearest-neighbour** seed (only precedence-eligible
  stops considered; without a start anchor, try each valid first stop, keep the best chain) +
  **2-opt** refinement (reverse `[i..j]` while it strictly improves travel AND keeps every
  precedence pair satisfied). Labelled `quality:"heuristic"`.
- **Precedence** = intra-segment "before" pairs. `findPrecedenceCycle` (DFS, sorted ids) names an
  unorderable loop; on time-window infeasibility it distinguishes *precedence caused it* (names the
  pair the precedence-free optimum breaks) from a plain window miss (`anchor-start:<id>` /
  `day-window` with minutes missed). All messages are journal-voice + actionable.
- **`evaluateOrder`** walks the order, clocking arrive/depart per stop using **effective** leg
  minutes (§4a), and reports feasibility against the segment's end boundary.

### 4a. Walk-vs-drive "decide-then-offer" — `effectiveMatrix.ts` (LOCKED §2)
For each eligible leg the matrix carries **both** a walk and a drive time. The rule: walk if
`walkMin ≤ walkMax` **and** `walkMin ≤ driveMin + driveOverheadMin`, else drive; ineligible pairs
(too far to walk) drive with `walkMin:null`. Drive time always includes `driveOverheadMin`
(hail/park/load). The UI shows both times and offers a per-leg toggle; a user override **re-times
the fixed order, never re-orders** (`legOverrides` on the doc). `walkMax`/`driveOverheadMin` are
live doc-level settings (the sidebar "planner's notes"). Walk time = haversine ÷ ~80 m/min
(`walkEstimator.ts`).

### 4b. Schedule builder — `src/lib/schedule/schedule.ts`
`planDay` splits the ordered stops into segments at anchors, calls `optimize` per segment, and
assembles a `DayPlan` (entries with arrive/start/depart/wait, legs carrying both times + `chosenBy`,
`totalTravelMin`, `daySlackMin`). `rescheduleDay` re-times a fixed order for the toggle path.
`applyLegModes` flips a leg's mode. `validateDay` guards duplicate ids / anchors outside the window
/ anchors out of order. `planService.planTripDay(doc, i)` is the bridge: honors a valid `manualOrder`
(exact permutation → `quality:"manual"`, skip the solver), else solves; threads `precedence` and
`legOverrides`; cross-day/unknown precedence degrades to an advisory margin note, never a hard fail.

---

## 5. The map render engine — `src/lib/map/map-render-core.js` + `map-style-defaults.mjs`

A custom canvas engine that paints a hand-drawn "journal map." **Not MapLibre** — Chris rejected
styled vector tiles as "a street map in a paper costume."

**Inputs:** OpenFreeMap **vector tiles** (free, keyless CDN) decoded with `pbf` +
`@mapbox/vector-tile`; four AI-generated **watercolor textures** (land/water/park/weathering PNGs in
`public/map/assets/tex/`, palette-locked to the design system); **Rough.js** for hand-drawn strokes.
Libraries are npm deps injected via `provideLibs()` so the engine stays framework-agnostic (same
source runs in the app and in an offline screenshot/tuning bench).

**Render path (base/overlay split — the key design):**
- `fetchAndDecode(config)` → fetch + decode the tiles for the view's bbox.
- `buildScene(config, decoded, textures, {legGeometries?})` → paint **geography once**: land/water/
  park texture fills, Rough.js coastlines + a layered road network (major/secondary/minor tan inks),
  curved **water labels** (text-on-path via a PCA channel spine), collision-avoiding **point labels**
  (nudge → shrink → drop, never sliced at the frame). The result is **snapshotted**.
- `paintOverlay(scene, {routePoints, routeProgress, pinPop, washiSettle, legGeometries, washiIndex})`
  → on the restored snapshot, draw the **route pen** (follows real AWS road geometry when present,
  else straight sketch chords; Catmull-Rom smoothed with a soft bleed underlay), **numbered pins**
  (Rough.js rings), and the **washi-tape "Booked" tag**. Redraws on reorder without repainting the
  basemap.
- `renderToDisplay(scene, canvas, maxW)` → crop to the view + blit to the display canvas (DPR-capped).

**Determinism:** per-feature Rough.js **seeds** → byte-identical repaints (required for share =
recompute). **Resolution-invariant:** every px in the config is authored at `REF_TILEPX 1024` and
scaled by `K = TILEPX/REF_TILEPX`, so proportions hold across zoom/DPR. All art values
(colors/widths/roughness/pin/washi/label params, road-class lists, the vivid `#2e79ea` map pen) live
in **`map-style-defaults.mjs`** — the M0.5-**LOCKED** single source of truth, tuned by Chris in a
live "Map Studio" bench and consumed identically by the app + the bench.

**React wiring — `src/ui/reveal/RevealMap.tsx` (client):** computes a fixed view from stop coords,
lazy-injects the npm libs on the reveal route only, loads textures, builds the scene once, and
repaints the overlay on order/booked changes (ResizeObserver re-blit). **Progressive geometry:** it
paints instantly, POSTs consecutive stop pairs to `/api/route-geometry` (AWS proxy), and on success
rebuilds the scene once with road-aware labels + the road-following pen (falls back to the sketch on
any failure — `data-geometry: pending|roads|sketch`). **Choreography** (via `motion`): clouds part →
pen draws on → pins pop as the tip passes → washi settles; reorder replays a short re-sketch with a
pencil sfx. `prefers-reduced-motion` collapses to an instant final frame. (Recent polish: the canvas
edges are feather-masked so the map dissolves into the paper; the crop goes portrait-taller on
phones.)

---

## 6. Adapters & wiring — `src/lib/config.ts` (what's wired vs stubbed)

`config.ts` is the single wiring hub. It picks implementations from env, defaulting to the safe
no-spend path:

- **Maps provider:** `MAPS_PROVIDER=fixture` **or no `GOOGLE_MAPS_API_KEY`** → `fixtureAdapter`
  (a deterministic 20-stop "fixture city", zero spend). Otherwise → `realAdapter` (lazy-imported;
  Routes API `computeRouteMatrix`, driving only, through the shared cache).
- **Matrix cache:** KV (`kvMatrixCache`) when `KV_REST_API_URL`+`KV_REST_API_TOKEN` present, else a
  file cache. Keyed `(fromId,toId,mode)`; **throws on cache errors** (never silently re-bills).
- **Trip store:** `kvStore` when KV env present, else `fileStore` (`TRIPS_DIR`).
- **Parse provider** (`parseItinerary.ts`): `llmAdapter` only when `PARSE_PROVIDER=llm` AND a key
  exists; else `heuristicAdapter`. **Route geometry** (`routeGeometry.ts`): AWS proxy only with
  `AWS_LOCATION_API_KEY`; else all-null → straight sketch (fails **open**, decorative).
- **Cost-safety invariants:** real adapters **construction-throw without a key**; fixture is the
  default; 40-lookup cap; caches prevent re-billing; jest guards forbid tests from importing the
  real/LLM adapters or assigning their key env vars. All billed API routes are **rate-limited**
  (`rateLimit.ts`, per-IP fixed window, no-ops without KV) and try/catch → legible JSON errors.

**Live prod env (set in Vercel):** `GOOGLE_MAPS_API_KEY`, `AWS_LOCATION_API_KEY`, `ANTHROPIC_API_KEY`,
`PARSE_PROVIDER=llm`, KV vars. So prod runs the real maps adapter + KV + AWS pen + LLM parse; local
and CI run fixtures with zero spend.

---

## 7. UI surfaces

- **`/` (landing)** — `Greeting.tsx`: a post-it paste field on a full-bleed notebook-desk hero; paste
  → `usePipeline` (SSE) → `LoadingView` (Gracie + a filling soup pot per stage) → redirect to the reveal.
- **`/trip/[id]` (reveal)** — `RevealClient` owns doc/plans/active-day and wires all mutations
  (dnd reorder → `manualOrder`, re-optimize, per-leg toggle, remove-duplicate, planner's-notes) behind
  one busy flag: build next doc → PUT → POST `/plan` → commit or revert. Renders `RevealMap`
  (the journal map) beside `JournalSidebar` (torn journal page).
- **`/share/[id]`** — server component: recomputes the plan from the stored doc (deterministic →
  identical to what the owner saw) and renders `RevealMap` + `ShareTimeline` (read-only twin of the
  sidebar). No edit controls.
- **`/debug/*`** (env-gated) — the legacy editable board (`TripBoard`/`PlanView`) + design gallery +
  pipeline driver, kept for testing.
- **Design system** (`design.md`): warm-paper journal aesthetic; tokens (`--soup` orange = brand only,
  `--action` pine green = all CTAs/states, washi pastels); Gochi Hand + Nunito Sans; **Gracie** mascot
  (thin-line doodle); hand-authored SVG icons only; a11y is a hard gate (0 axe violations in e2e).

---

## 8. What's wired vs stubbed / planned

**Wired & live (prod):** parse (heuristic + LLM) · resolve (Google Places) · driving matrix (Routes
API) + KV cache · solver + schedule + walk/drive toggles · reveal map with the AWS road-following pen
· share round-trip · rate limiting · SSE pipeline.

**Wired but on a branch, NOT deployed** (`uiux-polish`): responsive + map-seam feather + home-nav
(Phase A), share rebuilt into the journal world (B.1), the post-it landing (B.2). **Pending on that
branch:** Phase C (restyle the map pins — push-pin tacks vs washi-number scraps — + trim an empty
sidebar), Phase D (slow/smooth route draw-on).

**Stubbed / not built:**
- **Accounts, payments, entitlements** — no auth, no Stripe, no paywall. The SGD 6.90 Trip Pass is
  planned (Supabase + Stripe, "D3"). There is no `entitlements` module yet.
- **Text-only interpretation** — pasting *without* links currently drops the text lines (only URLs
  resolve). The approved spec (`docs/superpowers/specs/2026-07-09-itinerary-interpretation-design.md`)
  adds: geocode place *names* (safely, behind an `interpret.names` entitlement), assign real dates
  (today every day is mis-stamped "today"), and a capability boundary so features toggle free/paid.
  **Not implemented.**
- **Reserved future capabilities (design slots only):** social-link (TikTok/IG) location extraction;
  cross-date "propose a smoother move" suggestions.
- **Known truthfulness gaps:** the travel matrix is **driving-only** (walk labels are estimates, not
  a pedestrian matrix); no transit/scooter modes; Gracie's sprite art is provisional; sfx are
  placeholder foley.

---

## 9. Where the next features plug in (for writing implementation briefs)

- **"Paste anything" (text-only interpretation):** touches `parse/llmAdapter.ts` (emit a
  disambiguated `placeQuery` per real place), `pipeline.ts` (route `url ?? placeQuery` to resolve,
  gated + capped + deduped; real dates via a `resolveDayDate` helper; `TripDay.dayLabel?`), a new
  `entitlements` module (single checkpoint), and a no-key fixture parse mode for tests. `resolvePlaces`
  **already resolves plain names** — this relaxes a policy, it doesn't add geocoding code.
- **Payments/auth (D3):** fills the `entitlements` stub with real per-user tier logic (Supabase user →
  Stripe Trip Pass → capabilities). One checkpoint already anticipated; nothing else re-architects.
- **The engine is stable and deterministic** — most feature work is at the parse → resolve → assemble
  seam and the entitlement boundary, not in the solver/schedule/map engine (all LOCKED).

---

*Source of truth for build history + verified claims: `STATE.md`. Design rules: `design.md`.
Approved-but-unbuilt feature spec: `docs/superpowers/specs/2026-07-09-itinerary-interpretation-design.md`.*
