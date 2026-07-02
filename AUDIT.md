# AUDIT.md — PA: repo reality vs ITINERARY-HANDOVER.md

_Produced 2026-07-02, start of the unattended PA→P5 run. Evidence: direct file reads +
`find`/`grep`/`git` output this session._

## 1. What exists

| File | Status | Disposition |
|---|---|---|
| `resolvePlaces.ts` | **Phase 0, shipped, verified** (see PROGRESS.md: 10/10 across 3 live runs). Exports `resolvePlaces(inputs: string[]) → Promise<ResolveResult>`, `parseMapsUrl`, types `Stop`, `Failure`, `ResolveResult`. | Mapped into the `mapsProvider` port **unmodified** (§3 below). |
| `spike.ts` | Dev runner for the spike. Needs a live key + network. | Kept as a dev script. Not part of the app; not run in tests. |
| `parsecheck.ts` | Dev verification script (URL parsing, offline). | Kept. Not run in tests. |
| `redircheck.ts` | Dev verification script (redirect probing, network). | Kept. Not run in tests. |
| `.gitignore` | Ignores `.env`, `.env.*`, `node_modules/`. | Kept, extended as scaffolding requires. |
| `PROGRESS.md` | Spike handoff document. | Historical record; superseded by ITINERARY-HANDOVER.md where they differ (its "next step: app/api/resolve/route.ts" is replaced by the phase plan). |
| `ITINERARY-HANDOVER.md` | Authoritative spec. | Governs. |

## 2. What does NOT exist (framework/storage reality)

- **No Next.js app, no `package.json`, no `tsconfig.json`, no `node_modules`.** PROGRESS.md
  describes the project as "Next.js (App Router) + TypeScript" — that was the *intended* stack;
  no framework code was ever scaffolded. Everything except `resolvePlaces.ts` and the three dev
  scripts is greenfield. P1 onward scaffolds from scratch; this does not conflict with any
  LOCKED section (the stack named in the spec is the stack that will be built).
- **No persistence of any kind.** §4 (AUDIT-RESOLVED) already anticipated this: `tripStore`
  port, file-backed adapter for dev/tests, Vercel KV adapter written but UNVERIFIED.
  Confirmed correct — there is no scaffolding to document beyond the above.
- **No git repository.** `git rev-parse` fails here and in every parent. Initialised during PA
  (with an initial commit of Phase 0 as-found) so the unattended run has checkpoints and the
  Phase 0 baseline is provably untouched. `.gitignore` already existed, consistent with intent.
- **No tests, no CI, no API routes, no UI.**
- **No key material.** No `.env*` anywhere in the tree; no `AIza` string in any file
  (`grep` evidence this session). The key-removal protocol in §7 was executed before this run.

## 3. Phase 0 → `mapsProvider` port mapping

Per §3 the port is adapted **to** the spike's existing shape:

```ts
// src/lib/maps/provider.ts
interface MapsProvider {
  // exactly the spike's signature and return shape — no adaptation layer
  resolvePlaces(inputs: string[]): Promise<ResolveResult>;
  // matrix; mode parameter kept because the API has one, v1 always passes 'driving' (§3)
  getTravelMatrix(stops: MatrixStop[], mode: TravelMode): Promise<TravelMatrix>;
}
```

- **Real adapter** (`realAdapter.ts`): constructor **throws immediately if no API key** (§3
  cost control). Its `resolvePlaces` delegates to the Phase 0 module unchanged; its
  `getTravelMatrix` calls the Routes API (driving only), batched, through the cache.
  - *Spec-vs-reality note*: the spike key-gates at **call time** (`resolvePlaces` line 177).
    §3 wants gating at **construction**. Resolution: the adapter constructor gates; the spike
    module is not modified (its own check becomes a redundant second line of defence).
    Not a LOCKED conflict — §3 constrains the *adapter*, which did not exist.
  - The spike's `Stop` has no visit duration or anchor fields. Those are trip-document
    properties (§4: anchors marked inline on stops), so the app layer extends the resolved
    `Stop` rather than modifying Phase 0 types.
- **Fixture adapter** (`fixtureAdapter.ts`): synthetic city (~20 stops, real-looking
  coordinates, hand-built driving matrix satisfying the triangle inequality), fixture data in
  repo. `resolvePlaces` resolves against the synthetic city by name/id so the full app flow
  works offline. All tests and all unattended development use this adapter only.
- **Walk estimator**: NOT on the port (it makes no API contact). Pure function
  `walkMinutes(a, b, settings)` = haversine × detourFactor (1.3) ÷ walkSpeed (80 m/min),
  per §3. Settings: `detourFactor`, `walkSpeedMPerMin`, `walkMax` (10), `driveOverheadMin` (10).
- **Matrix cache**: keyed `(fromPlaceId, toPlaceId, mode)`, cache hit never re-fetches,
  requests batched. Lives with the port so both adapters share the interface; only the real
  adapter's fetches are metered, but cache tests run against a counting stub of the fetch layer.

## 4. Dead ends

None. Nothing found contradicts the spec's architecture; no abandoned code. The three dev
scripts are the only non-app files and are retained as-is.

## 5. Conflicts with LOCKED sections

**None found.** The call-time-vs-construction key gate (above) is the closest thing, and it is
resolved by the adapter wrapper without touching verified Phase 0 code or the LOCKED text.
No blockers recorded; no work marked BLOCKED at PA.

## 6. Environment facts for later phases

- Windows 11, Node v24.16.0, npm 11.16.0, npx tsx available. No global jest/playwright.
- P1 scaffolds: `package.json`, `tsconfig.json`, Next.js (App Router), jest, Playwright.
- `resolvePlaces.ts` stays at repo root, imported by the real adapter via relative path —
  the most surgical option (§8): zero changes to Phase 0 code or its consumers.
