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

## 2. ✅ DONE 2026-07-04 — One real matrix call; cache confirmed live on Vercel + KV

**Result (deployed app, https://trip-soup.vercel.app/):** cold Optimize run billed ~2
Routes API requests; second Optimize on the same day added **zero** new requests —
`kvMatrixCache` (Vercel KV / Upstash) confirmed working end-to-end in production. This
supersedes the original local-file-cache version of this step (superseded per plan §D0.1).
Request body shape + `duration` parsing were already confirmed 2026-07-03; the
`condition`-field-on-no-route-pairs path remains unexercised (no such pair hit yet).

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

## 7. D2.3 post-merge live checks (added at T10, 2026-07-06)

The d2.3-reveal merge makes the greeting the PRODUCTION front door and replaces the reveal.
After the deploy finishes:

- Open trip-soup.vercel.app → the paste-box greeting renders (not the old board; that's
  behind DEBUG_BOARD=1 at /debug/trip).
- Paste a real messy blob (Maps links + a "3pm" hint) → Gracie loading stages → the reveal:
  journal map paints with the hand-sketch pen (no AWS key yet = expected), sidebar rows with
  times, booked tape on the anchored stop.
- Drag a row (or keyboard: focus handle → Space → Arrow → Space) → map re-sketches +
  pencil sfx (after your first click; mute chip top-right) → Re-optimize appears → click it.
- Toggle an eligible leg ("take the drive/walk") → downstream times shift, order unchanged.
- Open the share link on a phone → same order/times, read-only.
- **Verified when:** all of the above on the live site with a real key'd paste.
- With ANTHROPIC_API_KEY set in Vercel, the paste parses via claude-haiku (better label/
  time handling); without it the heuristic parser runs — both are fine, just note which.

## 8. ✅ DONE 2026-07-08 — AWS Location key → road-following pen

- AWS console → Amazon Location → API keys → create key restricted to `geo-routes:*`
  (resource `arn:aws:geo-routes:ap-southeast-1::provider/default`); note the Routes
  pricing panel; set a billing alarm.
- Vercel env: `AWS_LOCATION_API_KEY` (+ `AWS_LOCATION_REGION=ap-southeast-1` if not SG)
  → redeploy → open any trip: the pen should trace roads (data-geometry="roads").
- This ALSO verified the LIVE-SHAPE NOTE in src/lib/maps/routeGeometry.ts: the AWS
  response field parse (Routes[0].Legs[].Geometry.LineString) is CONFIRMED correct against
  the real geo-routes v2 API.
- **Verified:** ✅ 2026-07-08 — Chris added AWS_LOCATION_API_KEY to Vercel prod; a real
  trip's pen follows the roads on the live site (`data-geometry="roads"`, GrabMaps polylines).
