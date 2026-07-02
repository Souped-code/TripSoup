# ITINERARY OPTIMIZER — Handover Document

Web app that turns a pile of Google Maps links into an optimized multi-day group itinerary. Next.js + TypeScript on Vercel. This is an **early mid-build project**: the only shipped code is a verified de-risking spike — `resolvePlaces.ts` (messy Maps links and plain names → canonical `place_id` Stops, 10/10 across live runs, documented in `PROGRESS.md`). No API route, UI, optimizer, or persistence exists yet. This document governs everything from here. It is the single source of truth for Claude Code; decisions marked **LOCKED** are settled — do not revisit them without asking Chris. Because existing code predates this document, the run begins with an audit phase (PA) that reconciles spec against reality before any new code is written.

---

## 1. Product

Users collect stops as Google Maps links. The app resolves them to places, builds a travel time matrix, and optimizes the visit order within each day — respecting fixed bookings. Output is a shareable day-by-day plan with times and travel legs, good enough to run a 10-person group trip from.

Core mental model — **LOCKED**:

- **Stop**: a resolved place with an estimated visit duration.
- **Anchor**: a stop with a fixed start time (a booking — restaurant reservation, show, checked-in activity). Anchors are immovable, and they are computational gifts: each one chops the day into smaller independent problems.
- **Segment**: a maximal run of flexible stops between consecutive anchors (or between an anchor and the day's start/end). The solver only ever optimizes one segment at a time.

Non-goals for v1: multi-city routing between days, hotel/flight booking, collaborative live editing, user accounts, transit mode (v1 is driving with automatic walk legs for short hops), weather, budgeting.

## 2. Solver — **LOCKED**

A pure TypeScript function, no I/O: `optimize(segment, matrix, constraints) → { order, schedule, quality }`. The matrix it consumes is the **effective matrix**, built per stop pair: a pair is *walk-eligible* when the local walking estimate (§3) ≤ `walkMax` (default 10 min — a user-facing comfort setting, shipped in v1). For eligible pairs the mode is whichever is faster of walk time versus drive time + `driveOverheadMin` (default 10, settings — the hail/load/park cost that raw API times omit and that makes short drives absurd for a 10-person group). Ineligible pairs always drive at raw drive time. **Decide-then-offer**: the solver's choice sets the ordering, but eligible legs retain BOTH times (`{ mode, walkMin, driveMin, chosenBy: 'auto' | 'user' }`) so the UI can show them side by side with a per-leg toggle; a user toggle re-times the schedule downstream without re-ordering, and persists. Schedule math always uses the effective time of the active mode (walk = walk estimate; drive = drive + overhead).

- **Objective**: minimize total travel time across the segment. Hard constraints: anchor start times on both boundaries, day window, per-stop visit durations. If no ordering satisfies the constraints, return a structured infeasibility report naming the violated constraint and by how much — never a silently truncated plan.
- **Method by segment size**: ≤ 9 flexible stops → exhaustive permutation search (9! ≈ 363k evaluations, milliseconds); 10–15 → nearest-neighbour seed plus 2-opt refinement, and the result is labelled `quality: "heuristic"` so the UI can say so; > 15 → reject with an actionable error (split the segment or add an anchor).
- **Deterministic**: ties broken lexicographically by stop id. Same inputs, same output, every run — this is what makes the solver goldens meaningful.
- **Schedule builder**: walks the chosen order producing arrive/depart times per stop, travel legs with durations, and slack per gap. Also pure.

## 3. Maps provider — the metered boundary — **LOCKED**

All Google Maps contact (place/link resolution, travel time matrix) goes through one port, `mapsProvider`, with two adapters:

- **Real adapter**: `resolvePlaces.ts` (the shipped spike — the audit maps it into this port, adapting the port to its existing shape rather than rewriting verified code; `PROGRESS.md` documents its pipeline and verification) plus the Routes/Distance Matrix API for **driving times only**. The port signature keeps a mode parameter because the API has one, but v1 requests driving exclusively.
- **Walking estimator**: local pure function, no API — haversine distance × 1.3 detour factor ÷ 80 m/min. Detour factor, walk speed, `walkMax`, and `driveOverheadMin` are settings. This decides walk eligibility at zero marginal spend; its known limit (physical barriers understate real walks) is §7's problem, not code's.
- **Fixture adapter**: a synthetic city of ~20 stops with real-looking coordinates and a coherent hand-built driving matrix (triangle inequality holds). The walk estimator runs over the fixture coordinates, so walk-leg behaviour is fully testable offline. All tests and all unattended development run against this. Fixture data lives in the repo.

**Cost control is spec, not optimization**: matrix entries are cached in persistence keyed `(fromPlaceId, toPlaceId, mode)` and never re-fetched on cache hit; matrix requests are batched; the real adapter throws if constructed without an API key rather than failing later. The test environment never constructs the real adapter — asserted in CI by grepping test bundles for the construction path is not required; a jest guard that the fixture adapter is the only one imported by tests is sufficient.

## 4. Persistence and app shell — AUDIT-RESOLVED

Per `PROGRESS.md`, no persistence or app shell exists yet, and the unattended run cannot provision Vercel services from Chris's account. Storage is therefore a port like maps: one JSON document per trip with a slug behind a `tripStore` interface — file-backed adapter for development and all tests, Vercel KV adapter written but UNVERIFIED until the live checklist (provisioning is a Chris step). The audit still documents whatever scaffolding it finds. Trip document shape: `{ tripId, days: [{ date, dayStart, dayEnd, stops: [...] }] }` with anchors marked inline on stops.

## 5. Phase plan (PA, P1–P5)

Work strictly in order. At each phase boundary update `STATE.md`: built, deviations and why, verified and how. Machine-checkable done-checks (typecheck, jest, Playwright against fixture data) must pass before the next phase. Anything requiring a live API key, real spend, or a production deploy is recorded UNVERIFIED and becomes an ordered step in `LIVE-CHECKLIST.md`, a final deliverable. Never claim a live-API item works.

| Phase | Scope | Machine done-check |
|---|---|---|
| **PA** | Audit the existing repo. Produce `AUDIT.md`: what exists, how Phase 0 maps onto the `mapsProvider` port, storage/framework reality, dead ends. Conflicts with LOCKED sections → record in `STATE.md` with recommended resolution, mark dependent work BLOCKED, continue with everything not downstream | `AUDIT.md` exists and every later phase references it where reality differed from this document |
| **P1** | `mapsProvider` port, fixture adapter + synthetic city, real matrix adapter (key-gated), matrix cache | jest: cache hit never re-fetches; batching correct; fixture matrix sane (triangle inequality spot checks); walk estimator goldens including exact-threshold boundary; tests import only the fixture adapter |
| **P2** | Solver core per §2 | jest goldens: known fixture segments produce known optimal orders; property tests: anchors never move, every stop appears exactly once, determinism across 100 runs, comparison-rule goldens (walk 5 vs drive 10 → walk; walk 8 vs drive 4 + overhead 10 → walk; walk estimate beyond walkMax → drive regardless; exact-walkMax boundary), cap behaviour at 9/10/15/16 stops; infeasibility report names the violated constraint |
| **P3** | Schedule builder + feasibility surface | jest: arrive/depart arithmetic against hand-computed goldens; slack computation; heuristic label propagates |
| **P4** | UI: trip board (days, stops, anchor lock/unlock, durations), optimize action, result view with legs labelled walk/drive — eligible legs show both times with a per-leg toggle — walkMax exposed as a settings field, infeasibility and heuristic states rendered | Playwright against fixture data: add stops → mark anchor → optimize → correct order and times on screen; toggling an eligible leg re-times downstream stops without re-ordering; infeasible case shows the report, not a broken plan |
| **P5** | Share: read-only view by slug; `LIVE-CHECKLIST.md` finalised | Playwright: share link round-trip renders the same plan read-only |

## 6. LIVE-CHECKLIST.md ordering

(1) Move `.env` back into the repo (it was removed pre-launch); resolve one pasted Maps link end-to-end (validates the Phase-0-to-port mapping against Google's live behaviour); (2) one real matrix call for ≤ 5 stops, verify the cache prevents a second fetch, note the billed request count; (3) build a real day from the actual group trip's stops, optimize, sanity-check the order against local knowledge and confirm the walk-labelled hops are genuinely walkable (no rivers or expressways in between); (4) variety-test the spike's known edge: dropped-pin / coords-only shares (`/maps/search/`, bare `@coords`) — currently they fail legibly, confirm none mis-resolve; (5) provision Vercel KV, flip tripStore config, share-link round-trip on the deployed app from a phone; (6) quota/billing alert configured in Google Cloud console before the group starts pasting links.

## 7. Known risks

- **A live key ships with the repo.** `.env` holds a working `GOOGLE_MAPS_API_KEY`; the launch protocol is Chris moving it out of the repo before the run and restoring it at live-checklist step 1. The run must never need or read key material.
- **Dropped-pin shares are untested.** The spike handles them defensively (legible failure, never a silent mis-resolve); the variety test is a live-checklist item because it needs real share links.
- **API spend at machine speed.** The port boundary, fixture-only tests, cache-as-spec, and key-gated construction exist for this. Do not weaken any of them for convenience during development.
- **Matrix realism.** The driving matrix is departure-time-agnostic, so rush hour drifts from it; walk estimates are straight-line-based, so rivers and expressways can understate a walk. Both are documented product limits with conservative defaults, not v1 engineering.
- **Existing code vs this spec.** PA exists because this document was written without repo access. Where they conflict, the document does not automatically win: LOCKED items follow the blocker protocol; everything else adapts to working code rather than rewriting it.
- **Segment blow-up.** The 9/15 thresholds are settings values; the behaviours at each are spec.

## 8. Working conventions

Don't add features, refactor, or introduce abstractions beyond what the task requires. Don't design for hypothetical futures: simplest thing that works well. No error handling for impossible scenarios; validate at boundaries only (user input, Google APIs). No feature flags or compatibility shims. Act when you have enough information; never re-litigate LOCKED decisions. Match the existing repo's style — this is a mid-build codebase, not a greenfield one; surgical changes, no drive-by refactors of Phase 0 code that works. Lead with the outcome in every report. Plan each phase, implement in one pass, verify against the done-check, update `STATE.md`. If reality contradicts this document, stop, record the conflict and recommended resolution in `STATE.md`, mark dependent work BLOCKED, continue with everything not downstream.

---

## Appendix — one-shot launch prompt

```
Read ITINERARY-HANDOVER.md and PROGRESS.md in full before doing anything
else. The handover is the authoritative spec; PROGRESS.md documents the one
piece of shipped code (the resolvePlaces spike) that PA maps into the port. Decisions marked LOCKED
are settled — do not revisit them. Its §8 working conventions govern
everything you produce.

Context: a multi-day group itinerary optimizer (Next.js/TypeScript/Vercel)
for a real 10-person trip. I'm the sole developer and I will NOT be
available during this run. The Google Maps API key has been REMOVED from this repo for the run and you
must not need it: all development and testing runs against the fixture
adapter and synthetic city per §3. If you find any .env or key material
anyway, do not read, copy, or restore it. Anything requiring a
live key, spend, or deploy goes on LIVE-CHECKLIST.md for me.

This session: execute PA then P1–P5 end to end, unattended. PA first, no
exceptions: audit the existing code, produce AUDIT.md, map Phase 0 onto the
mapsProvider port, and adapt the spec's port shape to working code rather
than rewriting it. Conflicts with LOCKED sections follow the blocker
protocol in §8. Machine-checkable done-checks must pass before each next
phase; live-API items are recorded UNVERIFIED in STATE.md and become
ordered steps in LIVE-CHECKLIST.md. Never claim a live-API item works.

You are done when, and only when: tsc --noEmit is clean; the full jest
suite passes including the P2 solver goldens and property tests; the
Playwright suite passes against fixture data including the infeasible and
heuristic states; AUDIT.md and STATE.md document every phase with evidence;
LIVE-CHECKLIST.md exists, ordered per §6. If a check fails, fix it and
re-run — do not weaken a check, delete a golden, or skip a phase to exit.

Pausing: there is no one to ask. On a genuine blocker, record it and your
recommended resolution in STATE.md, mark dependent work BLOCKED, and
continue with everything not downstream of it.

Verification: before any phase-complete claim, run a fresh-context review
subagent against §1–§4 and AUDIT.md and fix findings first. Phases are
sequential; parallel subagents are for verification and research only. The
cost posture in §3 is part of the spec: a passing suite that constructs the
real adapter in tests, weakens the cache, or removes the key gate is a
failed run.

Reporting: audit every claim in STATE.md against a tool result from this
session. Tests failed = say so with output. Skipped = say that. Live-API =
UNVERIFIED, no exceptions.

Your final message is my first look after days away: one sentence on the
state of the project, then exactly what I do first (it will be
LIVE-CHECKLIST item 1), in plain language. Before ending, check your last
paragraph: if it's a plan or a promise about undone work, do that work now.
```
