# STATE.md — phase-by-phase state of the unattended PA→P5 run

_Every claim here is backed by a tool result from the run session. Live-API items are
UNVERIFIED, no exceptions._

## PA — Audit (COMPLETE — fresh-context review: 0 blocking, 3 minor findings, wording fixed)

**Built:** `AUDIT.md`; git repository initialised (first commit bundles Phase 0 as-found with
the PA documents — committed `resolvePlaces.ts` matches the working tree, proving Phase 0
unmodified).

**Deviations:** none. No conflicts with LOCKED sections found (see AUDIT.md §5 for the
call-time vs construction key-gate note and its resolution — adapter wraps, spike unmodified).

**Verified and how:**
- Repo tree, absence of scaffold/git/tests: `find`/`ls`/`git rev-parse` output.
- Absence of key material: `find . -name ".env*"` → nothing; `grep -rl "AIza"` over
  `*.ts`/`*.md` → nothing at audit time (re-running it now matches AUDIT.md/STATE.md only,
  because they quote the pattern — no actual key material).
- `resolvePlaces.ts` read in full; port mapping written against its actual exports.

**Done-check:** AUDIT.md exists. Later phases reference it where reality differed from the
handover (framework-does-not-exist: P1 scaffolds greenfield per AUDIT.md §2).

## P1 — mapsProvider port, fixture adapter, real adapter, cache (COMPLETE)

**Built:** `src/lib/maps/` — `types.ts` (port interface adapted to the spike's shape per
AUDIT.md §3; `Settings` with LOCKED defaults walkMax 10 / driveOverhead 10 / detour 1.3 /
80 m/min / thresholds 9 & 15), `walkEstimator.ts` (pure, not on the port),
`matrixSource.ts` (cache keyed `(from,to,mode)` + per-origin batching, chunk 25, standalone so
it tests with a stub fetcher), `fixtureCity.ts` ("Casterbridge", 20 stops, metric-formula drive
matrix — triangle inequality by construction, ceil-preserved), `fixtureAdapter.ts`,
`realAdapter.ts` (constructor throws without `GOOGLE_MAPS_API_KEY`; resolution = Phase 0
module unmodified; matrix = Routes API `computeRouteMatrix`, driving only, through the shared
cache). Scaffold: package.json, tsconfig, jest, minimal Next app shell (placeholder pages).

**Deviations:** none from LOCKED sections. Framework scaffolded greenfield per AUDIT.md §2.

**Verified and how (tool output this session):**
- `npx tsc --noEmit` → exit 0.
- `npx jest` → 4 suites, **25/25 passed**: cache hit never re-fetches (warm call = zero
  fetcher calls); batching correct (per-origin, 25-per-request chunking: 30 dests → 25+5;
  4 stops → 4 requests not 12); incremental stop fetches only new pairs; triangle inequality
  exhaustive over all 20³ fixture triples; walk estimator goldens (1° = 111,194.93 m;
  800 m → 13 min) including exact-threshold boundary (10.0 min at walkMax 10 → eligible,
  10.0016 → not); fixture resolution by id/name/suffix with legible failures; §3 jest guard —
  no test file imports the real adapter.

**UNVERIFIED (live-API, by design — no key in the run environment):**
- Real adapter against the live Routes API (request shape, `duration` parsing, billed count) —
  LIVE-CHECKLIST step 2.
- Phase-0-through-port resolution against live Google — LIVE-CHECKLIST step 1.
- The real adapter's key-gate throw is asserted by code inspection only: §3's jest guard
  forbids tests importing the real adapter, so there is deliberately no unit test constructing
  it. Behaviour is two lines (read env, throw) — reviewed, not executed.

**Fresh-context review:** 0 blocking, 2 minor — guard regex hardened for dynamic import();
§3's "cached in persistence" is satisfied at P1 by the injectable `MatrixCache` interface with
an in-memory default; binding the real adapter's cache to actual persistence happens with the
provider factory (P4/P5) and its live behaviour is LIVE-CHECKLIST step 2.

## P2 — Solver core (COMPLETE)

**Built:** `src/lib/solver/` — `types.ts` (Segment with anchor boundaries as inputs —
structurally immovable; `SolveResult` = ok | infeasible | rejected), `effectiveMatrix.ts`
(§2 decide-then-offer: eligible legs retain BOTH times `{mode, walkMin, driveMin, chosenBy}`;
ineligible pairs drive with `walkMin: null`; schedule math always uses active-mode effective
time, drive = raw + overhead), `solver.ts` (pure `optimize(segment, matrix, settings)`:
lexicographic exhaustive ≤ maxExhaustive; NN seed + 2-opt for 10–15 labelled `heuristic`;
> 15 rejected with the §2 actionable message; ties lexicographic by stop id; structured
infeasibility naming `anchor-start:<id>` or `day-window` and the minutes missed).

**Deviations:** none. One interpretation call recorded: §2 says "ineligible pairs always
drive at raw drive time" and also "schedule math always uses … drive = drive + overhead".
Read as: "raw" distinguishes the matrix entry from the walk-comparison value; overhead applies
to every drive leg in schedule math (the hail/load/park rationale applies to any drive).
Not a LOCKED conflict — the two sentences compose under this reading.

**Verified and how (tool output this session):**
- `npx tsc --noEmit` → exit 0. `npx jest` → 8 suites, **51/51 passed**, including:
- Goldens: hand-computed line/corridor segments (exact orders, exact arrive/depart minutes),
  tie broken lexicographically, empty-segment boundary feasibility, and a fixture-city
  differential golden (solver order == independent in-test brute force over effective times).
- Comparison-rule goldens verbatim from §5: walk 5 vs drive 10 → walk; walk 8 vs drive 4 +
  overhead 10 → walk; beyond walkMax → drive regardless (walkMin null); exact-walkMax
  boundary → eligible; tie walk-vs-drive+overhead → walk, deterministic.
- Property tests (fast-check, 100 runs each): every stop exactly once; anchors never move
  (start/end boundary arithmetic + end arrival ≤ endBy); infeasible ⇒ named constraint +
  positive violation; input stop-order invariance. Heuristic regime (n 10–12, 25 runs):
  once-each + boundaries + label.
- Determinism across 100 runs: identical results, exhaustive AND heuristic regimes.
- Caps: 9 → optimal, 10 → heuristic, 15 → heuristic, 16 → rejected (actionable message);
  thresholds proven to be settings (maxExhaustive 3 flips a 4-stop segment to heuristic).

## P3 — Schedule builder + feasibility surface (COMPLETE)

**Built:** `src/lib/schedule/` — `types.ts` (Day/DayStop per §4 trip shape, anchors inline;
`DayPlan` with entries {arrive, start, depart, wait}, legs carrying both times + chosenBy,
day slack), `schedule.ts` (`planDay`: splits the ordered stop list into runs at anchors,
optimizes each segment, assembles the day; `rescheduleDay`: fixed-order walk for the §2
toggle path — re-times downstream without re-ordering, fresh feasibility; `applyLegModes`:
pure mode flip, refuses ineligible walks, marks `chosenBy: "user"`; validation surface for
duplicate ids, anchors outside the day window, anchors out of chronological order).

**Deviations:** none. Design note: flexible stops belong to the segment where they sit in the
day's ordered list (between anchors, §1's "maximal run" reading).

**Verified and how (tool output this session):**
- `npx tsc --noEmit` → exit 0. `npx jest` → 9 suites, **64/64 passed** (13 new), including:
- Hand-computed full-day golden (two anchors, two segments): exact arrive/start/depart/wait
  for all six stops (lunch anchor waited 50 min, show anchor 248), legs with durations,
  totalTravel 62, day slack 90; per-segment optimal orders proven against the alternative.
- Slack computation: waitMin at anchors, daySlackMin at day end.
- Heuristic label propagates from a 10-stop segment to the day plan.
- Toggle path: auto plan walks an eligible leg (walk 9 beats drive 2+10); user toggle to
  drive shifts downstream arrivals +3 without re-ordering, `chosenBy: "user"`, both times
  still offered; a toggle that breaks the day window resurfaces as a structured report
  (violatedBy 2); ineligible-walk toggles refused loudly; input matrix not mutated.
- Infeasibility surface: day-window overrun and unreachable anchors named with minutes;
  anchor-order and anchor-outside-day validation actionable.

**Note on P2 review findings (fixed here):** `tsconfig.tsbuildinfo` untracked and gitignored.
Provenance correction for the record: the P1 guard-regex hardening described in the P1 entry
was committed as part of the P2 commit (72547cd), not the P1 commit.

## P4 — UI trip board + optimize + result view (COMPLETE)

**Built:**
- `src/lib/store/` — `tripStore` port (§4): `types.ts` (TripDoc `{tripId, days, settings,
  legOverrides}` — §4 sketch field names carry a `Min` suffix for unit clarity),
  `fileStore.ts` (dev + all tests), `kvStore.ts` (Vercel KV via Upstash REST protocol, plain
  fetch, no new dependency — **UNVERIFIED**, §4: provisioning is a Chris step).
- `src/lib/config.ts` — adapter/store factories: fixture whenever `MAPS_PROVIDER=fixture` OR
  no key (tests/dev can never spend); real adapter only with a key, lazily imported, its
  matrix cache file-persisted (`.cache/matrix-cache.json`) closing P1-review minor #2;
  KV store only when KV env vars exist, else file store.
- `src/lib/planService.ts` — order from the solver on the AUTO matrix, then persisted leg
  overrides re-time the fixed order (never re-order, §2); stale/ineligible overrides dropped
  at the boundary; quality survives re-timing (P3-review fix).
- API routes (`app/api/trips/…`): create, get, put (boundary-validated), `resolve`
  (server-side — key never reaches the client), `plan`.
- UI: home (`/`), trip board (`/trip/[id]`) — days, paste-to-add stops with legible failure
  panel + duplicate dedupe, per-stop duration input, anchor lock/unlock with time field,
  optimize action, result view (`src/ui/PlanView.tsx`): timeline, legs labelled walk/drive,
  eligible legs show BOTH times with a per-leg toggle, wait/slack shown, heuristic and
  infeasible and rejected states rendered; settings card exposes walkMax + driveOverheadMin.

**Deviations:** none from LOCKED sections.

**Verified and how (tool output this session):**
- `npx tsc --noEmit` → exit 0. `npx jest` → 9 suites, **66/66 passed** (2 tests added at
  P3-review into the existing schedule suite: heuristic label survives re-timing;
  duplicate-id throw). [Suite count corrected from 10 to 9 per P4 review.]
- `npx playwright test` (fixture adapter, `MAPS_PROVIDER=fixture`, no key in env) →
  **5/5 passed**: (1) add stops incl. a bogus line → failure panel names it → mark anchor,
  move to 15:00 → optimize → on-screen order AND every entry's times equal a differential
  plan computed in-test from the same fixture+solver libraries; legs labelled walk/drive;
  (2) toggle an eligible walk leg → mode flips to drive, downstream entry shifts by exactly
  driveMin + overhead − walkMin, order unchanged, and the toggle persists across reload +
  re-optimize; (3) unreachable 09:10 anchor → infeasibility report with
  `anchor-start:<id>`, zero plan elements rendered; (4) 10-stop day → heuristic badge;
  (5) walkMax set to 0 forces the old-town hop to drive (live settings field).
- First e2e run failed on scenario arithmetic (three 60-min stops cannot precede a 12:00
  anchor) — the app correctly reported infeasible; the test moved the anchor to 15:00.
  Recorded here per the reporting rule; not a product bug.

**UNVERIFIED (live):** KV store adapter (no credentials, by design); real-adapter plan flow.

## P5 — Share read-only view + LIVE-CHECKLIST (COMPLETE)

**Built:** `app/share/[id]/page.tsx` — server component, fetches the doc through the
tripStore port, recomputes each day via `planTripDay` (deterministic solver ⇒ recompute
reproduces exactly what the owner saw, persisted leg toggles included), renders `PlanView`
in read-only mode (no toggles, no editing controls). `LIVE-CHECKLIST.md` finalised, six
steps ordered exactly per §6, each with what-verified-looks-like.

**Deviations:** none.

**Verified and how (tool output this session):**
- `npx tsc --noEmit` → exit 0. `npx playwright test` → **6/6 passed**: the share spec builds
  a day, optimizes, toggles an eligible leg (and waits for the re-plan), then loads
  `/share/<id>` and asserts identical entry order, identical times, identical leg modes
  (toggle honoured), and zero toggle/optimize/paste controls in the share view.
- First share-spec run failed on a TEST race (owner times captured before the post-toggle
  re-plan landed; the share view was actually correct). Fixed by waiting for the toggled
  leg to render "drive" before capturing. Recorded per the reporting rule; not a product bug.

**UNVERIFIED (live):** share round-trip on a deployed app with Vercel KV from a phone —
LIVE-CHECKLIST step 5.

## Fresh-context reviews — reconciliation and fixes

Every phase had a fresh-context review; all findings and their dispositions:
- **PA:** 0 blocking, 3 minor → wording fixed (mixed first commit, self-matching grep note).
- **P1:** 0 blocking, 2 minor → guard regex hardened for dynamic import(); persistent-cache
  wiring delivered in P4's `config.ts`.
- **P2:** 0 blocking, 2 minor → `tsconfig.tsbuildinfo` untracked; provenance note recorded.
  Reviewer independently hand-verified golden arithmetic, determinism analysis, and endorsed
  the raw-vs-overhead interpretation as the only self-consistent reading of §2.
- **P3:** 0 blocking, 2 minor → quality now threads through `rescheduleDay` (no heuristic
  laundering) + test; duplicate-id throw tested; client dedupes on add.
- **P4:** 1 "blocking" + 6 minor. The blocking finding was a snapshot artifact: the reviewer
  ran against a tree containing uncommitted P5 WIP (share spec with a test race, since fixed)
  while STATE.md still said P5 NOT STARTED — reconciled by the P5 commit (a7ac2cb, 6/6 e2e).
  Minors all fixed post-review: suite count corrected; toggleLeg serialized behind the busy
  flag; failures/paste state now per-day + "Add day" button + multi-day e2e; numeric inputs
  no longer persist 0 on clear; invalid anchor time reverts on blur; PUT validation deepened
  to day/stop/override shapes.
- **P5 + final whole-run audit:** 0 blocking, 2 minor → suite count (same fix); LIVE-CHECKLIST
  step 5 now warns that the file-backed matrix cache does not survive Vercel serverless
  (re-billing + the one live share-divergence vector) with the KV-backed cache as the fix.

## FINAL GATE — run results (fresh runs after ALL review fixes, 2026-07-02)

- `npx tsc --noEmit` → **exit 0**.
- `npx jest` → **9 suites, 66/66 passed** — includes the P2 solver goldens, comparison-rule
  goldens, property tests (fast-check), determinism-across-100-runs in both regimes, caps at
  9/10/15/16, P1 cache/batching/guard, P3 schedule goldens + toggle semantics.
- `npx playwright test` → **7/7 passed** against fixture data (`MAPS_PROVIDER=fixture`, no
  key in env): the P4 flow with exact on-screen order/time assertions, toggle re-timing
  without re-ordering (+ persistence across reload), the infeasible report state, the
  heuristic state, live walkMax setting, multi-day scoping, and the P5 share round-trip.
  One iteration each on trip.spec (test-scenario arithmetic), share.spec (test race), and
  multiday.spec (selector prefix collision) — all three were test bugs, not product bugs;
  each documented in its phase entry or here.
- Cost posture: no `.env*` anywhere; jest guard (scans src/ + e2e/) green; e2e forces the
  fixture adapter; the real adapter remains construction-gated and was never constructed
  this run. The full development cycle spent **zero** Google API calls.
- Independent verification: six fresh-context review subagents (PA, P1, P2, P3, P4,
  P5+whole-run), findings reconciled above; the final auditor confirmed the done contract
  before the last round of minor fixes, and every gate was re-run after those fixes.

**Everything UNVERIFIED (live-API) in one list — mirrors LIVE-CHECKLIST.md:**
1. ~~Phase-0-through-port resolution against live Google (step 1).~~ **VERIFIED LIVE
   2026-07-03** — see the 2026-07-03 entry below.
