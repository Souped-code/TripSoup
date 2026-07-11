# D2.3 — Subagent-Driven Development progress ledger

Branch: `d2.3-reveal` (off `main` @ 1909c14). **main auto-deploys to Vercel prod**; this UI
work stays on the branch and merges only at the D2.4 done-check (after fresh-context audit).
Phase: D2.3 (reveal + map). manualOrder backend already landed on main (1909c14).

Baseline gates (main @ 1909c14): tsc clean · jest 104/104 · Playwright 12/12.

## Build order (mechanical = delegate/sonnet; needs-Chris-eye = orchestrator gate)
- [T1] **Map style JSON (design.md §8) + real screenshot of JB vs `design/refs/d1.1-reveal-LOCKED-palette.png`** — orchestrator (opus). **HUMAN GATE: Chris approves the paper-map look before any reveal build.** — B(full)/C(sparse) rendered vs board; AWAITING CHRIS (density/water/road levers)
- [T2] Old board → `/debug/*` env-gated + retarget e2e specs (trip/share/multiday) — sonnet — commit 73d1c8f — COMPLETE (fresh reviewer: spec ✅ + quality Approved; gates 104/12 + gate-404 behavior live-verified)
- [T3] Greeting page `/` (paste-box hero, §8) + wire to /api/pipeline (usePipeline+LoadingView) + interim reveal handoff — sonnet — COMPLETE (commit c25f9a6, jest 109 / pw 14; scope clean, orchestrator screenshot-reviewed desktop+mobile: on-spec paper/journal, green action button, paste-hero, anti-generic law held)
- [T4] Stop-id dedup in `src/lib/pipeline/pipeline.ts` (within-day, first-occurrence-wins) + jest test — sonnet — COMPLETE (commit 5ea9719, jest 109; orchestrator reviewed diff + 5 tests: non-vacuous, precedence-survives-dedup verified against solver output) — ⚠️ SUPERSEDED by T4b
- [T4b] Allow duplicate places + FLAG them (`duplicateOf` marker + per-occurrence suffixed id, keep both, routed) — supersedes T4 — sonnet — COMPLETE (commit e630af6, jest 109 / pw 14; orchestrator-reviewed incl. the out-of-allowlist fixtureAdapter touch [safe: real adapter confirmed location-driven, cacheKey format intact, no non-suffixed-id behavior change] + 5 non-vacuous keep-both/anchor/cross-day/precedence-to-occurrence/determinism tests)
- [T5] Reveal: MapLibre integration (APPROVED style, lazy-load, route draw-on dasharray, numbered pins) + cloud transition (~1.6s, reduced-motion→crossfade) — sonnet — GATED on T1 approval
- [T6] Torn-paper sidebar: dnd-kit reorder→manualOrder (backend ready), re-optimize pencil clears, infeasible→red margin note — sonnet — GATED
- [T7] LOCKED §2 carryover in new sidebar: per-leg walk/drive toggle (both times) + walkMax/driveOverheadMin planner's-notes pocket — sonnet — GATED
- [T8] D2.4 Playwright fixture full-flow coverage — sonnet — pending
- [T9] Fresh-context whole-branch audit — opus — pending
- [T10] D2.4 done-check + STATE.md + LIVE-CHECKLIST append + merge to main — orchestrator — pending

## Completed (commits on branch)
- Task T2: complete (commit 73d1c8f, review clean — spec ✅ + quality Approved; gates 104/12 + gate-404 live-verified).
- Task T4: complete (commit 5ea9719, jest 109/12; orchestrator-reviewed diff+tests — dedup within-day first-wins + anchor-carry; 5 non-vacuous tests incl. precedence-survives-dedup enforced by solver). ⚠️ behavior superseded by T4b.
- Task T3: complete (commit c25f9a6, jest 109 / pw 14; greeting `/` + pipeline wiring + interim reveal `/trip/[id]`; scope clean, orchestrator screenshot-reviewed).
- Task T4b: complete (commit e630af6, jest 109 / pw 14; duplicates KEPT + flagged via `duplicateOf` + suffixed id; orchestrator-reviewed incl. fixtureAdapter deviation [safe — real adapter confirmed location-driven, cacheKey format intact] + 5 non-vacuous tests). BACKEND + FRONT-DOOR TRACK DONE (T2/T3/T4b).

## Orchestration notes
- **Serialize gate-running subagents.** Every implementer/reviewer runs `npx playwright test`, which
  binds `next dev` on :3111 — two at once collide. One gate-runner at a time.
