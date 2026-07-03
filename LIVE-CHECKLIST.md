# LIVE-CHECKLIST.md — ordered live-API verification steps (for Chris)

_Everything below needs the live key, real spend, or a deploy — none of it ran during the
unattended build. Ordered per handover §6. Each step lists what the code expects and what
"verified" looks like. Until a step is done, treat its feature as UNVERIFIED (STATE.md lists
the same items from the build side)._

## 1. ✅ DONE 2026-07-03 — Restore the key; resolve one pasted Maps link end-to-end

**Result:** real JB trip links resolved with correct names/addresses. Two setup snags,
both surfaced legibly: a lingering `$env:MAPS_PROVIDER="fixture"` shell var (silently
forces the fixture adapter — use a fresh terminal), and a key from the wrong Google Cloud
project (Routes 403 billing error until swapped to the billed project's key).

- Recreate `.env` at the repo root: `GOOGLE_MAPS_API_KEY=<your key>` (gitignored).
  The app reads it via `process.env` — no other key wiring exists.
- Run `npm run dev` **without** `MAPS_PROVIDER=fixture` (the factory in `src/lib/config.ts`
  picks the real adapter whenever the key is present).
- New trip → paste ONE real Maps share link → Add stops.
- **Verified when:** the stop appears with the right name/address (this validates the
  Phase-0-through-port mapping against Google's live behaviour). Failures should appear in
  the yellow panel with a reason, never vanish.

## 2. ◐ PARTIAL 2026-07-03 — One real matrix call; confirm the cache prevents a second fetch

**Done:** first live `computeRouteMatrix` call succeeded (request shape + `duration`
parsing confirmed — a real JB day optimized and rendered). **Still open:** billed request
count (blank below) and the second-run-adds-zero-requests cache check — re-verify at D0.3
against the new KV-backed cache (the local-file cache this step originally described is
superseded by plan §D0.1).

- Same trip: ≤ 5 stops on the day → Optimize.
- The real adapter batches per-origin requests to Routes API `computeRouteMatrix`
  (driving only) and persists every pair in `.cache/matrix-cache.json`.
- Optimize again (or reload + optimize): **verified when** the second run makes zero Routes
  API requests — check the Google Cloud console request count before/after, and note the
  billed request count here: ______
- Known-unverified specifics to watch: request body shape, `duration: "…s"` parsing, and
  the `condition` field on no-route pairs (all coded to spec docs, never executed).

## 3. Build a real day from the actual group trip's stops; sanity-check

- Paste the group's real links, set durations, mark the real bookings as anchors.
- Optimize. **Verified when:** the order passes your local knowledge, and every leg the
  plan labels **walk** is genuinely walkable — no rivers, expressways, or fences between
  the pair (the walk estimator is straight-line × 1.3; §7 documents this limit). Toggle any
  wrong walk leg to drive; the toggle persists.

## 4. Variety-test the spike's known edge: dropped-pin / coords-only shares

- From the Maps app: share a dropped pin, a `/maps/search/…` link, and a bare `@coords`
  URL; paste each.
- **Verified when:** each either resolves correctly or fails legibly in the failures panel.
  The failure mode to catch is a silent MIS-resolve (wrong place, no error) — the code is
  built to fail loudly instead (`could not extract a place name from URL …`), but this has
  never been exercised with real dropped-pin links.

## 5. Provision Vercel KV; flip tripStore; share from a phone

- Create the KV store in the Vercel dashboard; set `KV_REST_API_URL` and
  `KV_REST_API_TOKEN` in the project env (the factory flips to the KV adapter
  automatically; the adapter speaks the Upstash REST protocol via `fetch`, and is
  **UNVERIFIED** — it has never talked to a real KV instance).
- Deploy. Create a trip, build a day, open `/share/<tripId>` from a phone.
- **Verified when:** the shared plan renders read-only with the same order/times.
- ⚠️ **Deploy-time gap to resolve here:** the real adapter's matrix cache is a local file
  (`.cache/matrix-cache.json` — `src/lib/config.ts`), which works on your machine but NOT on
  Vercel serverless (read-only FS; per-instance `/tmp` is ephemeral). Deployed consequences
  until fixed: cold starts re-bill matrix elements, and a share render on a fresh instance
  re-fetches live drive times — if Google's times drifted, the share view can diverge from
  what you saw. Cheapest fix: back the matrix cache with the same KV store (the
  `MatrixCache` interface in `src/lib/maps/matrixSource.ts` is two methods). Decide when
  provisioning KV in this step.

## 6. Quota/billing alert in Google Cloud console

- Before the group starts pasting links: set a budget alert on the project and per-API
  quotas for Places API (New) + Routes API sized to expected use (a 20-stop day ≈ 400
  matrix elements cold, then cached).
- **Verified when:** the alert exists and a test notification reaches you.