2. Real Routes API matrix call: ~~request shape, duration parsing~~ **VERIFIED LIVE
   2026-07-03**; still open: billed count, cache preventing the second fetch (step 2).
3. Real-trip sanity + walk-label truthfulness (step 3).
4. Dropped-pin / coords-only share links (step 4 — §7 known edge, fails legibly by design).
5. Vercel KV store adapter + deployed share round-trip + matrix-cache persistence on
   serverless (step 5 — includes the share-divergence warning).
6. Quota/billing alerts (step 6).

---

# PRODUCTION RUN (TripSoup) — begins 2026-07-04

The engine above is being taken to production per the approved master plan at
`C:\Users\65881\.claude\plans\i-want-you-to-starry-wave.md` (TripSoup: paste itinerary →
Gracie mascot loading → paper-map reveal → one-time SGD 6.90 Trip Pass → live share).
Phases D0–D5. Same evidence rules as the build run.

## 2026-07-03 — Live verification by Chris (evidence-log catch-up, plan §D0.0)

Recorded from the working session with Chris (conversation evidence, reported by Chris,
not machine-verified in-repo):
- **LIVE-CHECKLIST step 1 DONE:** `.env` restored; real Google Maps share links from the
  actual JB group trip resolved end-to-end through the Phase-0-through-port path (correct
  names/addresses on the trip board).
- **LIVE-CHECKLIST step 2 PARTIAL:** first live Routes API `computeRouteMatrix` call
  succeeded — request shape and `duration` parsing confirmed working (a real JB day
  optimized and rendered). Preceded by two legible failures, both diagnosed correctly by
  the app's error surfaces: (a) Routes API 403 billing-not-enabled (project had no billing
  account), (b) root cause: the key belonged to a different Google Cloud project than the
  billed one — fixed by switching to the correct project's key. STILL OPEN: billed request
  count not noted; cache-prevents-second-fetch not confirmed (moot for the file cache —
  superseded by the D0.1 KV cache, re-verify at D0.3).
- **Gotcha recorded:** `$env:MAPS_PROVIDER = "fixture"` persists for the whole PowerShell
  session and silently overrides the live key (every input "fails" with *no match in
  fixture city*). Remove the var or use a fresh terminal when testing live.

## 2026-07-03 — MatrixCache port change APPROVED by Chris

`MatrixCache` goes from sync `get/set` to bulk-async `getMany/setMany` (still 2 methods).
Reason: serverless-safe remote caches (Vercel KV at D0, Supabase at D3) cannot implement a
sync `get()`, and per-key round-trips would be n² requests per matrix. §3's LOCKED
semantics (matrix entries cached, NEVER re-fetched on cache hit; batched requests) are
unchanged and remain proven by the existing P1 goldens — test stubs update to the async
interface, assertions stay. Approved by Chris 2026-07-03 after plain-language walkthrough.
Implementation lands in D0.1.

## D0 — Deploy current app to Vercel + KV (COMPLETE)

### D0.1 — Pre-deploy hardening (COMPLETE; implemented by sonnet subagent, verified by orchestrator)

**Built:**
- MatrixCache port change (approved 2026-07-03): sync `get/set` → bulk-async
  `getMany/setMany` in `src/lib/maps/matrixSource.ts`; `createMatrixSource` does ONE bulk
  getMany up front and setMany **after each per-origin batch** (pairs cache as they land —
  D2's retry-resumes-from-cache guarantee depends on this); `createMapMatrixCache` exported
  as in-memory default; file cache in `config.ts` wrapped to the async interface.
- `src/lib/maps/kvMatrixCache.ts` (new): Vercel KV (Upstash REST `/pipeline`) MatrixCache —
  MGET/MSET in single round-trips, `mx:` key namespace, construction-gated on KV env vars,
  THROWS on KV errors (never silently re-fetches billed pairs — matches the failure-mode
  design). Selected in `config.ts` when KV env present; file cache otherwise. Closes the
  LIVE-CHECKLIST step-5 serverless-cache warning.
- `src/lib/rateLimit.ts` (new): per-IP fixed window (20/hour/route) over the same Upstash
  REST pipeline (INCR+EXPIRE NX); **no-ops when KV env absent** (dev/jest/Playwright
  unaffected); fails OPEN on ALL KV failures — HTTP-error responses AND thrown fetches
  (the thrown-fetch path was a D0-audit finding, fixed post-audit; availability over
  throttling — the correct direction for a rate limiter, opposite of the cache). Applied
  to `resolve` and `plan` routes with a friendly 429.
- Plan route: handler wrapped in try/catch → legible JSON 502 (fixes the live
  "Unexpected end of JSON input" Chris hit 2026-07-03).

**Deviation (recorded per plan):** plan text named `@upstash/ratelimit`; implemented
hand-rolled instead — repo convention (handover §8: minimum code, plain fetch, no new
runtime deps) and the KV REST plumbing already existed. Functionally equivalent commands.

**Verified and how (orchestrator-run this session, after subagent handoff):**
`npx tsc --noEmit` → exit 0 · `npx jest` → 9 suites, **66/66** (P1 cache goldens ported to
the async interface — assertions and counts unchanged: warm call = zero fetcher calls,
incremental fetch only new pairs, 25-chunk batching) · `npx playwright test` → **7/7** ·
`npx next build` → clean (first production build of this repo).
Review note: subagent's report misdescribed its own kvMatrixCache as "fails open"; code
inspection confirmed it throws (as specified). Lesson: verify reports against diffs.

**UNVERIFIED (live):** kvMatrixCache and rate limiter against a real KV instance — D0.3.

**Fresh-context D0 audit (opus, post-D0.1):** verdict CLEAR-TO-DEPLOY. 0 blocking,
3 minor, 4 observations. All three minors fixed before deploy: (1) rate limiter now
catches thrown fetches, not just HTTP errors (a KV network blip would have crashed the
routes it protects with the exact non-JSON 500 D0.1 set out to kill); (2) STATE.md
"fails OPEN" wording corrected to match; (3) resolve route got the same try/catch → 502
hygiene as plan. Also pulled forward from cross-cutting (auditor observation 4): 40-input
cap per resolve request — the per-IP limit caps requests, not inputs-per-request, so one
request could have triggered unbounded billed Places calls. Remaining observations
(leftmost-XFF trust, file-cache-on-serverless misconfig path, pipeline command-level
error message) accepted as-is with rationale in the audit transcript; none cost- or
security-blocking. LOCKED §3 semantics independently re-verified line-by-line by the
auditor (no double-fetch path within or across calls; guard + construction gate intact).

### D0.2 — Deploy (CHRIS-STEP, COMPLETE)

Repo pushed to `github.com/Souped-code/TripSoup` (private); Vercel project `trip-soup`
created and connected via GitHub integration (auto-deploy on push to `main`); Vercel KV
(Upstash Redis) provisioned and connected — env vars present: `KV_REST_API_URL`,
`KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`, `KV_URL`, `REDIS_URL`;
`GOOGLE_MAPS_API_KEY` (the billed project's key) added for Production + Preview. One snag:
first smoke attempt returned "no match in fixture city" on real Maps links — the deploy
had run before the key finished propagating / before a redeploy; a redeploy resolved it
(same class of gotcha as the local `MAPS_PROVIDER=fixture` shell issue: the fixture
fallback in `config.ts` is silent-by-design for cost safety, but that silence means a
misconfigured key looks identical to "working as intended" until you check the output).

### D0.3 — Post-deploy smoke test (CHRIS-STEP, COMPLETE)

Deployed URL: **https://trip-soup.vercel.app/**. All 6 checks passed:
1. New trip → 2 real Maps links → both resolved correctly.
2. Optimize → plan rendered.
3. Optimize again → **cold run billed ~2 Routes API requests; warm run added 0** — live
   KV matrix cache confirmed working in production (closes LIVE-CHECKLIST step 2 and the
   step-5 serverless-cache warning for real).
4. `/share/<tripId>` opened on phone, off wifi — rendered correctly.
5. Garbage paste line → legible failure panel, no crash.
6. Vercel KV Data Browser → `trip:` and `mx:` keys both visible.

**D0 done-check: MET.** tsc/jest/Playwright/build all green pre-deploy; fresh-context
audit cleared; all 6 live smoke checks passed on the deployed app. D0 is closed.

**Everything now verified that was UNVERIFIED at the end of the engine build:**
LIVE-CHECKLIST steps 1 and 2 are now ✅ DONE (see LIVE-CHECKLIST.md). Steps 3, 4, 6 remain
open (real-trip sanity/walk-truthfulness, dropped-pin variety test, billing alert) — none
are D0-blocking; step 5 (KV store + share round-trip) is effectively done by D0.3 item 4/6
though LIVE-CHECKLIST.md's step 5 text (Supabase-era wording) will be reconciled at D3.

---

## ⚠️ SESSION HANDOFF + AUDIT SCOPE (2026-07-04) — read before continuing D1

**What happened:** the session that closed D0 and started D1 was running on **Sonnet 5**
(a background session pinned to its launch model), violating the plan's orchestrator rule
(Fable 5 / Opus only). Chris ordered an immediate wrap-up. **Everything below is the exact
inventory of what the Sonnet-orchestrated gap produced; the next (Fable) session MUST
fresh-context-audit all of it before continuing D1.**

Sonnet-gap inventory (audit scope):
1. **Committed + pushed:** `772dbb5` — D0.3 smoke results recorded, D0 marked COMPLETE,
   LIVE-CHECKLIST step 2 closed (docs only, no code). The D0.3 facts came from Chris
   directly (all 6 checks passed; ~2 billed cold, 0 warm), so the risk is recording
   accuracy, not fabrication.
2. **Uncommitted:** `design.md` (new, repo root) — written from the approved plan's D1.2
   spec. Audit against plan §D1.2 for drift/invention. Note: written WITHOUT the D1.1
   reference boards (Higgsfield image-gen tool disconnected; Chris chose to WAIT for
   reconnection rather than substitute a pipeline — D1.1 and D1.3 are BLOCKED on that).
3. **Uncommitted, produced by a sonnet implementation subagent (D1.4, additive-only
   brief):** design tokens appended to `app/globals.css`, fonts added to `app/layout.tsx`
   (CSS variables only — existing font stack untouched), `src/ui/journal/*` components,
   `app/debug/design` gallery page (env-gated `DEBUG_BOARD=1`), `e2e/debug-design.spec.ts`
   + `@axe-core/playwright` devDep + playwright.config.ts env addition. The agent may have
   been mid-write at session end — verify the tree state, run ALL gates fresh, and review
   the diff line-by-line before committing ANY of it. Its brief banned touching live
   pages/engine code; verify that held.
4. Memory files updated (orchestration rule + project status) — outside the repo.
5. D1.0 done: both design skills (taste-skill, ui-ux-pro-max) load correctly.

**D1.4 agent completed AFTER the wrap-up call — tree is complete, not truncated.** Its
self-reported results (UNVERIFIED by any orchestrator — auditor must re-run everything):
tsc clean; jest 9/66 unchanged; Playwright 4 files / 9 tests all passing (7 pre-existing +
2 new debug-design incl. an axe scan with 0 violations); live pages and engine untouched
per its own inspection. Judgment calls it made: per-component journal.css imports;
InkButton/JournalInput as client components; button text sized 1.25rem/700 to clear the
WCAG large-text threshold. **One flagged discrepancy for the auditor:** the agent computed
`--soup` on `--paper` contrast as **~3.05:1**, not the ~3.7:1 design.md §3 states — still
above the 3:1 large-text minimum, but design.md's figure needs correcting (or the hex
needs the allowed ±10% tune) once verified. Do not take either number on faith.

**Next session cold-start:** read plan → design.md → this section; audit items 1–3;
then resume D1 (D1.1/D1.3 still blocked on Higgsfield unless Chris has reconnected it).

### ✅ Sonnet-gap audit RESOLVED (2026-07-04, fresh Fable session)

All three items audited fresh-context; results:

1. **Commit `772dbb5` — PASS as-is.** Docs-only confirmed (LIVE-CHECKLIST.md + STATE.md,
   no code). Recorded D0.3 facts match the handoff's account (all 6 checks, ~2 billed
   cold / 0 warm, trip-soup.vercel.app), including the honest caveat that the
   `condition` no-route path remains unexercised. No action.