- Corroboration = orchestrator reviews the diff + confirms gates per task (fresh per-task reviewer only
  when risk warrants); the MANDATORY fresh-context whole-branch audit is T9 before merge (Chris's flow).

## Decisions (Chris's calls)
- **Duplicates: ALLOW + FLAG, not dedup** (2026-07-05). Two links → same place in a day = TWO stops;
  2nd gets a deterministic suffixed id (`place#2`) + `duplicateOf` marker. Routed (in the plan). Reveal
  sidebar (T6) shows the flag inline with a remove control + a reveal heads-up. User decides
  intentional vs accidental. Accepted minor cost: a present duplicate's matrix pairs don't hit the
  global place cache (transient — gone when an accidental dupe is removed). No LOCKED cacheKey-format
  change; solver/schedule/matrix code untouched. → DONE in T4b (commit e630af6, verified); `duplicateOf` produced by pipeline, **T6 sidebar owns the flag UI** (badge + remove + reveal heads-up).
- **Map style (T1): AWAITING** — density (rec C=arterials), water (spec `#C9D6D2` vs board sage),
  roads (ink §8 vs board ochre).
- **Map (T1/T5) — APPROACH REJECTED by Chris (2026-07-05):** both the flat vector style AND the
  "artistic layer" (SVG filter + texture) read as a street-map in a paper costume, NOT the
  illustrated board. RETHINK → reveal = an ILLUSTRATED-IMAGE basemap (genuinely painted like the
  board) + accurate route/pins vector overlay; needn't be a pannable map. Three angles put to Chris:
  (A) real watercolor tiles [Stamen/Stadia] warmed to our palette — production-sound, fast, needs a
  free key; (B) AI-illustrated per trip [the board's own method] — closest look but per-trip
  gen cost/latency/reliability; (C) custom hand-drawn renderer [Rough.js over simplified real
  geometry + AI-made watercolor textures] — full control, build-heavy.
  → **RESOLVED (2026-07-05): Chris picked C (custom render engine) + a pan/zoom vision.** Plan
  written + APPROVED → `design/map-engine-plan.md` (v1 fixed-view M0–M2 ships the D2.3 reveal; v2
  pan/zoom tile engine M3 post-launch; render-on-demand + cache, NOT planet pre-render). **M0 underway:**
  4 board-style textures generated via Recraft V4.1 (water/land/park/weathering, palette-locked 2K,
  ~8 cr each — Higgsfield balance 824→792, Plus); water + land verified excellent vs board; render-proof
  harness dispatched (sonnet, scratchpad). **Next: M0.5 MVP art gate — Chris vets the rendered JB view.**
  The original T5–T7 are superseded by the M0–M3 phasing (+ T6/T7 fold in as the sidebar/§2 surfaces).
  **M0 iteration (2026-07-05):** render harness `scratchpad/render-engine.mjs` PROVES the art — real JB
  MVT geometry painted with AI textures + Rough.js reads unmistakably as the board's journal map.
  Chris art notes round 1 applied: textures v2 (water bluer+uniform, park olive-distinct); engine art —
  **label subsystem** (curved water text-on-path via PCA channel-spine + collision-avoided point
  labels), **translucent torn-edge washi**, **fine-marker route** — all in the `CONFIG` block. Crop to
  JB+Straits + label-avoid-pins in progress. **Chris approved building a live "Map Studio"** (parametric
  tuning tool — sliders/color-pickers bound to CONFIG, instant repaint, Copy-CONFIG export) →
  BUILT + LIVE. Render pipeline extracted to shared `scratchpad/map-render-core.js` (646 lines,
  API: `fetchAndDecode` + `paintFull` — THIS is the M1 engine module, born early); `render-engine.mjs`
  refactored 902→391 lines, verified byte-identical output (same labelStats). `map-studio.mjs` = thin
  509-line wrapper (control panel + live canvas, Copy-CONFIG/Download-PNG/Reset), running on an
  orchestrator background server. **Chris is tuning the art live; awaiting his Copy-CONFIG export → lock
  engine defaults + commit assets (`public/map/assets/`) → M0.5 art gate CLOSED → M1 (wire engine into
  the reveal).** (Note: a first studio build hit the 64k subagent output cap by duplicating the pipeline;
  the extract-to-shared-module fix resolved it.) Higgsfield ~776 cr (6 textures @ ~8cr).

## Minor findings roll-up (feed to T9 final review)
- T2 Minor: ~8-line button-logic dup between `app/page.tsx` and `src/ui/board/NewTripButton.tsx` —
  MOOT once T3 replaces `app/page.tsx` with the greeting; no fix.
- T2 Minor (informational): git rename-detection pairs the old board history with
  `src/ui/board/TripBoard.tsx` (where the logic actually lives), not the route path — unavoidable
  given the content split + one-commit constraint; not a defect.
- T3 note (pre-existing parse quirk, NOT a T3 defect): heuristic parser's label capture swallows an
  inline time hint into the display name (e.g. stop renders "Lunch at Clock Tower Square 1pm"). Lives
  in `src/lib/parse` (D2.1), deterministic; T3's e2e documents it. Later polish — the LLM parser
  handles it better; flag for a D2.1 follow-up or D5.
- T3 note (design, for Chris): Gracie is STATIC in her journal pose on the greeting (no "wave" sprite
  exists among the 5 locked scenes; art is Chris-provisional). §8 says "waves" — swap needs new art
  (Chris's domain). Keeping the journal pose for now.
