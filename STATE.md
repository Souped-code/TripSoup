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

## D0 — Deploy current app to Vercel + KV (IN PROGRESS)