2. **design.md — PASS with corrections applied.** Audited against plan §D1.2: structure,
   tokens, anti-generic law, and per-surface direction all faithful; `--danger` is a
   reasonable additive extension (plan's palette had no error color). Three fixes made:
   (a) §3 contrast figure corrected — `--soup` on `--paper` is **3.05:1** (independently
   computed, WCAG formula), not the ~3.7:1 the doc claimed; the D1.4 agent's flagged
   ~3.05 was right. Still legal for large-text/non-text (≥3:1) but the margin is thin —
   doc now says prefer tuning `--soup` darker if D1.1 adjusts it. `--ink`/`--paper` also
   corrected ~12.9 → ~13.3:1. (b) Gochi Hand pick marked **provisional pending D1.1**
   (plan gates the font pick behind the reference boards, which didn't exist when the
   pick was made). (c) Plan path reference fixed (`~/.claude/plans/…`, not in-repo).
3. **D1.4 implementation — PASS as-is.** Diff reviewed line-by-line: token block purely
   additive; layout.tsx only publishes `--font-display`/`--font-body` CSS variables
   (existing `system-ui` body rule untouched — live pages render identically); all new
   classes `journal-`-prefixed; no engine or live-page logic touched; `/debug/design`
   correctly gated (`notFound()` unless `DEBUG_BOARD === "1"`). All gates re-run fresh
   by the auditor: **tsc clean, jest 66/66 (9 suites), Playwright 9/9** incl. the two
   new debug-design tests and an axe scan with 0 violations. The agent's contrast claims
   in journal.css verified exact (ink-soft/paper-shade 4.71:1, ink/washi 9.54:1).

Both audited artefacts committed this session. D1 resumes below.

## D1 — Design system: design.md + tokens + mascot pipeline (IN PROGRESS — audit resolved, see above)

### D1 progress after the audit (2026-07-04, same Fable session)

- **D1.0 done** (skills verified, previous session). **D1.2 committed** (design.md, with
  audit corrections). **D1.4 committed** (tokens + 5 journal components + gated
  /debug/design + axe smoke — all gates green). Both pushed.
- **Higgsfield reconnected** (verified live: 108.77 credits, starter plan) — the D1.1/D1.3
  blocker is gone.
- **D1.1 boards generated** → `design/refs/d1.1-{greeting,loading,reveal}.png` (one image
  per surface, prompts locked to design.md; 2 credits each). Self-review: all three hold
  the palette/anti-generic law; known per-board drift documented in `design/refs/README.md`
  (loading board's subcopy + invented nav are NOT part of the direction; reveal map is
  tonal direction, not a literal MapLibre target). **AWAITING CHRIS ACCEPTANCE** — only
  accepted directions get codified (font pick confirmation + any ±10% hex tuning, e.g.
  possibly darkening `--soup` for contrast margin, happen at acceptance).
- **D1.3 step 1 candidate generated** → `design/gracie/reference-candidate.png`
  (front/¾/side sheet, derived from the greeting board's Gracie via image reference —
  consistency between the two confirmed by eye). **CHRIS-STEP: approve** → rename to
  `reference.png`, then sprite scene batches (D1.3.2) can start.
- Next after acceptance: D1.3.2–5 (sprite scenes, assembly, sfx), then D1 done-check.

### D1 palette + type LOCKED (2026-07-04, Chris's call after board comparison)

Chris compared the orange-variant and white/green-variant reveal boards and locked the
synthesis: **weathered warm-paper map world** (the orange variant's contrast/character) +
**`--action` pine green `#3F6B4C` as the exclusive functional accent** (CTAs/active/
focus/progress/success) + **vibrant washi tape set** (coral/sky/pink/leaf + yellow
`--washi` for booked) + **`--soup` orange demoted to brand-only** (logo, Gracie,
illustration, large display — never buttons/links/states). Type pair Gochi Hand + Nunito
Sans **confirmed** ("choice of font is good"). Grounded in UI color theory per Chris's
brief (60-30-10, semantic/brand separation, Kennedy shade-derivation rule) — sources and
the full system are in design.md §3. `--action` was derived by darkening the board green
`#4A7C59` (failed 4.5:1 on cards) to `#3F6B4C` (5.46:1 on paper, 4.77:1 on shade — passes
AA body text everywhere); every palette pair computed and recorded in §3. Tokens updated
in `app/globals.css` (`--herb` replaced by `--action`; 4 fun tape tokens added), InkButton
primary switched to green, gates re-run **green** (tsc, jest 66/66, Playwright 9/9 incl.
axe 0 violations). Visual ground truth: `design/refs/d1.1-reveal-LOCKED-palette.png`.
Still open in D1: Gracie style pick (A/B/C stir drafts with Chris), then sprite scenes;
greeting/loading boards to be re-issued in the locked palette alongside the chosen Gracie.

### Gracie LOCKED: style C thin-line doodle, girl-next-door identity (2026-07-04)

Chris picked **C (thin-line doodle)** from the stir drafts and refined the identity:
friendly girl-next-door teen who enjoys planning itineraries, amateur home cook as a
HOBBY — not a uniformed chef (no chef jacket/bandana; cooking props are scene gear only).
Brand-palette wardrobe: `--soup` orange cardigan as her signature, cream tee, pale
ink-wash jeans, `--washi` yellow hair clip — no green clothing (green is the UI's
functional accent, not hers). design.md §1 updated with identity + locked art style.
New master sheet generated in style C: `design/gracie/reference.png` (front/¾/side +
palette strip; chef-version candidate superseded, kept for provenance). Minor nit for
Chris to ok: front view reads slightly more hair-down than the ¾/side low ponytail.
**Next (pending Chris ok of the sheet):** D1.3.2 four sprite scenes referencing this
sheet verbatim (pin-throw at wall map, route-scribble on floor, "this is fine", papers →
soup pot stir & sniff), then assembly + sfx.

### D1.3.2–3 DONE: four scenes generated + sprite assembly shipped (2026-07-04)

Chris upgraded Higgsfield to Plus (1,000 cr/mo). **Caveat verified empirically:** the
"7-day unlimited" perks (Nano Banana 2 1K/2K, Kling 3.0 720p/5s) apply ON THE WEB ONLY —
an MCP generation still billed 2 credits (balance 1000→998). Parallel generation (6
videos) DOES work via MCP.

**AutoSprite is broken via MCP** (all 4 custom scenes failed AND the plain `idle` preset
failed, no error detail) — pivoted to the plan's fallback-compatible pipeline:
1. Single-pose Gracie from the master sheet → 4 scene stills (nano-banana, flat `--paper`
   cream bg so frames composite invisibly on paper surfaces — no transparency needed).
2. Seedance 2.0 fast 720p 5s loop per scene (all 4 in parallel) →
   `design/gracie/scenes/loop-*.mp4` (+ stills).
3. ffmpeg (installed via scoop): 10 frames @512px tiled 10x1 → webp sheets in
   `public/gracie/{pin-throw,route-scribble,this-is-fine,soup-stir}.webp` —
   **each ≤145KB, 537KB total** (plan budget: ≤150KB/scene, 800KB hard limit — MET).
4. `<GracieScene name size fps>` component (`src/ui/journal/GracieScene.tsx`): CSS
   steps(10) sprite player, no JS timers; `prefers-reduced-motion` → static first pose
   (design.md §6 fallback). Added to /debug/design gallery.
5. Gates: tsc clean, jest 66/66, **Playwright 10/10** (new test: all 4 scenes render AND
   their sheets serve 200) incl. axe 0 violations.

**Remaining in D1:** Chris review of the 4 scene loops (regenerate any weak scene —
2 stills + 17.5cr/video), D1.3.5 sfx (CC0 pencil-scribble + pot-bubble, normalize
-14 LUFS, ≤30KB, `public/sfx/`), then D1 done-check. Loading-page integration itself is
D2.4 (needs real pipeline progress to drive scene switching).

### D1.3 v2: Chris's scene revisions applied — now FIVE scenes (2026-07-04)

Chris's review notes, all implemented (v2 stills + loops in `design/gracie/scenes/`,
sheets in `public/gracie/`):
1. **pin-throw:** ninja-kunai physics (fast flat throws, thunk + quiver), city map in the
   TripSoup map style instead of a world map, whimsical ninja mannerisms.
2. **route-scribble:** floor is a local city map; Gracie TRACES the single blue route
   (line never appears/disappears, zero motion-streak lines — the AI-tell Chris flagged);
   still's white wall re-flattened to cream before animating.
3. **journal (NEW):** lying on stomach, feet kicking, humming (drifting notes), washi
   tape + doodles in her travel journal — chirpy creative energy.
4. **this-is-fine:** full meme parody, storyboard faithful to the original panel (chair,
   round table + mug, doorway, crooked frame w/ soup-bowl doodle, speech bubble 'THIS IS
   FINE.', smoke ceiling) — twist: the flames burn chaotic travel plans. 4:3 like the
   meme; GracieScene got per-scene aspect support.
5. **soup-stir:** stray wavy lines removed (steam kept), working stove flames added,
   pins → flat alphabet-pasta letters.

Sheets: journal 143KB, pin-throw 145KB, route-scribble 149KB, soup-stir 133KB within the
150KB/scene budget; this-is-fine 168KB (12% over — it's a denser 4:3 panel; lower quality
visibly degrades it; accepted). **Total 738KB < 800KB hard limit.** Gallery + e2e updated
to five scenes; gates green (tsc, jest 66/66, Playwright 10/10, axe 0). Balance ~813 cr.

### ⚠️ Gracie scene art: PROVISIONAL (Chris, 2026-07-04)

Chris reviewed the v2 loops: **"not satisfactory but we can revisit later — run with this
and continue."** He will polish the art himself (via Opus or directly in Higgsfield web,
where his Plus unlimited perks apply). RULES FROM THIS POINT: (1) do NOT spend further
tokens/credits regenerating Gracie art unless Chris explicitly asks; (2) the current
sheets in `public/gracie/` are the working assets — the sprite pipeline, component API
(`<GracieScene>`), sheet format (10 frames tiled 10x1, webp, flat `--paper` bg) and
budgets are FINAL, so Chris's replacement art only needs to be dropped in as same-format
webp sheets (or handed to a session as loops for the ffmpeg step in this file, above);
(3) D1 proceeds to done-check with art marked provisional, not blocked on it.

### D1.3.5 sfx + D1 DONE-CHECK (2026-07-04)

sfx: Higgsfield's audio tools are speech-only (its SFX model is locked to the
game-generation pipeline) and freesound.org needs an API key for search/download — so
`public/sfx/pencil-scribble.mp3` (9KB) and `public/sfx/pot-bubble.mp3` (11KB) are
**ffmpeg-synthesized placeholders** (shaped noise / pitch-bent sine, loudnorm I=-14,
well under the 30KB budget). Swap for real CC0 foley later (freesound key or Chris
drops files in) — the D2 wiring (mute toggle, trigger points) doesn't care which.

**D1 done-check: MET with two provisos.** design.md committed (palette/type/identity
LOCKED by Chris) ✓; reference boards in design/refs/ ✓; Gracie assets committed — art
PROVISIONAL per Chris, pipeline/format FINAL ✓; sfx placeholders committed ✓; token
gallery + all five sprite scenes green in Playwright (10/10, axe 0) ✓. **D1 CLOSED**
(provisos: art quality revisit by Chris; sfx foley swap). D2 begins.

## D2 — The product flow (IN PROGRESS, started 2026-07-04)

### D2.1 DONE: parse service + solver precedence (2026-07-04)

Two parallel subagents (sonnet=parse, opus=solver), both diffs audited line-by-line by
the orchestrator and ALL gates re-run fresh (tsc clean, jest **93/93** across 14 suites,
Playwright **10/10** — no regression). New deps: `zod`, `@anthropic-ai/sdk`, `server-only`.

**D2.1a parse** (`src/lib/parse/`): zod-validated contract (`types.ts`), heuristic adapter
(regex URL extraction verbatim, line-adjacency label pairing, time-hint anchoring, day +
"Group X" splitting) = what jest runs against; server-only `llmAdapter.ts` (claude-haiku-4-5,
temp 0, 2 retries feeding zod error back, throws at construction w/o `ANTHROPIC_API_KEY`);
`parseItinerary.ts` entry with `PARSE_PROVIDER` selection + silent heuristic fallback when
no key (MAPS_PROVIDER=fixture philosophy). **LOCKED RULE enforced + documented at the entry
point:** only extracted URLs reach resolvePlaces/Places API; label text NEVER a query. New
import-guard test bans tests from importing the llm adapter or the Anthropic SDK.

**D2.1b solver precedence** (opus): `optimize()` gains optional 4th positional arg
`precedence: Array<{beforeId,afterId}>` (positional to keep every existing call site +
determinism test byte-identical when absent). Exhaustive skips violating permutations
(enumeration order untouched → determinism preserved); heuristic uses topological-greedy NN
seed + precedence-guarded 2-opt (byte-identical to old NN+2-opt when precedence empty).
Additive optional fields only: `TripDay.precedence` / `Day.precedence` (`{beforeId, afterId,
reason?}`), `DayPlan(ok).marginNotes?`. planDay routes each pair: within-segment→solver,
cross-segment same-day→post-assembly validation, cross-day/unknown-id→margin note. PUT
route validates the new day field. planService threads precedence + preserves marginNotes
across the leg-toggle reschedule.

**Two approved deviations, logged per plan instruction:**
- *(finding 6)* Precedence infeasibility reports `constraint:"precedence:<b>-><a>"`,
  `violatedByMin:0`, journal-voice message naming ONE pair (cycle → the closing pair;
  time-incompatible → the lex-smallest pair the precedence-free optimum breaks). "By how
  much" has no natural minutes for an ordering conflict — the named pair IS the diagnostic.
  Attribution guard: a segment infeasible even WITHOUT precedence reports the ordinary
  time-window/anchor constraint, so precedence is only blamed when it is genuinely the cause
  (golden control asserts this).
- *(finding 7)* Cross-day precedence is never a hard constraint — surfaces as a
  `marginNotes` advisory; the plan still succeeds.

**Not yet done in D2.1:** the parse→resolvePlaces wiring itself is D2.2's pipeline job (this
phase only built the parser + solver capability). LLM adapter is UNVERIFIED against the live
API by design (no key exercised) — flagged for the D2.4 CHRIS-STEP eyeball with a real key.

### D2.2 backend spine DONE (2026-07-04/05)

Subagent (sonnet) built the pure orchestration generator; diff audited line-by-line, gates
re-run fresh (tsc clean, jest **101/101** across 16 suites). Files: `src/lib/pipeline/
pipeline.ts` + test; `src/lib/maps/fixtureAdapter.ts` extended with Maps-URL name
extraction (isUrl + extractCandidateNameFromUrl mirroring resolvePlaces.ts — fixture-only,
real adapter untouched) so fixture mode exercises the pasted-URL→resolve path end to end.

Interface (a follow-up SSE route + client view depend on it verbatim):
`runPipeline(text): AsyncGenerator<{stage,pct,detail}, {status:"ok",tripId,doc,plans,
failures} | {status:"error",stage,message}>`; stages parse/resolve/matrix/solve weighted
15/40/30/15; also exports `parseTimeHint`. Assembly: link-item URLs→resolvePlaces (LOCKED
rule enforced AND unit-verified by spying on the resolve args — only https URLs sent, never
label text), label overrides display name, anchorLikely+timeHint→anchor (parseTimeHint
handles 2pm/2:30pm/9am/14:00), orderConstraint→day precedence (raw→stopId, unresolved pairs
dropped), TripDoc persisted via store, planTripDay per day. Errors returned not thrown.
Idempotent/resumable (matrix cache) — documented.

Accepted judgment calls: planTripDay errors attributed to stage "matrix" (no clean
matrix|solve boundary inside it); precedence attaches to the day of the "before" stop;
settings hardcoded {walkMax:10,driveOverheadMin:10} matching the create route.

**Known latent gap (flag for D2.3/hardening, NOT blocking):** no stop-id dedup — if two
pasted links resolve to the SAME place_id they become two same-id stops in a day, which the
solver/matrix key-by-id would mishandle. Add dedup (or per-occurrence ids) when wiring the
real greeting flow. Recorded so it isn't silently shipped.

### D2.2 COMPLETE: SSE route + client loading view (2026-07-05)

Built directly (orchestrator, Opus) on top of the spine; all gates green (tsc, jest
101/101, **Playwright 12/12** — 2 new streaming e2e tests exercise the real route end to
end). Files:
- `app/api/pipeline/route.ts` — `POST`, `export const maxDuration = 120`, streams the
  generator as SSE. Manual `gen.next()` loop (a `for await` drops the return value):
  progress frames as default `data:` events, the terminal `PipelineResult` as an
  `event: done` frame. Rate-limited ("pipeline"), 400 on empty/bad body, `X-Accel-
  Buffering: no` to defeat proxy buffering.
- `src/ui/pipeline/usePipeline.ts` — client hook; EventSource can't POST a body so it
  reads the SSE off a `fetch` body reader by hand (frame-split on blank line). Types via
  `import type` so no server code leaks to the bundle. Handles non-stream errors (rate
  limit/400), the terminal ok/error frame, AND a stream that dies before the terminal
  frame (→ retryable error — the maxDuration/proxy-drop case; pipeline is idempotent).
- `src/ui/pipeline/LoadingView.tsx` + `pipeline.css` — design.md §8 surface: Gracie scene
  cycles per stage (parse=route-scribble, resolve=pin-throw, matrix=this-is-fine,
  solve=soup-stir), progress is a **soup pot filling** with `--soup` (not a generic bar),
  failure = frozen "this is fine" (new `paused` prop on GracieScene) + legible message +
  retry. Tokens only.
- `app/debug/pipeline/page.tsx` (DEBUG_BOARD gate) + `src/ui/pipeline/PipelineDebug.tsx`
  (client driver) + `e2e/pipeline.spec.ts` (paste blob → real progress → reveal handoff
  with persisted trip + anchor/precedence/failure; and the 400→error→retry path).

**D2.2 DONE.**

### D2.3 started: manualOrder backend (audit finding 12) DONE (2026-07-05)

