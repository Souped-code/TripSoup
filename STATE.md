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

## P2 — Solver core (NOT STARTED)

## P3 — Schedule builder (NOT STARTED)

## P4 — UI (NOT STARTED)

## P5 — Share + LIVE-CHECKLIST (NOT STARTED)
