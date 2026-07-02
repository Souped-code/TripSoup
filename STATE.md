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

## P3 — Schedule builder (NOT STARTED)

## P4 — UI (NOT STARTED)

## P5 — Share + LIVE-CHECKLIST (NOT STARTED)