The reorder machinery the reveal sidebar needs, built + tested backend-first (orchestrator,
Opus). `TripDay.manualOrder?: string[]` (additive); DayPlan `quality` union gains `"manual"`;
rescheduleDay's quality param widened. planTripDay: when a VALID manualOrder (exact
permutation of the day's stop ids — stale/partial/unknown → ignored, solver resumes) is
present, it skips planDay and retimes that exact order with quality "manual"; an anchor-
breaking manual order returns the structured infeasible report (UI will render it as a red
margin note in D2.3's sidebar). PUT route validates the new field. Tests
`src/lib/__tests__/planService.manualOrder.test.ts` (3): honored+labelled manual, invalid→
solver fallback, anchor-break→infeasible. Gates: tsc clean, jest **104/104**, e2e green.

**Remaining in D2.3 (the big design-heavy UI phase — NOT yet built):**
- Real greeting page `/` (paste box hero as the product, replacing the old board front door;
  old board → `/debug` env-gated per plan). Wire it to the D2.2 pipeline stream.
- Reveal: MapLibre paper map (`maplibre-gl`, the one allowed heavy dep, lazy-loaded on the
  reveal route) + the **style JSON authored from design.md §8** — this is the
  screenshot-vs-board collaborative step Chris and I agreed on (boards are mood targets).
  Cloud transition (~1.6s, reduced-motion→crossfade). Route draw-on (dasharray). Stops as
  hand-drawn numbered pins.
- Torn-paper sidebar: dnd-kit reorder → writes manualOrder (machinery now ready) + map
  re-path + pencil-scribble sfx; "re-optimize" pencil clears manualOrder; infeasible manual
  order → red ink margin note. Carry the LOCKED §2 surfaces into the new UI (per-leg
  walk/drive toggle with both times; walkMax/driveOverheadMin "planner's notes" pocket).
- Close the **stop-id dedup gap** (logged above) when wiring the real greeting flow.
- D2.4 done-check + LIVE-CHECKLIST append (real paste with ANTHROPIC_API_KEY — CHRIS-STEP). Map reality check also explained to Chris:
boards are mood targets; real map = MapLibre + custom style JSON over free OSM vector
tiles (style rules apply globally by data category), authored in D2 with a real
side-by-side against the board. Higgsfield credits ~28 remain.

---

## SESSION HANDOFF (2026-07-05, Opus 4.8 1M) → Fable fresh session

Ran D2.3 (reveal + map) on branch **`d2.3-reveal`** (off main @ 1909c14). **main auto-deploys to Vercel
prod — do NOT push half-built D2.3 to main; merge only at the D2.4 done-check.** Orchestration protocol:
delegate→corroborate, fresh-context audit before any phase-complete, **serialize gate-runners** (every
implementer/reviewer runs `npx playwright test` which binds `next dev` on :3111 — one at a time). Live
task ledger: `.superpowers/sdd/progress.md` (git-ignored scratch — read it for the full task-by-task trail).

### Committed on `d2.3-reveal` (backend + front-door — DONE; branch gates: tsc clean · jest 109 · Playwright 14)
- **T2** (`73d1c8f`): old editable board → `app/debug/trip/[id]` env-gated (`DEBUG_BOARD=1`) + `/debug/trip`
  entry; trip/share/multiday e2e retargeted. Fresh-reviewer clean; 404-gate live-verified.
- **T3** (`c25f9a6`): greeting page `/` (paste-box hero, design.md §8) wired to the D2.2 pipeline; interim
  reveal `app/trip/[id]/page.tsx` (reuses PlanView). Screenshot-reviewed. Pre-existing parse quirk noted
  (heuristic parser folds an inline time hint into the display name — later polish).
- **T4→T4b** (`5ea9719` superseded by `e630af6`): duplicate handling. **Chris's call: ALLOW + FLAG, not
  dedup.** Two links → same place/day = TWO stops; 2nd gets a deterministic suffixed id (`place#2`) +
  `duplicateOf` (added to TripStop, PUT-validated). Real matrix adapter is location-driven (safe; LOCKED
  cacheKey format untouched). 5 non-vacuous tests. **The `duplicateOf` UI is a T6 deliverable — NOT built.**

### The MAP — pivoted to a custom render engine (phase M0, IN PROGRESS)
Chris **rejected** the plan's "MapLibre + paper style JSON" after two tries (flat vector style, then a
filtered "artistic layer") — both read as a street map in a paper costume, not the illustrated board.
**New direction, Chris-approved plan → `design/map-engine-plan.md`:** build our own journal-map render
engine. Fidelity = AI watercolor textures (once, offline) + procedural render; **no per-trip AI**;
whole-world via render-on-demand + cache (v2), never a planet pre-render; layer split = painted basemap +
live overlay (route/pins/washi) that redraws on reorder.

**M0 art direction is PROVEN** — the engine paints real Johor Bahru geometry (OpenFreeMap MVT) with our
textures + Rough.js and reads as the board (`design/refs/d2.3-map-engine-vs-board.png`). Persisted to repo:
- `design/map-engine/` (see its **README.md**): `map-render-core.js` (the engine core / M1 module —
  `fetchAndDecode` + `paintFull`), `render-engine.mjs` (screenshot harness), `map-studio.mjs` (**live
  tuning tool**), 4 textures, briefs.
- `public/map/assets/tex/{land,water,park,weathering}.png` — production textures (Recraft V4.1,
  palette-locked to design.md §3, Chris-approved; water v2 bluer/uniform, park v2 olive/distinct).
- **Map Studio** (`design/map-engine/map-studio.mjs`; launcher `C:\Users\65881\map-studio.bat`): sliders/
  color-pickers bound to the render CONFIG, instant repaint, **Copy-CONFIG** export, Download-PNG,
  colorblind-sim toggle. This is how Chris dials the art.
- Iterated per Chris's notes: label subsystem (curved water text-on-path via PCA channel-spine +
  collision point labels — **water-label-on-land bug FIXED**: anchor-centered text + `cloudRadiusFrac`
  0.17→0.09), translucent torn-edge washi, fine-marker route, JB+Straits crop, textures v2. Higgsfield ~776 cr.

### ⛔ M0.5 art gate is NOT closed — Fable, do this FIRST:
1. **Get Chris's tuned CONFIG** from the studio (he runs `map-studio.bat`, tunes, clicks **Copy CONFIG**).
   Paste that JSON in as the `CONFIG` defaults in `design/map-engine/render-engine.mjs` + `map-studio.mjs`.
   That LOCKS the art. The current CONFIG is a WIP default, not final.
2. **M1:** wire `map-render-core.js` into the real reveal at `app/trip/[id]` (adapt the browser module for
   Next/React — it loads pbf/@mapbox/vector-tile/roughjs from jsDelivr; bundle or lazy-load them on the
   reveal route only). Fixed-view; route re-sketches on reorder (`manualOrder` plumbing exists).
3. **M2:** Motion (motion.dev, Chris-approved) lazy on the reveal route — cloud transition, route draw-on,
   re-sketch + sfx.
4. **T6 sidebar:** torn-journal, dnd-kit reorder → `manualOrder`, re-optimize clears, infeasible → red
   margin note, **+ the `duplicateOf` flag UI + remove control + reveal heads-up**.
5. **T7:** LOCKED §2 surfaces — per-leg walk/drive toggle (both times) + walkMax/driveOverhead "planner's
   notes" pocket.
6. **T8** D2.4 Playwright full-flow · **T9** fresh-context whole-branch audit · **T10** done-check +
   STATE.md + LIVE-CHECKLIST + merge `d2.3-reveal` → main.

### LOCKED / do not relitigate
design.md palette+type+Gracie; the ALLOW+FLAG dedup call; the custom map-engine direction + its plan;
Motion adopted for the reveal (component libs Chris shared = ideas only, NOT their glassmorphism visuals).
Textures + final map CONFIG = Chris's calls. Read before touching anything: master plan (D2.3), design.md,
`design/map-engine-plan.md`, `design/map-engine/README.md`, and this handoff.

---

## M0.5 engine fidelity pass (2026-07-06, Fable session — Chris's audit request)

Chris (this session, via grill round): washi = **board-faithful shape + patterned variants** (explicitly
NOT the physical-cues option — no drop shadow/fiber/multiply); text/pins = **match the board's
proportions** + density thinning; crowding = **trip-overlay-wins policy + studio knobs**; Copy-CONFIG =
he'll paste it (NOT yet received — see open items).

**Built (all in `design/map-engine/`, engine core + both callers + smoketest comment):**
- **Resolution-invariant sizing:** every CONFIG px value authored at `REF_TILEPX` 1024; paint scales by
  `K = TILEPX/REF_TILEPX` (deriveSizes). SCALE now changes resolution only — the root cause of "fonts
  don't render accurately" across studio/harness (28px meant different proportions at SCALE 2 vs 4).
- **Text:** optical centering from measured glyph bounds (X too for digits); explicit text state at every
  draw site; ALL map lettering → `FONT_FAMILY_HAND` (Segoe UI on washi/pins violated design.md §2.4);
  tape content-sized; two-line wrap for long place names; per-feature seeded Rough.js strokes
  (byte-identical repaints — smoketest colorblind-restore now meanDiff **0**; M1/M2 determinism
  constraint pre-satisfied).
- **Washi:** tilt (−3°), multi-scale torn ENDS only, no perimeter outline, matte (sheen dial default 0),
  circled stop number + 'Booked' in ink (rough circle; `fill:'none'` hachure artifact found+fixed),
  optional gingham/stripes pattern (tint token `washiPatternTint`), placement collision-tested (may lie
  across the route, never covers a pin, never leaves frame — 5 candidates, best-effort fallback noted).
- **Crowding:** shared occupied-region list across ALL passes (pins + washi + route-line sample boxes +
  point labels + water-label glyphs); point labels nudge (11 posns incl. diagonals) → shrink (floor 0.8)
  → drop, fully-inside-frame required (kills mid-word frame slicing), density cap applied AFTER
  in-view filtering (first cut capped on the whole fetch footprint — found via stats, fixed); curved
  water labels slide along the spine (9 offsets) + shrink (4 steps) to a fully clear window, glyphs
  NEVER dropped mid-word (the "Straits … Johor" bug); pin declutter with ink leader + true-spot dot.
- **`upgradeConfig()` exported:** old flat Copy-CONFIG shapes (FONT_LABEL/PIN_DIAMETER/WASHI_*) migrate
  losslessly at their own authored proportions (REF_TILEPX inferred = TILE×SCALE). Studio gained Pins /
  Crowding / extended Washi control groups + a 'select' control type; smoketest-pinned control labels
  unchanged.

**Verified:** harness ok 6/6 tiles 0 errors (multiple runs incl. final); washi detail crop inspected at
3×; studio smoketest PASS end-to-end (boot/control/view/colorblind, meanDiff 0); repo gates re-run
fresh: tsc clean · jest **109/109** (18 suites) · Playwright **14/14**. Fresh-context review (opus,
diff cold): verdict **PASS, 0 blocking**, 2 minor + 7 observations — both minors fixed (rotated-extent
test for the straight water-label fallback; nudges-migration gated to old-shape configs) + 3
observations hardened (pattern tint tokenized; 2-digit washi ring sizing for M1; stale smoketest
comment). Accepted as-is with rationale: washi placement best-effort fallback (5th candidate wins even
if imperfect — revisit at M1 with real trips), curved-glyph square boxes (~0.19×size under-cover at 45°,
invisible at hand-font sizes), route-box sampling gaps (smaller than any label box), latent
`WASHI_INDEX`/empty-geom crash paths (impossible with shipped config; M1 wiring owns real-data guards).
Comparison refreshed: `design/refs/d2.3-map-engine-vs-board.png`.

**Deviation (logged):** Chris ordered "M0.5 config-lock first, then audit" — inverted deliberately: the
fidelity fixes add tunables his old export can't carry, so lock-then-fix would have double-tuned. His
paste (whenever it lands) migrates via `upgradeConfig` and becomes the defaults; final lock after ONE
studio pass over the new dials.

**OPEN (art gate still ⛔):** (1) Chris's Copy-CONFIG paste → set as defaults in both callers;
(2) Chris re-tunes new dials in the studio + re-vets `design/refs/d2.3-map-engine-vs-board.png` →
M0.5 CLOSED. M1 wiring proceeds meanwhile (config values are data, not API).
→ Both resolved same session — see the next two sections.

---

## M0.5 art gate CLOSED (2026-07-06, same Fable session — three Copy-CONFIG passes by Chris)

Chris drove the lock live across three studio exports, all integrated into the new single style
source **`src/lib/map/map-style-defaults.mjs`** (see below for why that file exists):
- **Pass 1 (old-shape export):** slider-backed deltas adopted (texture grain 0.51, road tan
  `#967240`, coast 0.9 / arterials 2.0, weathering 0.35 + vignette 0.35 at the time, parks 0.47,
  route marker 3.4/2.8→2.1/0.37, tape alpha, tertiary roads ON, labels 15px / halo 2, water
  15–20px / spacing 3, crop W 103.671). Stale old-build internals REJECTED (cloudRadiusFrac 0.17,
  PIN 36, Segoe fonts, 5-nudge list) — they'd have resurrected fixed bugs. Deviation from "adopt
  the paste verbatim" logged and explained to Chris.
- **Emergent fix:** his 15px labels exposed a placement gap — nudge distance scales with font
  size, so the ladder couldn't clear the route corridor and "Johor Bahru" silently dropped.
  Ladder extended to 21 candidates (3-step reach) in all three copies (style defaults +
  upgradeConfig defaults + old-shape migration list) — city restored, still zero overlaps.
- **Pass 2 (new-shape export, post-fidelity dials):** gingham tape trial, salmon `#ff9e9e` fill,
  pins 21/1.2/18, fine tear serration (20 segs / 1.7+1.5 amp), weathering + vignette to ZERO,
  water text 11–16px / fillFrac 0.45, maxLabels 10, shrinkFloor 1, edgeMargin 15, SCALE 6 (bench).
  Two token divergences flagged to Chris per §9 (salmon vs the yellow booked semantic; vivid pen
  vs `--route-blue`).
- **Pass 3 (LOCKED):** Chris resolved both — booked tape back to YELLOW as `#ffdf6b` (a §3
  lighter-shade derivation of `--washi`, so booked stays yellow on every surface), pattern plain;
  vivid map pen `#2e79ea` CONFIRMED. design.md §3 rows annotated (map-pen split — UI token
  `#3E6C8E` unchanged since the vivid fails 4.5:1 for text; washi variant note) and §8's stale
  MapLibre map-style section rewritten to point at the engine + lock file. Weathering/vignette at
  0 are his deliberate zeros (clean paper; warmth carried by the land texture — no §9 conflict:
  the lock governs hues, not overlay intensity).
- Ground truth refreshed: `design/refs/d2.3-map-engine-vs-board.png` (locked render vs board).
  **M0.5 DONE.**

## M1 — engine wired into the real reveal at /trip/[id] (2026-07-06, same session)

**Built:**
- **Engine moved to product:** `git mv design/map-engine/map-render-core.js →
  src/lib/map/map-render-core.js` (history preserved). Both bench tools serve it from there
  (CORE_PATH) at the same URL, and import the new **`src/lib/map/map-style-defaults.mjs`** —
  ONE art source for app + harness + studio (kills the config-drift risk that motivated the
  "paste into BOTH callers" step in the old handoff).
- **Core M1 API:** `provideLibs()` (app injects npm-bundled pbf@3.2.1 / @mapbox/vector-tile@1.3.1 /
  roughjs@4.6.6 — exact CDN-parity versions; the jsDelivr fallback imports carry
  webpackIgnore+turbopackIgnore so bundlers never resolve them); **base/overlay scene split**
  per the plan's layer rule — `buildScene` (geography + labels painted once, snapshotted) /
  `paintOverlay` (route/pins/washi per visit order on the restored snapshot) /
  `renderToDisplay` (crop → display canvas, width-capped); `paintFull` wrapper keeps the bench
  byte-compatible (z-order note: water labels now sit under the overlay; placement already avoids
  it, so only a REORDERED route can cross one — accepted, logged). `WASHI_INDEX` null/-1/oob →
  no tape (real trips may have no booked anchor).
- **`src/ui/reveal/RevealMap.tsx`** (client): computes the fixed view from stop coords (padded
  bbox → Z toward ~1150px crop at K≈1, Mercator-correct placeholder aspect), resolves the hand
  font from next/font's `--font-display` variable (canvas needs the REAL renamed family), lazy
  npm-lib injection, textures from `public/map/assets/tex/`, base painted once + overlay redrawn
  on order/booked changes, ResizeObserver re-blit, DPR-capped display, journal-voice error state
  with retry, decode cache cleared on unmount. e2e hooks: data-phase/paints/order/washi.
- **`app/trip/[id]/page.tsx`:** mounts RevealMap above PlanView for the first day with stops
  (order = `plan.order` when ok — manualOrder flows through — else stored order; booked = first
  anchored stop; multi-day caption until T6's day tabs). **Resilience fix found by live smoke:**
  `planTripDay` failures used to 500 the whole reveal; now caught per-day → PlanView's rejected
  state renders and the map still paints the stored order.
- `src/types/untyped-map-libs.d.ts` (ambient decls; no @types deps), `e2e/reveal.spec.ts`.

**Verified and how (fresh runs this session):**
- `npx tsc --noEmit` → clean · `npx jest` → **109/109** (18 suites) · `npx playwright test` →
  **16/16** (2 new reveal specs: map paints with all stops + washi on the anchored stop, canvas
  pixel variance; pinned manualOrder reload paints that exact order — tiles network-stubbed:
  TileJSON → stub, tiles → 404, engine's failed-tile tolerance exercised, zero external network).
- `npx next build` → **clean production build**; /trip/[id] = 12.6 kB route JS + 115 kB first
  load; engine libs are lazy async chunks; landing page untouched (plan constraint met).
- **Live visual smoke** (real OpenFreeMap tiles, dev server, real JB coords): page ready, 1 paint,
  all 5 stops in order, washi=1, ZERO console/page errors — screenshot eyeballed (locked art on
  the real page; PlanView correctly showed its rejected state for the synthetic fixture-unknown
  ids — the resilience path, working as designed). Also proves the npm-lib decode path against
  real tiles (dev bundling).
- Bench after the move: harness ok 6/6 + studio smoketest PASS (all controls, meanDiff 0).
- **Fresh-context review (opus, cold diff): 0 blocking, 2 minor, 6 observations.** Every locked
  value verified byte-exact; ladder copies identical; upgradeConfig round-trips the lock
  unchanged; no canvas-state leaks across overlay repaints; overlayFor desync ruled out
  (plan.order is a strict permutation by construction). Both minors FIXED post-review (decode
  cache cleared on unmount; Mercator placeholder aspect) + re-verified (tsc, reveal e2e 2/2).
  Observations accepted with rationale: transient stale-scene paint masked by React batching
  (M2 note), pin-declutter direction is order-dependent-but-deterministic (M2 drag-UX note),
  production-webpack real-tile decode unexercised by automated tests (dev-bundled live smoke +
  identical engine source on the bench path = low risk; add to the D2.4 deployed-preview
  eyeball), loose pixel threshold backed by attribute assertions, weathering-zero documented,
  computeView Z-floor canvas guard unnecessary at product scale.

**Deviations:** M0.5/M1 ordering inverted vs the handoff (fidelity fixes before config lock) —
logged above with rationale; plan's "MapLibre + style JSON" reveal fully superseded by the
engine (already an approved deviation, now reflected in design.md §8).

**Next (per handoff order):** **M2** motion (cloud transition, route draw-on + re-sketch + sfx,
lazy Motion) · **T6** torn-journal sidebar (dnd-kit reorder → manualOrder wired to the live map
overlay + duplicateOf flag UI) · **T7** LOCKED §2 surfaces · **T8** full-flow e2e · **T9** whole-
branch audit · **T10** done-check + merge to main. Higgsfield ~776 cr. `.superpowers/` scratch
remains untracked by design.

---

## M2 — road-following pen + reveal motion (2026-07-06, same Fable session)

**Chris's calls (AskUserQuestion round):** route geometry = **AWS Location / GrabMaps** (Grab
data in SEA, global standard data from the same API; observed gap: the pen didn't follow roads —
not in the original design, but the board's illustrator line does); **fold into M2 now** (draw-on
animates the final path); **matrix stays Google through launch** (evaluate a swap post-launch as
a cost lever). Also noted for later: pedestrian matrix (truthful walk labels — open
LIVE-CHECKLIST item), transit/scooter modes, isolines; their waypoint optimizer rejected (our
anchor/walk-drive solver IS the product).

**Built:**
- **M2a (sonnet subagent; diff verified line-by-line by the orchestrator):**
  `src/lib/maps/routeGeometry.ts` + `app/api/route-geometry/route.ts` — AWS geo-routes v2 proxy
  (POST 1–25 legs → per-leg simplified [lng,lat] polylines or null). Fail-OPEN everywhere
  (decorative — the documented OPPOSITE of kvMatrixCache's throw-to-protect-billing contract);
  no key → all-null with ZERO fetches/cache calls (dev/jest/Playwright spend nothing);
  Douglas-Peucker simplify (≈39 m tol, ≤80 pts, off-by-one-safe cap); 4-in-flight semaphore;
  KV cache (`geo:v1:` keys, 5dp rounding, nulls never cached) with in-memory dev fallback;
  rate-limited; journal-voice errors. Env: `AWS_LOCATION_API_KEY`, `AWS_LOCATION_REGION`
  (default ap-southeast-1). Jest guard extended: tests may not ASSIGN the AWS key env var
  (module is deliberately import-safe, unlike realAdapter — reasoning verified). **LIVE-SHAPE
  NOTE:** the AWS response field parse (Routes[].Legs[].Geometry.LineString) is defensively
  guarded but UNVERIFIED against a real call — confirm at the key-creation CHRIS-STEP.
- **M2b (engine):** `buildRoutePath` (per-leg polylines projected, endpoint-snapped onto pins,
  thinned to keep the pen soul), `trimPathByProgress` (arc-length draw-on clip),
  `computePinArcFractions` (pins pop when the tip passes), paintOverlay params
  {legGeometries, routeProgress, pinPop, washiSettle}, drawWashiTag alphaMul, buildScene
  opts.legGeometries (label collision seeds from the REAL pen path on the geometry rebuild).
  All default to previous behavior — bench re-verified identical.
- **M2c/d (RevealMap):** progressive geometry (sketch instantly → proxy fetch → ONE scene
  rebuild with geometry-aware labels → repaint; stale-order responses discarded; every failure
  → sketch; data-geometry pending→roads|sketch), full choreography via `motion` (clouds part
  1.1s → pen draws on → pins pop with overshoot as the tip passes → tape settles; reorder =
  0.9s re-sketch + pencil sfx), per-frame paints bypass React state (no 60fps churn),
  prefers-reduced-motion collapses everything to instant frames, sfx behind the §2.10 mute
  toggle ("sound: on/off" text chip — no stock icons per §2.6; default ON, persisted,
  first-gesture-gated). New dep: motion 12.x (reveal route chunk only).

**Verified (fresh, this session):** tsc clean · jest **119/119** (19 suites; 10 new) ·
Playwright **18/18** (4 reveal specs: paint/washi/manualOrder + NEW roads-upgrade +
sketch-fallback, proxy stubbed, reduced-motion emulated) · `next build` clean (landing bundle
untouched) · **live animation probe** (real dev server, motion ON): clouds present at ready →
mid-drift at +500ms (translateX −42.7%, scale 1.117) → removed at end; anim idle→running→done;
geometry→sketch without key; ZERO console/page errors; frame captures confirm draw-on
progression, mid-pop pins, washi settling last. One dev-only artifact diagnosed (first-hit
lazy-compile full reload mid-animation — absent in production builds). M2a's 26+-leg case
traced: 400 → RevealMap degrades to sketch (and the solver rejects >15-stop segments upstream
anyway). Accepted edge: duplicate identical pairs in one request may double-fetch once
(pathological input, cache converges).

**⚠ Independent fresh-context review PENDING:** the reviewer subagent was killed mid-run by the
account session limit (resets 09:30 SGT). Committed now for rollback safety per protocol; M2 is
NOT declared closed until that review runs clean. The orchestrator DID line-verify the M2a
subagent diff (mandatory step, done — no defects; two accepted observations above).

**CHRIS-STEP (enables road lines on the live site — everything ships safely without it):**
AWS account → Amazon Location console → create API key restricted to `geo-routes:*`
(resource `arn:aws:geo-routes:ap-southeast-1::provider/default`), note the pricing panel +
set a billing alarm → add `AWS_LOCATION_API_KEY` (+ optional `AWS_LOCATION_REGION`) to Vercel
Production env → redeploy → paste a real trip and confirm the pen follows roads (this also
verifies the LIVE-SHAPE NOTE above).

---

## M2 CLOSED + T6 — sidebar shipped (2026-07-06, same Fable session)

**M2 independent review (opus, committed diff 4725ad1): verdict REFUTED → all findings fixed,
then closed.** B1 (BLOCKING, real): pin pops were driven off route progress, which saturates at
t=0.72 — the destination pin's window could only open 0.133 wide, freezing it at ~52% scale for
~0.6s before the finalize frame snapped it to full, on EVERY reveal. Fixed: pops are now
TIME-driven from each pin's crossing moment (fixed 0.12 window); proven by simulation — worst-case
last pin starts t=0.722, completes t=0.842, exact 1.0000 at the final frame, no snap. M1 (minor):
the reorder→roads scene rebuild mixed the INITIAL order's config with CURRENT-order geometry,
garbling the label-collision seed — rebuild now carries the current ROUTE_POINTS/WASHI_INDEX.
Also fixed from observations: dead stale-guard removed (staleness honestly documented as handled
by the effect's alive flag), env-key guard regex hardened (bracket assignment form, === exempt),
cloud animation stopped on unmount, unknown-stop path settles data-geometry to "sketch" instead
of sticking at "pending", redundant aria-pressed dropped from the sound chip, interrupt comment
reworded honestly. Accepted with rationale: no negative-caching of null legs (out-of-coverage
legs re-bill per reveal — post-launch cost lever, revisit with real usage), washi settle's ±4°
transient vs its planned AABB (fades at max deviation), pop-timing keyed to true positions vs
decluttered draw positions (visual nuance). Reviewer confirmed clean: no key leakage, directional
cache keys, race-free semaphore, SSR safety, §2.6/§2.10 compliance, e2e coordinate order.

**T6 (sonnet subagent; diff line-verified by the orchestrator + visual pass):**
- `src/ui/reveal/RevealClient.tsx` — owns doc/plans/activeDay; visit order = plan.order →
  valid manualOrder → stored; optimistic pendingOrder overlay with revert; ALL mutations
  (reorder / re-optimize / remove-stop) serialized behind one busy flag, PUT doc → POST
  /plan → commit-or-revert with a journal-voice margin error; day tabs (washi buttons,
  yellow = active); transient state cleared on tab switch.
- `src/ui/reveal/JournalSidebar.tsx` + `reveal.css` — torn journal page (fixed-wobble
  clip-path, hydration-safe; ruled-lines texture on the non-scrolling layer with the §2.1
  not-a-gradient rationale commented), dnd-kit rows (Pointer + Keyboard sensors) with
  WashiTag handles (decorative tones rotate; booked = yellow "✓ Booked" + hand-authored
  anchor glyph — the product's first icon, authored per §2.6), wait notes, quality lines
  ("Your order — Gracie's re-timed it." + Re-optimize; heuristic note), red-ink margin note
  (rotated, on a --paper inset so --danger clears 4.5:1 for axe), duplicateOf note
  ("same place as stop N — remove if it snuck in twice?") + remove control that scrubs
  manualOrder/precedence/legOverrides, green "Share this plan" → /share/[id].
- `WashiTag` extended additively (tone prop + as="button" forwardRef for the keyboard-
  focusable dnd activator; default renders identically — existing caller unaffected).
- `/trip/[id]` page slimmed to fetch + `<RevealClient>`; greeting.spec retargeted to the
  sidebar testids (PlanView left this page; unchanged on /share and /debug).
- **Real bug found by the subagent's own verification:** dnd-kit's KeyboardSensor updates
  collision state on the browser's RAF loop — back-to-back synthetic Space/Arrow/Space
  landed the drop before `over` updated, silently no-oping. Fixed with settle pauses in a
  test helper; re-ran the spec ×2 to prove non-flakiness.
- **Post-visual-pass polish (orchestrator):** rejected-plan margin notes no longer double-
  prefix (rejected messages arrive self-explanatory; only infeasible gets the framing).

**Verified (fresh, orchestrator-run):** tsc clean · jest **119/119** (19 suites) ·
Playwright **23/23** (5 new sidebar specs incl. keyboard reorder → manualOrder → map
re-path, re-optimize round-trip, duplicate remove, and an axe scan with 0 violations) ·
`next build` clean · visual smoke: stacked layout, ruled sidebar, rotated washi handles,
booked tag + anchor glyph, red margin scribble, share button — the board's sidebar
language, live. Screenshot session captured mid-draw-on with zero console errors.

**Ops note:** C: hit 100% full mid-run (wedged one dev-server compile; the stalled
verification chain was killed and re-run staged). Chris cleared to ~15.8GB free. If a
build/dev compile ever fails weirdly again, check disk first.

**Remaining in D2.3:** T7 (per-leg walk/drive toggles + walkMax/driveOverhead "planner's
notes" pocket — the sidebar rows' right column is reserved for it) · T8 full-flow e2e ·
T9 fresh-context whole-branch audit · T10 done-check + STATE + LIVE-CHECKLIST + merge to
main. CHRIS-STEP unchanged: AWS Location key → Vercel env (road-following pen goes live).

## T7 — §2 LOCKED surfaces on the sidebar (2026-07-06, same Fable session; orchestrator-built)

Leg lines between rows (only when the plan's order IS the displayed order — hidden during the
optimistic drag window so §2 semantics always come from the plan, never guessed client-side):
mode word + BOTH times on eligible legs ("walk 3 min · drive 4 min"), "take the drive/walk"
toggle → legOverrides upsert (same shape as the old board's toggleLeg) → PUT → re-plan →
re-timed, never re-ordered, "— your pick" marker, persists across reload. Planner's notes
pocket (collapsed <details>): walkMax + driveOverheadMin drafts, explicit Apply (one deliberate
PUT + re-plan of EVERY day — settings are doc-level), validation 0–120. Tokens/voice per law.
**Verified:** tsc clean · Playwright **25/25** (2 new: eligible-leg both-times + toggle
re-time/persist/no-reorder; walkMax-0 forces all legs to drive via the pocket) · build clean ·
visual pass (fixture-city Bristol render: leg lines, toggle links, booked row, pocket — all
reading like the board). Cosmetic nit accepted: on eligible legs the mode word + times read
"walk · walk 3 min…" — slightly stuttery, Chris may re-copy at his eyeball. Jest untouched
(no new unit surface). **Remaining: T8 full-flow e2e · T9 whole-branch audit · T10 done-check
+ merge (merge = production deploy — gets Chris's explicit go first).**

## T8 — full-flow e2e (2026-07-06, same Fable session)

`e2e/fullflow.spec.ts`: ONE spec drives the whole product journey on fixture data with stubbed
tiles + reduced motion — paste the messy blob on the real greeting → real /api/pipeline SSE cook
→ redirect to the reveal → journal map paints + sidebar carries the three cooked stops →
keyboard drag one slot (manualOrder; map re-paths; Re-optimize appears) → §2 toggle on the first
eligible leg (mode flips, "your pick", pinned order unchanged) → /share/<id> recomputes the SAME
doc: exact pinned order, the leg pick honoured, zero editing affordances. **Playwright 26/26**
(whole suite) · tsc clean. T8 DONE.

## T9 — whole-branch fresh-context audit (2026-07-06): VERDICT MERGE-READY, 0 blocking

Independent opus auditor read the full 1909c14..e1b6995 diff cold. **Zero blocking.** Both
minors FIXED this session: (M1) the pipeline resolve step now carries the same 40-input spend
cap the resolve route has had since D0 — overflow links surface in the failure panel with a
journal-voice note, never silently dropped; (M2) app/layout.tsx's stale font-claims comment
rewritten honestly. Observations dispositioned: (O1) design.md §8 now states explicitly that
the M0.5 lock file is the sanctioned home of the map's supporting hues (Chris locked them via
his own Copy-CONFIG passes; §3's no-hex rule governs component code) — no new approval needed,
documented; (O2) FIXED — removing an original stop now clears duplicateOf on its surviving
copies; (O3) unbilled create/PUT routes stay unlimited (KV-only, validated writes — accepted);
(O4) greeting's discarded plan compute = one redundant cache-hit solve (accepted); (O5) ~56MB
texture duplication repo-side only (bench copies deletable post-launch if size ever matters);
(O6) leg-line copy stutter already flagged for Chris's eyeball. Auditor's verified-clean list:
locked ports byte-untouched (solver/schedule/matrixSource zero diff), suffixed duplicate ids
safe through the real matrix, no key material anywhere, all billed routes rate-limited +
capped, both optional keys degrade cleanly (no-AWS → sketch; no-ANTHROPIC → heuristic), only
extracted URLs reach Places, §2/§4/§5 law holds on every new surface, M2's B1/M1 fixes present
and correct, CDN lib path dead in the app, debug surfaces gated, docs honest.
**Post-fix gates:** tsc clean · jest 119/119 · Playwright 26/26.

## T10 — done-check (2026-07-06)

D2.3 done contract against the plan: greeting IS the front door wired to the real pipeline ✓ ·
reveal = custom journal map engine (M0.5 art LOCKED by Chris; M1 wired; M2 road-pen behind an
optional key + full choreography with reduced-motion) ✓ · torn-journal sidebar with dnd
reorder → manualOrder → live re-path + re-optimize + duplicateOf flag UI (T6) ✓ · §2 LOCKED
surfaces carried into the new UI (T7 leg toggles both-times + planner's notes pocket) ✓ ·
duplicate ALLOW+FLAG end to end (T4b→T6) ✓ · old board env-gated at /debug (T2) ✓ · full-flow
e2e (T8) ✓ · whole-branch audit clean (T9) ✓ · gates green at HEAD ✓ · LIVE-CHECKLIST §§7–8
appended (post-merge live checks + the optional AWS key step) ✓.
**Merge to main = production deploy of the new front door — awaiting Chris's explicit GO.**
UNVERIFIED-by-design at merge time: AWS live response shape (checklist §8), live paste with
ANTHROPIC key (checklist §7 / D2.4), Gracie art still provisional (Chris's own pass, D1
proviso), sfx still placeholder foley.

---

## Post-launch polish (2026-07-07, on main — Chris testing the live product)

**AWS road pen VERIFIED LIVE.** Chris added AWS_LOCATION_API_KEY + ANTHROPIC_API_KEY +
PARSE_PROVIDER=llm to Vercel. Full prod audit (homepage / pipeline / route-geometry /
headless reveal): all healthy, zero client errors; `/api/route-geometry` returns real
GrabMaps polylines and the reveal paints `data-geometry="roads"` → the routeGeometry.ts
LIVE-SHAPE NOTE (Routes[0].Legs[].Geometry.LineString) is CONFIRMED correct against the real
geo-routes v2 API. A "seems broken" scare after the key-add was not reproducible on any
surface — most likely the Vercel redeploy window.

**Testing timer** (committed): usePipeline stamps `ts-cook-t0` at submit; LoadingView counts
up live ("cooking · 2.3s"); RevealMap shows "ready in X.Xs" + logs the full paste→map total.

**Reveal art iteration** (Chris's three notes with real data in front of him, all directions
his call via AskUserQuestion):
1. **Route not on roads → denser roads.** GrabMaps' full network ≠ our sparse arterials, so
   the pen floated. Added a residential/minor grid (`ROAD_CLASSES_MINOR: [minor, service]`,
   light tan `#c9bda1`, thin 0.9, painted UNDER the arterials) so the road-following pen sits
   on drawn streets — board-faithful density. Bench-verified.
2. **Sidebar tape didn't look like tape → gingham.** journal.css WashiTag now reads as real
   washi: gingham weave on the decorative tones, translucency, paper-lift, portrait tape-strip
   shape for the empty drag handles; booked stays solid yellow.
3. **Scale not harmonious → full-frame board + ROOT-CAUSE FIX.** The map rendered small in a
   sea of empty space because **globals.css `main { max-width: 880px }` (a legacy narrow-page
   rule) was capping the reveal main at 880px** — the inner 1360 frame never had room (this
   also explains why prod looked small all along). Fixed with `maxWidth:"none"` on the reveal
   main. Plus: grid 65/35 map-dominant with `width:100%` (fr tracks were shrink-wrapping to the
   canvas's intrinsic width → 832px board), `align-items:stretch` so map+sidebar are one board,
   aspect floor 0.72 so a compact trip's crop isn't letterbox-short, Share pinned to the foot,
   compacted header. Desktop probe confirms layout 1360 / map 867.

**Gates:** tsc clean · jest 119/119 · Playwright 26/26 · build clean · desktop visual vs board
(`design/refs/d2.3-map-engine-vs-board.png` refreshed). **SHIPPED 2026-07-08** — commit
`ccfa6f3` pushed to `origin/main` (Chris authorized), production live at trip-soup.vercel.app.
**Deferred doc:** fold the AWS "verified" status into the routeGeometry.ts comment +
LIVE-CHECKLIST §8 on a later commit.

---

## SESSION HANDOFF (2026-07-08, Opus 4.8 1M) → fresh session

**Where we are.** D2.3 (the real product reveal) shipped and merged to production
(`4d9eb01`), then a post-launch polish pass — testing timer + reveal art iteration —
shipped on top (`ccfa6f3`, live now). Working tree clean, `HEAD == origin/main == ccfa6f3`
= exactly what's deployed. All gates green.

**Environment (Vercel prod, set by Chris).** `ANTHROPIC_API_KEY` (claude-haiku-4-5 LLM
parse), `AWS_LOCATION_API_KEY` (GrabMaps geo-routes v2 road pen), `PARSE_PROVIDER=llm`.
`main` auto-deploys to trip-soup.vercel.app (~60s). Vercel KV (Upstash) backs trip/matrix/
geometry caches. There is NO Gemini key — that was for the *separate* casual-labour-mgr
project; TripSoup uses Anthropic only.

**Verified live this session.** AWS road pen confirmed against the real geo-routes v2 API
(`Routes[0].Legs[].Geometry.LineString` — the routeGeometry.ts LIVE-SHAPE NOTE is correct).
Reveal board fills the 1360 frame (map 867). Timer reads out end-to-end.

**What Chris is doing NOW.** Testing the live product. After this deploy he'll eyeball:
(1) route hugs the roads (the denser-roads fix only shows its payoff LIVE — locally there's
no AWS key so the pen falls back to a straight sketch stroke), (2) the testing timer reads
out, (3) the board fills the width / composition feels harmonious. If any art note remains,
iterate BEFORE starting the next phase.

**NEXT PHASE — D3: Supabase auth + Stripe SGD 6.90 Trip Pass** (master plan
`plans/i-want-you-to-starry-wave.md`, LOCKED decisions in memory `tripsoup-production.md`).
Do NOT start D3 until Chris confirms the art pass is satisfactory.

**Gotchas / don't re-break.**
- `app/globals.css` `main { max-width: 880px }` is a legacy narrow-page rule that LEAKS onto
  the reveal. The reveal main overrides it with inline `maxWidth:"none"`. Keep that override.
- Reveal grid must stay `width:100%` + `min-width:0` on `.reveal-layout__map` (NOT flex) —
  otherwise the fr tracks shrink-wrap to the canvas's intrinsic width and the board collapses
  to ~832px. This bit us three times; the comments in reveal.css explain it.
- Art source of truth is `src/lib/map/map-style-defaults.mjs` (M0.5-LOCKED, consumed by both
  the app engine `map-render-core.js` and the bench `design/map-engine/render-engine.mjs`).
  Any art change: edit the .mjs, bench-render, then verify in a real reveal.

**Deferred (small).** Fold the AWS "verified live" status into the routeGeometry.ts comment +
LIVE-CHECKLIST §8. Non-blocking; do it on the next natural commit.

**Working style (Chris's standing protocol — memory `orchestration-working-style`).**
Orchestrate: strongest model owns verification/git/taste; delegate implementation to
`Agent(model: sonnet)`, mechanical to haiku; corroborate subagent claims against their diffs.
Product/UX/pricing/art calls → AskUserQuestion, never decide solo. Per unattended-run-protocol:
one commit per phase with STATE.md updated in the SAME commit; fresh-context review per phase;
UNVERIFIED list for anything only a human/device can check.

---

# POST-LAUNCH UI/UX POLISH PASS (2026-07-08, Opus 4.8 1M) — branch `uiux-polish`

Chris eyeballed the live product and called it "still a disaster." Ran a full mobile+desktop
UI/UX + aesthetic audit (design-audit skill; real screenshots at 390/768/1440 + two read-only
code-mapping subagents), producing a 4-phase plan Chris approved via AskUserQuestion. His 8-item
verdict mapped to phases:
- **A (structure):** responsive (mobile must ≠ desktop), background seam, no-way-home.
- **B (broken surfaces):** `/share` shows NO map (still the legacy P5 PlanView, off-brand);
  landing isn't a landing (paste field not front-and-centre).
- **C (map identity):** tiny invisible pins; empty ruled sidebar expanse.
- **D (motion):** route draws a fuzzy straight line then hard-snaps to roads; wants a slow,
  smooth draw-on.

**Branch discipline (D2.3 precedent):** `main` auto-deploys to prod, so this multi-phase work
lives on **`uiux-polish`** (off `main` @ d340728). Merge → main = deploy = gets Chris's explicit
GO at the end; do NOT push half-built phases to main.

## Chris's LOCKED decisions this session (AskUserQuestion)
- **Landing:** paste field = a **post-it note**, on a **notebook-on-a-desk background scene**;
  the background is to be generated via **Higgsfield MCP**. (Phase B.)
- **Map pins:** **mock BOTH** on the real map — colour-coded push-pin tacks (number on the tack
  head) vs a washi-tape scrap with a circled number — Chris picks from renders. (Phase C.)
- **Sequence:** full plan A→B→C→D; one commit + Chris review per phase.

## Phase A — responsive foundation + seam + home nav (COMPLETE; independent review PENDING)

**Built (this commit):**
- **Home nav + brand:** a global sticky `<header class="site-header">` (app/layout.tsx) carrying
  the **TripSoup wordmark** as `<a href="/" data-testid="home-link">` — the way back home after
  processing (there was none) AND the product's first visible name. Wordmark is `--ink` (an
  orange "Soup" span was tried and REMOVED: `--soup` on `--paper` is 3.05:1, which FAILED the
  axe color-contrast gate — a compliant orange flourish is deferred to the Phase B landing hero).
  metadata title "Itinerary Optimiser"→"TripSoup" + description + a `viewport` export.
- **Background seam FIX (Chris's "jarring outline"):** body `#f5f4f0` → `var(--paper)` (it was a
  THIRD cream, differing from `--paper` #F6F1E7 AND the land texture); the RevealMap canvas lost
  its `borderRadius`+`boxShadow` frame and gained a **22px edge-feather mask** (two intersected
  linear-gradients, `-webkit-` fallback) so the painted map DISSOLVES into the paper on all four
  edges — no rectangle, no outline. Placeholder + clouds-overlay radius removed too.
- **Responsive:** RevealMap `computeView` now takes `narrow` (matchMedia `max-width:700px`) →
  `TARGET_ASPECT = narrow ? 1.1 : 0.72`, so phones get a TALL portrait map instead of a wide-short
  strip; desktop keeps the board-wide crop. Fluid `clamp()` on global h1/h2 + `main` padding, the
  reveal heading (1.6rem→clamp) + reveal main padding; a `max-width:640px` reveal block (tighter
  gap/padding/heading). Subtitle "Sidebar's on the right." → "Reorder any stop and Gracie re-times
  the day." (old copy was wrong on mobile, where the sidebar is BELOW the map).
- **Deferred doc task folded in:** routeGeometry.ts LIVE-SHAPE NOTE + LIVE-CHECKLIST §8 marked
  **CONFIRMED LIVE 2026-07-08** (AWS geo-routes v2 `Routes[0].Legs[].Geometry.LineString`).

**Deviations:** none from LOCKED. The orange-wordmark→ink change logged above (axe gate).

**Verified (fresh, orchestrator-run this session):** tsc clean · jest 119/119 (19 suites) ·
`next build` clean · Playwright 26/26 (incl. the reveal + debug-design axe scans, 0 violations
after the wordmark fix). Visual: real-tile screenshots at 390 + 1440 — seam gone (map feathers
into paper), TripSoup home link present, mobile map is a tall board, copy fixed.

**Investigated + RESOLVED a screenshot-harness red herring (systematic-debugging):** desktop
reveal appeared "stuck sketching." Isolated by `git stash` (HEAD builds the scene ONCE, 16 tiles;
my change built it 3× / 48 tiles and reverted to sketching). Root cause: Playwright `fullPage:true`
momentarily perturbs the viewport <700px → my matchMedia listener flips `narrow` → thrashes the
scene rebuild. With a NON-fullPage capture, `narrow` stays false and phase stays `ready` for 8s
straight — so it is a TEST-HARNESS artifact, not a product bug (prod has no StrictMode
double-invoke and no spurious sub-700px viewport flip). **Accepted tradeoff:** a genuine mobile
load flips `narrow` false→true once → one extra OpenFreeMap fetch (FREE CDN, not billed) → the
correct taller crop; no oscillation. Debug logs removed after diagnosis.

**Independent fresh-context review (opus, cold diff):** the first attempt was killed by the
account session limit; re-run after the 06:10 SGT reset. **VERDICT: 0 blocking — "Phase A is
complete and correct" survived scrutiny.** Minors/observations only: the mask `#000` is an alpha
STENCIL (not a §3 color-hex violation; no lint config exists anyway); no duplicate banner
(greeting's own `<header>` is inside `<main>` → not a banner landmark); no React hydration
mismatch (SSR + first client render both `narrow=false`, flip is post-mount); the 22px feather
sits far inside computeView's 18%/22% crop padding so it never clips pins/washi; OpenFreeMap tiles
are an unbilled free CDN so the one-time mobile refetch costs nothing. Deferrable non-blockers
noted: a brief hard-edged `--paper-shade` "Sketching…" placeholder before the map dissolves in;
`debug/trip` still shows the old "Itinerary Optimiser" h1 (debug-only, out of scope). **Phase A CLOSED.**

**UNVERIFIED (device):** the responsive layout + feathered seam on Chris's real phone + desktop
browser (local proves the mechanics; Chris's device eyeball is acceptance) — screenshots sent.

## Phase B — the two off-brand surfaces

### Phase B.1 — share page rebuilt into the journal world (COMPLETE)

`/share/[id]` was the legacy P5 `PlanView` in generic white `.card`s with NO map — the artifact
users send friends looked like a different, half-finished app. Rebuilt (sonnet subagent; diff
line-verified by the orchestrator + gates re-run fresh + screenshot) into the SAME journal world
as `/trip/[id]`:
- **New `src/ui/reveal/ShareTimeline.tsx`** — a read-only journal timeline (server component, no
  client/hooks). Mirrors JournalSidebar's VISUAL (torn `.reveal-sidebar` page, rows, booked washi
  tag + AnchorGlyph, leg lines with BOTH times) with every mutation surface stripped: no drag, no
  leg toggle, no re-optimize, no pocket, no share button. Reuses reveal.css + WashiTag; tokens only.
- **`app/share/[id]/page.tsx`** rewritten: same board shape as the reveal (`maxWidth:"none"` +
  1360 inner, `var(--paper)`, journal-voice "Your itinerary / A shared plan from TripSoup." header,
  per-day `.reveal-layout` = `<RevealMap>` + `<ShareTimeline>`, per-day resilience try/catch). The
  shared map gets the full engine (feathered seam, road pen where a key exists).
- **`JournalSidebar.tsx`**: one-word change — `export function AnchorGlyph` (reused, not duplicated).
- Duplicated (documented, to keep the LOCKED sidebar untouched): `validManualOrder`,
  `tornEdgeClipPath`/`TORN_WOBBLE`, the tone/rotate cycles, `fmtDayDate`.

**e2e/share.spec.ts unchanged** — the timeline preserves PlanView's `entry-name`/`entry-time`
(`startMin–departMin`)/`leg-mode`/`entry-${id}` testids byte-identically. The subagent proactively
ran `fullflow.spec.ts` (not on its list), caught its own first-draft missing `entry-${id}` container
testid, and fixed it before reporting.

**Verified (orchestrator-corroborated, fresh):** tsc clean · jest 119/119 · `next build` clean ·
Playwright **26/26** (full suite) · share-page screenshot at desktop + mobile — the map + read-only
journal timeline, the board's language, replacing the white card. **B.1 done.**

### Phase B.2 — landing redesigned as a post-it on a notebook-desk (COMPLETE; Chris-approved)

The sparse centred-column landing → a full-bleed **notebook-on-a-desk** scene (Higgsfield bg,
`public/landing/desk.webp`, 153KB) with the paste field as a **post-it note** held by washi tape,
sitting inside the notebook spread. Chris drove the composition live:
- Full-bleed desk (killed the globals `main{max-width:880}` cap — no side margins).
- Post-it sized to sit INSIDE the notebook (Chris's red-outlined space): `min(500px, 34vw)` desktop /
  `88vw` mobile, centred — the bg is `background-position:center`, so the notebook centre = viewport
  centre and a centred note lands in the outline.
- Everything on the note: greeting (small), the LOCKED §8 label, textarea (transparent, note-blended,
  --action focus ring), the "how it works" tip bottom-left beside the CTA.
- **"Cook my trip" → "Let's cook!"**; Gracie removed from the landing; bg-2 chosen over bg-1.
- Higgsfield candidates were compared via a temporary `?bg=1|2` toggle, now REMOVED (bg hardcoded in
  greeting.css → `/landing/desk.webp`; page back to Static). Flow/testids unchanged
  (greeting-paste/submit/card/how/time preserved; greeting-gracie no longer on the idle landing —
  no e2e referenced it).

**Verified:** tsc clean · jest 119/119 · `next build` clean (`/` Static, 105KB First Load) ·
Playwright 26/26 · desktop + mobile screenshots (Chris approved). **B.2 done.**

**⚠ DEFERRED (Chris, revisit after MVP):** Chris is NOT satisfied with the MOBILE landing — "good
enough for now." Revisit the mobile composition post-MVP (the post-it/desk framing on phones).

## Phase C — map pins (push-pin tacks) + sidebar trim (COMPLETE; review pending)

Chris's audit items: the numbered stop pins were near-invisible fine ink rings, and the reveal/share
sidebar stretched to the tall map's height leaving a sea of empty ruled lines.

**Built (3 files: map-render-core.js, map-style-defaults.mjs, reveal.css):**
- **Pin styles:** new `config.PIN.style` ('ring' | 'tack' | 'washi') + a per-stop `palette`
  (design.md §3 washi tones, colour-coded) + `tackDiameter` (34 vs the 21px ring). `drawTackPin`
  (colour-coded head + ink outline + domed sheen + ground shadow + short "stab" point + number on
  the head) and `drawWashiPin` (small torn washi scrap + circled number) implemented — both scale
  by the `pop` scalar (M2 pop-in choreography preserved) and are seeded (byte-identical repaints).
  Pin loop branches on style; the displaced-pin ink leader draws for all styles; the 'ring' path is
  byte-identical to before. **Chris picked TACK** from a real-map mock (tack vs washi vs the old
  ring) → `style: "tack"` locked. The `?pin=` mock override was added to RevealMap for the
  comparison then removed (RevealMap nets to zero this phase).
- **Sidebar trim:** `.reveal-layout { align-items: stretch → start }` — the torn journal page is now
  a content-height note card beside the map (reveal AND share) instead of stretching to the map's
  height with empty ruled lines below the Share button.

**Collision geometry made marker-aware (fix applied post-review):** the tacks render at
`tackDiameter` (34) but the declutter (`resolvePinPositions`), label-avoidance, and washi-"Booked"-tag
placement assumed the 21px ring — so clustered stops' tacks would overlap ~9px (clustered city stops
are TripSoup's common case). Added `D.markerDiam` (= tackDiameter for tack/washi, else pinDiam) in
`deriveSizes` and routed the 7 collision/declutter/label/washi-placement sites through it; the ring's
own draw stays on `pinDiam` so 'ring' is byte-unchanged. Low-risk (only increases clearances).

**Independent fresh-context review (opus): 0 blocking.** Renderers solid (balanced ctx state, honour
`pop`, deterministic seeds, no seed collision, palette matches design.md §3 tones at ≥6.19:1 ink
contrast); ring path byte-identical; `align-items:start` confirmed vertical-only (doesn't touch the
board-shrink guard). Two minors: (a) the declutter/washi size mismatch — **FIXED above (markerDiam)**;
(b) a content-height sidebar means a very long trip page-scrolls instead of scrolling inside the
sidebar — **accepted** (arguably better than a nested scroll; the empty-expanse fix is the point).
**Verified:** tsc clean · jest 119/119 · `next build` clean · Playwright 26/26 · reveal + share
screenshots (tacks visible + colour-coded; sidebar content-height, no empty expanse).

**Remaining in the UI/UX polish:** Phase D (route-draw motion: slow/smooth draw-on, no fuzzy-then-snap).

## HOTFIX (2026-07-10) — two live prod bugs, reported via real-device screenshots

Chris hit two failures on trip-soup.vercel.app on his phone (real mobile 4G). Diagnosed live +
sanity-checked with a quick Fable-5 advisor pass (per Chris's explicit ask) before implementing.

### Bug 1 — map texture image-load failure ("image failed to load: land.png")

**Root cause:** the 4 map watercolor textures (`public/map/assets/tex/*.png`) were 5.7–8.1MB each
(~28MB total), uncompressed since the original M0 engine build, fetched via `MapRenderCore.
loadImage()` — a bare `new Image()` with **no timeout, no retry** — inside a `Promise.all` (one
failed texture kills the whole map). Desktop broadband never showed the failure; a real mobile 4G
connection downloading 5.7–8MB with zero resilience is exactly the failure mode. Confirmed
pre-existing on `main` (not introduced by this session's A/B/C work).

**Fixed:**
- **Textures converted PNG→WebP** (quality 85): 27.3MB → 2.58MB, **~10.5x smaller**. Visually
  verified at zoom — no tile-seam artifacts (these are `ctx.createPattern(img,'repeat')` tiled
  textures, a real risk at aggressive compression; q85 was clean). Old PNGs deleted from
  `public/`; `RevealMap.tsx`'s one reference updated `.png`→`.webp`. The bench-tool copies at
  `design/map-engine/tex-*.png` are a SEPARATE set of files (confirmed by grep) — intentionally
  untouched, out of scope (dev-only, never deployed).
- **`loadImage()` resilience** (`map-render-core.js`): a 12s per-attempt timeout + 2 retries
  (500ms/1500ms backoff), fresh `Image()` element per attempt (avoids a wedged-element risk on
  retry). A single dropped packet no longer kills the whole reveal.
- **`next.config.mjs`** (new — none existed before): `Cache-Control: public, max-age=31536000,
  immutable` on `/map/assets/tex/*` (Vercel's default for `public/` is `max-age=0,
  must-revalidate` — the browser was re-validating every visit). Noted tradeoff: any future
  texture re-export must ship under a new filename, not overwrite in place, or cached clients
  keep the stale asset for up to a year.

### Bug 2 — LLM parse truncation on a large real itinerary

**Root cause:** `src/lib/parse/llmAdapter.ts` called `claude-haiku-4-5` non-streaming with
`max_tokens: 4096` — far too low for a large itinerary's JSON output. The response truncated
mid-document ("Expected double-quoted property name... position 9023, line 322"). Because
temperature=0 and the retry loop resends the SAME input, all 3 attempts truncated at the same
point — the retry loop could never succeed, it just burned 3 attempts to fail identically.

**Fixed:**
- Switched `client.messages.create` → `client.messages.stream(...)` + `await stream.
  finalMessage()` (avoids the SDK's non-streaming HTTP-timeout ceiling at high `max_tokens`).
- Raised `max_tokens` **4096 → 32000** (Haiku 4.5's real ceiling is 64K; 32K leaves headroom).
- **Fail-fast on truncation:** `message.stop_reason === "max_tokens"` now throws a clear,
  actionable error immediately ("try splitting it into two pastes") instead of retrying a
  guaranteed-identical failure 3 times.
- Added a system-prompt rule: minified JSON output (no whitespace) — stretches the token budget
  further for genuinely large pastes, on top of the raised cap.

**Verified:** tsc clean · jest 119/119 · `next build` clean (validates next.config.mjs) ·
Playwright 26/26 (incl. real reveal renders on the new webp textures + the retry-wrapped
loadImage's happy path). **UNVERIFIED (by design — llmAdapter.ts is guarded from tests, same
philosophy as realAdapter.ts):** the streaming/truncation-fix path itself has no automated
coverage; the retry/timeout path on an actual network failure is also untested (e2e only exercises
the happy path). Both are code-review-verified, not live-tested. **CHRIS-STEP:** re-paste the
itinerary that triggered Bug 2 on prod after deploy to confirm; reload the reveal on a real mobile
connection to confirm Bug 1.

**Independent fresh-context review (opus): SHIP, 0 blocking.** One MINOR fixed before commit: the
timeout path detached handlers but never aborted the stalled `img` download (`img.src=''` added),
so a retry no longer competes with the still-running failed attempt for bandwidth. Everything else
confirmed clean: race-free settle/timer handling, WebP swap has exactly one code reference (grepped
whole repo), bench-tool `design/map-engine/tex-*.png` copies confirmed byte-identical-source but
path-distinct (correctly untouched), `next.config.mjs` headers() shape correct for Next 15,
streaming `finalMessage()` returns the same `Message` shape `extractText()` expects, the fail-fast
throw correctly bypasses the retry loop (verified: outside the try/catch), minified-JSON prompt
rule doesn't interact with the fence-stripping regex, solver/schedule/planService/resolvePlaces/
matrixSource/map-style-defaults.mjs all zero-diff. Committed `d3a96a9`.

### Texture quality follow-up: q85 → q50 (2026-07-10, same session)

Chris asked whether WebP had more headroom. Tested the full curve on the same source art
(`design/map-engine/tex-*.png`, confirmed byte-identical to the deleted production PNGs):

| Quality | Total | vs q85 |
|---|---|---|
| q50 | 884 KB | **3.0x smaller** |
| q60 | 1,081 KB | 2.4x smaller |
| q70–q80 | 1.3–1.9 MB | 1.3–2.0x smaller |
| q85 (first-shipped) | 2,622 KB | — |

Visually verified at zoom (tiled-pattern seam risk + general artifacting) at **both q60 and q50**
— clean at every level tested, no visible tile seams or blocking even at the most aggressive q50.
Rationale: the textures are soft, low-frequency painterly washes with no fine detail baked in (the
coastlines/roads/labels are separate Rough.js vector strokes drawn ON TOP), so they compress
unusually well. Orchestrator recommended q60 (margin above the tested edge); **Chris chose q50**
(884KB total — **31x smaller than the original uncompressed PNGs**, 3x smaller than first-shipped
q85). Gates re-verified fresh at q50: tsc clean · jest 119/119 · Playwright 26/26.

## Phase D — reveal route-draw motion (2026-07-11)

Chris, from live prod on his phone: "the route line is still way way too fast", "after moving the
positions of items on the list, the route is now stuck in the fuzzy mode and not following the roads
neatly", and (Phase D's original framing) "no fuzzy-then-snap". Two bugs + the timing. All in
`src/ui/reveal/RevealMap.tsx` (the choreography). Advisor note: **Fable was rate-limited** mid-task
(session limit, resets ~6:50am SGT) — but it delivered the load-bearing finding first, then Opus
took over (Opus fresh-context review in place of Fable).

**Bug — "stuck fuzzy after reorder" (the real regression).** Root cause, Fable-confirmed: `motion`
v12's `controls.finished` is **resolve-ONLY — it never rejects, even on `.stop()`**. So the old
`try { await controls.finished } catch { return }` guard in runChoreo was a **no-op**. On reorder,
the resketch sketch animation and the geometry effect both fire; when roads arrive the geometry
effect stops the sketch animation and paints roads — but the stopped sketch animation's trailing
`await` still resolves and runs its final `paintFrame(SKETCH,…)`, **clobbering the roads**. Only
bit after a reorder (first load has no prior competing choreography), exactly as reported.
**Fix:** a monotonic `choreoGen` ref — bumped whenever a new draw supersedes an in-flight one;
every finalize paint checks `if (choreoGen.current !== myGen) return` before committing, so a
superseded draw's trailing paint is a guaranteed no-op regardless of motion's stop()/finished
semantics.

**Bug — "way too fast" + "fuzzy-then-snap".** Draw slowed (DUR 2.1→4.0 initial, 0.9→2.2 resketch;
route now draws over ~2.9s, not ~1.5s). The initial reveal now **waits ~900ms (clouds parting) then
re-reads geometry and draws the ROAD line on from the start** — no fast fuzzy sketch that then
hard-snaps to roads. Road geometry (~300-500ms) reliably lands inside the cloud pause, so the pen
draws roads directly. New `initialCommittedRef` coordinates this: while the initial draw hasn't
committed (still in the pause), the geometry effect defers (`if (!initialCommittedRef.current)
return`) so it doesn't double-draw / stomp the pin-pops; once committed (or on any reorder) the
geometry effect animates a smooth 1.5s road **draw-on** instead of the old instant hard-snap. Both
refs reset on a fresh scene build.

**Verified:** tsc clean · jest 119/119 · Playwright 26/26 (existing reveal suite — note it runs
under reduced-motion, so it exercises the new reducedMotion early-return but NOT the animation
race). Added a temp real-motion visual check (mock roads = L-shaped dog-legs, distinct from the
near-straight sketch; deleted after): **confirmed** the initial draws the road dog-legs slowly from
the start (partial road line mid-draw, square corners) and an in-session re-optimize reorder lands
on the road dog-legs, NOT the fuzzy sketch.

**Opus fresh-context review: found a BLOCKING bug + a MINOR — both FIXED before commit:**
- **Finding 1 [BLOCKING]:** if the initial reveal was superseded DURING its 900ms pause (async
  bookedId, or a fast reorder), it aborted at the gen-guard BEFORE setting `initialCommittedRef`,
  which then stayed false forever → the geometry effect's `if (!initialCommittedRef.current)
  return` wedged permanently → roads never render → the SAME stuck-fuzzy symptom, made permanent.
  Fixed by flipping `initialCommittedRef=true` BEFORE the supersede guard (ownership passes to the
  geometry effect via the superseding resketch). **Verified** with a temp real-motion test that
  clicks re-optimize inside the pause window → roads still render (dog-legs, not fuzzy).
- **Finding 2 [MINOR]:** a slow `buildScene` (>900ms, large trips / cold cache) on the initial
  load made the geometry effect interrupt the in-flight pen draw → restart + lost pin-pops on the
  money shot. Fixed with a `roadsRenderedSig` ref: the choreo records the order sig whose road
  line it's drawing; the geometry effect swaps `sceneRef` (the running draw adopts the road-aware
  scene on its next frame, since `paintFrame` reads `sceneRef` fresh) and returns WITHOUT
  re-animating when that sig matches — no interrupt, no lost pops.
- Review also confirmed clean: the removed try/catch is safe (motion v12 `finished` is verified
  resolve-only from source), rapid-reorder chains settle to "done" (latest wins), no stuck-running,
  `reducedMotion` stale-closure doesn't bite (no reduced-motion change listener exists — pre-existing,
  not introduced here), unmount setState benign. Residual (flagged, ultra-rare): `buildScene` > the
  full 4.0s initial draw would leave labels non-road-aware until the next interaction — cosmetic only.
Re-verified after the fixes: tsc clean · jest 119/119 · Playwright 26/26.
**CHRIS-VERIFY (device):** the exact feel/speed of the slow draw + the reorder transition on a real
phone. **Known tunable, flagged:** on a REORDER the resketch still shows a brief (~400ms) sketch
flash before the roads draw-on kicks in (the resketch draws immediately, no pause; only the INITIAL
reveal waits for roads). Can be smoothed with a short pre-fetch pause on resketch too if Chris finds
it distracting — deferred (ideally revisit with Fable for the timing feel).

## NEXT-NEXT — "split" = interleaved parallel groups (Chris, 2026-07-11) — DESIGN FIRST

Chris clarified the "missing split function": **parallel groups A & B, interleaved with together-
time** — the party is together for some activities, splits into A/B for separate activities, and can
**reconverge** (e.g. back together for dinner). NOT a whole-day split — a braided per-day timeline
(shared segment → {A branch, B branch} → shared segment → …). Currently unbuilt end-to-end: the
heuristic parser already emits `splitGroups` from "Group A"/"Team X" lines, but assembleTripDoc
drops them and the reveal only has day tabs. This is a substantial feature (data model: group
segments within a day; solver: plan each branch independently, shared segments once, anchors as
convergence points; map: forked/coloured routes that diverge + merge; sidebar: A/B lanes).
**MUST brainstorm → spec → plan before building** (per superpowers:brainstorming + Chris's design-
before-build protocol). This is the next focus after the Phase D fixes land.

Test prompt delivered to Chris (works with the LIVE heuristic parser — Maps links required since
name-only items don't resolve to places yet): a 2-day Singapore itinerary, `?q=` Maps links, spread
stops + anchored times, built to exercise the slow draw + roads-after-reorder + day tabs.

## NEXT — LLM interprets the WHOLE pasted itinerary (Chris feature request, 2026-07-08)

The user should paste a whole itinerary — **with OR without links** — and have the LLM interpret the
FULL thing into a structured itinerary. Requirements (Chris, from user feedback):
- Interpret user INTENT: some stops are ordered a particular way for a reason (respect intended order).
- Discern which items belong to which DATE and separate them; **never shuffle items across dates**.
- If shifting an item BETWEEN dates would significantly smoothen the itinerary, **propose it to the
  user for their final say** (never auto-apply cross-date moves).
- **⚠ Touches the LOCKED §3 rule "only extracted URLs reach Places; label text NEVER a query."**
  Text-only pastes (place names, no links) need names resolved to places → this relaxes that
  cost-safety rule (it existed to stop unbounded billed Places calls on arbitrary text). MUST be
  designed with a spend cap / confidence gate. Flag to Chris; DESIGN before building.
- Status: design SPEC written + Fable-audited (docs/superpowers/specs/2026-07-09-itinerary-
  interpretation-design.md), pending Chris's review → implementation plan. Phase C (map pins +
  sidebar) is DONE (above); only Phase D (route motion) remains in the UI/UX polish. Sequence
  (interpretation feature vs Phase D) to be reconfirmed with Chris.

## P0 — pen speed halved (slower) + resketch pen-lift (2026-07-11, Fable session)

Chris (remote): "the slow route draw speed needs to be halved, sketch flash needs to be smoothed."
Direction confirmed via AskUserQuestion: HALVE THE SPEED = slower, ~8s draw (not faster). Changes,
all in `src/ui/reveal/RevealMap.tsx`:
- DUR 4.0→**8.0** (initial; route completes ~5.8s at routeP t=0.72), 2.2→**4.4** (resketch);
  geometry-effect road draw-on 1.5→**3.0** to match.
- **NEW resketch "pen-lift":** before drawing, a resketch polls (60ms steps, ≤700ms, gen-guarded
  every step) for `geomRef.current?.sig === orderSig`, so a reorder draws the ROAD line from the
  first stroke instead of ~400ms fuzzy-sketch-then-snap. Scribble sfx plays over the lift (reads
  as the pen being picked up). Fail-open no-key path returns 200 with null legs → geomRef IS set →
  lift exits promptly (no 700ms tax in local dev / no-road routes); only a genuine fetch failure
  pays the bounded 700ms.
- Opus fresh-context review: **COMMIT-READY, 2 MINOR.** (1) unmount/rebuild during the lift
  orphaned an un-cancellable post-unmount animation → FIXED: scene-build effect cleanup bumps
  `choreoGen` (every awaited continuation checks it). (2) booked-only change when roads genuinely
  failed pays the 700ms erased-route pause → accepted (bounded, rare). Review checked clean:
  supersede-during-lift always ends with the latest reorder painting; both orderings of the
  resketch↔geometry-effect race yield exactly one animation; pin-pop/settle windows are
  t-normalized (DUR-independent — no repeat of the frozen-pin bug).
- Gates: tsc clean · jest 119/119 · Playwright 26/26.
- **CHRIS-VERIFY (device):** the ~8s pace feel + reorder smoothness.

## Docket decisions (2026-07-11, Chris via AskUserQuestion)

- **New D3 brief SUPERSEDES master-plan D3** — saved verbatim + amendments at
  `docs/briefs/d3-payments-auth-brief.md`. Share stays FREE; monetization = freemium
  capacity/features (free: 8 stops + watermark; pass: 40 stops + text input + export);
  bundles SGD 15.90/3, 24.90/5 with a credit balance; trips stay in KV; sign-in only at
  purchase. Old pay-to-share/claim-token/share-slug design retired (D4 will need its own
  channel-key design later).
- **Auth = email OTP**, not the brief's magic link (locked mobile rationale stands).
- **Sequence: B1 interpretation FIRST, then D3**, so the interpretNames gate is real at launch.
  Then B2 split / D4 live / D5 multi-day (order TBC with Chris at D3 close).

## PLAN-V1.md authored + audited (2026-07-12, Fable session — idea-forge framework)

Chris: "full speed ahead" — full path to public v1, payments built-in but non-live until paid
features verified. Decisions (AskUserQuestion): **free tier enforced from M3 deploy** (tester
allowlist gets purchase access — no take-away at flip); **D4 = v1.1** (planned as M8, not in the
v1 gate); B1c = research first (report: `docs/research/social-extraction-2026-07.md` — captions
FREE on all 3 platforms right now: TikTok oEmbed, IG tokenless oEmbed restored Jun-2026, YT Data
API; scrapers ~$1-2/1k for comments/MP4; frames via soupai VPS worker, never Vercel); sequence
locked M1 B1a→M2 B1b→M3 D3-soft→M4 B1c→M5 B2→M6 D5→M7 flip.

**PLAN-V1.md** (repo root) = the binding plan: goal/non-goals, orchestration protocol (Opus
orchestrates, Fable advisor+auditor, sonnet/haiku routing with effort tags), LOCKED facts incl.
PAYWALL_MODE off|soft|live (fail-closed soft), annotated file tree, M0–M8 task DAGs with <2min
acceptance checks, 27 edge cases mapped to tasks, risk register, safety invariants, quality bar.
Supersedes the master plan from here; old plan's D0–D2 history + design law remain ground truth.

**Fresh-context Opus audit: APPROVE-WITH-FIXES → all 9 findings fixed:** BLOCKING entitlements
shape reconciled (M1.1 now locks `{tier, has(cap), maxStops, watermark}` + runPipeline signature;
M3.5 swaps source not shape); MAJOR bogus "M2∥M3" parallel claim struck (RevealClient.tsx
collision); minors: PAYWALL_MODE off=explicit-only + unset→soft fail-closed clarified, gift
`redemption_codes` stub added to M3.1 DDL, file tree completed (9 e2e specs, backend-design,
scripts/), M5.3 planService/schedule lock-scope note (never Chris-engine-locked; §2 behavior
contract intact), allowlist=may-purchase (entitlement only via trip_entitlements row),
grandfather rule stated (pre-soft docs display fully, new runs gate), carried-over items homed
(sfx foley→M6.2, LIVE-CHECKLIST §3/§4 + mobile-landing review→M7.2, Gracie provisional→M7.5).

NEXT SESSION: M0 preflight (Opus orchestrator). Chris GO on PLAN-V1.md pending.

## M0 — PREFLIGHT COMPLETE (2026-07-14, Opus orchestrator session)

Chris GO on PLAN-V1.md given ("execute PLAN-V1.md, start M0"). Ran on branch `m0-preflight`
(not main — merges to main are Chris-gated per protocol §5). Orchestrator = Opus; M0.1 done
directly (Opus·high); M0.2 delegated to Haiku·low, M0.3 to Sonnet·medium (parallel, disjoint
files). Orchestrator owned all verification + git; subagents did not commit.

**M0.1 — backend-design.md §0 skeleton (`design/backend-design.md`):** PAYWALL_MODE semantics
(`off|soft|live`, fail-closed to `soft` on unset/typo — only literal `"off"`/`"live"` accepted),
`TESTER_EMAILS` allowlist (soft-mode testers may PURCHASE in test mode; entitlement still ONLY via
a `trip_entitlements` row), entitlement×mode matrix skeleton, grandfather rule, soft-mode UX copy
skeleton (journal voice, placeholders for M3.8). §1+ is a table-of-contents reservation only
(zero DDL/RLS/SQL — full contract binds at M3.1 under Fable advisor + Opus·xhigh security audit).

**M0.2 — CI (`.github/workflows/ci.yml`):** single job on ubuntu/Node20 — npm ci → typecheck →
jest → next build → playwright(chromium, fixture) → secret-grep. Secret-grep fails the job if
`SUPABASE_SERVICE_ROLE|STRIPE_SECRET|ANTHROPIC_API_KEY` appear in `.next/static`. Verified locally:
probe file in `.next/static` → grep exit 1 (caught); real build → exit 0 (clean).

**M0.3 — Sentry (`@sentry/nextjs@10.65.0`):** `instrumentation.ts` (server/edge dispatch +
`onRequestError`), `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`,
`src/lib/observability/sentryScrub.ts` (+ 9 unit tests), `app/api/debug/sentry-test/route.ts`,
`next.config.mjs` wrapped with `withSentryConfig` (texture cache-header hotfix preserved verbatim).
PII scrub (`beforeSend` + `beforeSendTransaction`, shared): deletes `request.data`, redacts
`extra`/`contexts`/`tags` keys matching `/paste|itinerary|text|body|raw|input|prompt|caption/i`,
strips breadcrumb `.data`; fail-closed (drops event if scrub throws). DSN from env
(`SENTRY_DSN||NEXT_PUBLIC_SENTRY_DSN`); `enabled: Boolean(dsn)` + `sendDefaultPii:false` → safe
no-op when unset (local/CI/tests never send). Debug route gated: inert in prod (404) unless
`DEBUG_BOARD` set.

**Gates (orchestrator-run, re-derived fresh — not transcribed):** `tsc --noEmit` exit 0 · `jest`
128/128 (20 suites, incl. new sentryScrub) · `next build` exit 0 (secretless) · secret-grep clean
on real build · YAML valid. Independent fresh-context audit (Fable·high, cold context): **verdict
MERGE-READY, 0 blocking** — re-ran tsc 0 / jest 128 / build clean / **playwright 26/26 green**
(proves M0.2 "PR→green" acceptance) / secret-grep semantics correct; confirmed no LOCKED files
touched (solver/map-core/map-defaults/resolvePlaces — no diff), cache hotfix preserved.

**Deviations from plan (numbered, per protocol):**
1. **M0.3 filenames** — used `instrumentation.ts`/`instrumentation-client.ts` +
   `sentry.server.config.ts` + `sentry.edge.config.ts` instead of the plan's
   `sentry.client.config.ts`/`sentry.server.config.ts`. Reason: official `@sentry/nextjs` v10 +
   Next 15.5.20 convention (`instrumentation-client.ts` auto-loaded by Next; no manual wiring).
   Non-blocking, audited. Same PII-scrub contract regardless of filename.
2. **M0.2 hardening beyond literal spec** — added a `concurrency` group (cancel superseded runs;
   halves the pull_request+push double-run) and a `test -d .next/static` guard before the grep
   (a missing build dir now fails loud, not green). Auditor-suggested; verified YAML valid.
3. **§1 TOC add** — reserved a `soft_mode_signups` table (email capture from §0.4 soft-mode CTA)
   in the M3.1 table-of-contents. Flagged for M3.1.

**Carry-forward for M3.1 (audit notes #1–#3 — no live leak today, but M3 adds Stripe/webhook
paths):** the Sentry scrub does NOT cover `event.message` / `event.exception.values[].value` /
breadcrumb `.message`. Grep confirmed no current `throw` interpolates raw paste text, and the
pipeline route catches its own errors before Sentry — so no live leak path exists today. M3.1 §4
(failure-mode table) MUST add a value-side sweep OR a codified "never interpolate user text into
Error messages" rule. Also: some solver/schedule error messages carry stop IDs derived from parsed
place names (itinerary-adjacent) — note in the M3 failure-mode table.

**UNVERIFIED — needs Chris / live env (do NOT claim these work):**
- **M0.2 CI green on a real PR:** push `m0-preflight` + open a PR → watch all Actions steps green.
  Then locally drop a fake `STRIPE_SECRET=...` into a client component, build, confirm the grep
  job would fail. (Logic proven locally; the GitHub-side run is unobserved.)
- **M0.3 Sentry live capture:** set `NEXT_PUBLIC_SENTRY_DSN`/`SENTRY_DSN`, deploy (or run with
  DSN), arm `DEBUG_BOARD=1`, hit `/api/debug/sentry-test`, confirm the event appears in Sentry
  with `request.data` absent and any sensitive-named key shown as `[redacted]`.

**CHRIS-STEP checklist issued (M0.1 deliverable):** delivered in chat this session — Supabase
project slot (verify Critter Collect pause freed one), Stripe SG test products/prices + account
standing, Vercel env list (incl. `PAYWALL_MODE`, `TESTER_EMAILS`, Sentry DSN), Sentry project.

NEXT SESSION: Chris does the CHRIS-STEP account setup + the two live verifications above; on his
GO, merge `m0-preflight` → main (auto-deploys), then M1 (B1a whole-paste interpretation).

### M0.3 UPDATE — live send-test found (and fixed) a real PII leak (2026-07-20)

Chris provided the Sentry DSN. Before closing M0.3 I ran a real send-test against the DSN (not just
unit tests) — done-means-verified "confirm arrival, not just send". It caught pasted-itinerary text
LEAVING the process via a vector the original scrub missed, so the earlier entry's "no live leak
today" was WRONG: Sentry's default `LocalVariables` integration attaches each stack frame's local
variable VALUES (the pasted `text` if in scope at throw time — an automatic leak, no dev mistake
needed), and `ContextLines` attaches source lines. `beforeSend` only covered
request.data/extra/contexts/tags/breadcrumbs.

**Fix (commit 9eb07e7):** `scrubSentryEvent` now also deletes `vars`/`context_line`/`pre_context`/
`post_context` from every exception AND thread stacktrace frame (frame filename/lineno/function
still ship). Re-verified END-TO-END through Sentry's real beforeSend+transport: paste placed in
`extra`, in source context, and in frame `vars` (the local-variable vector) — outbound events
contain NONE of it. +2 unit tests (scrub suite 9→11; full suite 128→130 green). tsc 0.

This resolves audit note #1 for the automatic vectors. STILL open for M3.1 §4: `exception.value`
(error MESSAGE text) is not scrubbed — only leaks if code interpolates user text into an Error, so
the standing rule "never interpolate pasted text into Error messages" + an M3 value-side sweep
remain required as Stripe/webhook paths are added.

**Sentry DSN wired** into `.env.local` (`NEXT_PUBLIC_SENTRY_DSN`, gitignored). Remaining human check:
Chris confirms the test event actually appears in his Sentry dashboard (`/api/debug/sentry-test` with
`DEBUG_BOARD=1`) — the transport was exercised locally; dashboard arrival is his to eyeball.

### M0 CI — canvas e2e non-blocking (first CI run went red; root-caused) (2026-07-20)

First-ever CI run on PR #1 came back RED. Investigated per systematic-debugging (no fixes before
root cause).

**Symptom:** the `checks` gates (tsc, jest 130, `next build`, secret-grep) ALL passed. Only the
Playwright step failed — and only the ~11 heavy tests that PAINT the animated journal map
(`fullflow`, `reveal.spec` ×4, `sidebar` ×7). The map hit `data-phase="error"` / `data-paints="0"`
within ~2s and never painted.

**Root cause (category, evidence-backed):** a headless-Linux-CI rendering artifact in the map
render, NOT a code bug and NOT caused by M0:
- Passes locally — re-ran `reveal.spec` cold: 4/4 green (auditor got 26/26). Fails only on GitHub's
  headless-Linux runner.
- NOT tiles: e2e mock `**/tiles.openfreemap.org/**` (stub TileJSON + 404 tiles, handled gracefully),
  identical local vs CI.
- NOT Sentry: the client SDK is DISABLED in CI (no `NEXT_PUBLIC_SENTRY_DSN` baked at build), and the
  throwing path is in LOCKED, unchanged `map-render-core.js`.
- NOT a user bug: the map renders in each visitor's OWN browser, never on a headless Linux box —
  prod (Vercel) is unaffected. Strong suspect for the throw: `await document.fonts.load(...)` at
  `src/lib/map/map-render-core.js:1251-1253` (font/GPU stack differs in headless Chromium).
- Could not reproduce locally to capture the exact throw (no Docker/WSL on this Win11 machine).

**Decision (Chris, AskUserQuestion → "Option A"):** split CI into two jobs —
- `checks` (BLOCKING): tsc · jest · build · secret-grep. These are the deterministic regression gate.
- `e2e` (NON-BLOCKING, `continue-on-error: true`): still runs + reports the browser suite, and on
  failure uploads the Playwright report/traces as an artifact so the exact headless error can be
  diagnosed later — without a dedicated diagnostic push.
Rationale: the failing check doesn't affect users, the real safety checks stay enforced, and the
non-blocking job still captures B's diagnostics for free.

**FOLLOW-UP (tracked, not done):** make the map e2e hermetic in headless CI — pull the exact error
from the uploaded trace, then fix in the TEST harness / a non-locked wrapper (map core stays LOCKED;
unlock needs Chris's written OK). Until then the map render is CI-validated only via local runs.
When Chris configures branch protection, require the `checks` job (not `e2e`).
