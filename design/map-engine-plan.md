# Journal Map Render Engine — Implementation Plan

> **For agentic workers:** execute via **superpowers:subagent-driven-development**, task-by-task.
> **This plan is APPROVAL-STAGE.** Phase **M0** (art R&D + the MVP art gate) is detailed and
> actionable now. Phases **M1–M3** are outlined at architecture level; their detailed TDD tasks are
> authored **after the M0 art gate passes**, because the rendering implementation depends on the
> validated asset/stroke recipe (writing full render code before the art is proven would be
> speculative — YAGNI). Steps use `- [ ]` for tracking.

**Goal:** Build TripSoup's own map render engine that paints any real-world area in the
hand-illustrated journal/watercolor style of the locked reveal board
(`design/refs/d1.1-reveal-LOCKED-palette.png`), with the route / pins / washi tapes / markers as a
live overlay that redraws on reorder — shipping first as a fixed-view reveal (**v1**) and
generalizing to a pan/zoom, whole-world, **render-on-demand-and-cache** tile engine (**v2**).

**Architecture:** Real geometry (free OpenFreeMap vector tiles, OpenMapTiles schema) is the input; a
custom renderer paints it in our journal style using **AI-generated-once watercolor/paper textures +
Rough.js hand-inked strokes + a hand-lettered label font**. The painted **basemap** and the live
**overlay** (route/pins/tapes) are strictly separate layers — the overlay redraws on reorder, the
basemap does not. **v1** renders one framed view; **v2** wraps the *same* render core as an
on-demand tile source (client canvas layer → server tile endpoint + CDN cache), so "the whole world
in our style" fills in **by usage, cached and compounding** — never pre-rendered upfront.

**Why build vs buy:** no product paints our exact journal style at pan/zoom. Stamen Watercolor proves
the aesthetic is possible but is a fixed style on someone else's infra; our board's warm-paper
identity + washi/pen language needs to be ours. The compounding on-demand cache makes "our own tiles"
affordable without a planet pre-render.

**Tech stack:** Next 15 / React 19 (existing) · OpenFreeMap vector tiles · **Rough.js** (hand-drawn
strokes) · HTML `<canvas>` (render; `node-canvas` for v2 server tiles) · **Motion** (motion.dev) for
reveal motion, lazy-loaded on the reveal route only · **Higgsfield** (one-time board-style asset
generation) · **MapLibre GL** reused ONLY as the v2 pan/zoom shell hosting our custom tile source ·
existing **dnd-kit** for the sidebar reorder.

## Global Constraints (from design.md + master plan — bind every task)
- **Art north-star:** stay as true as possible to `design/refs/d1.1-reveal-LOCKED-palette.png` —
  warm cream paper, watercolor sage water, sparse hand-inked warm/ochre roads, hand-lettered labels,
  pen-blue (`--route-blue #3E6C8E`) hand-drawn route, numbered pin circles, washi tags
  (`--washi #F4C95D` = booked), faint weathering.
- **Palette LOCKED (design.md §3):** `--paper #F6F1E7` land · water desaturated sage (board tone,
  warmed from `#C9D6D2`) · `--ink #2B2620` · `--route-blue #3E6C8E` (map route/pen only) · washi set.
  `--action` green and `--soup` orange NEVER appear on the map (UI/brand only). No new hues (§3
  shade-derivation rule).
- **Anti-generic law (design.md §2):** no gradients / glassmorphism / generic fonts; hand-drawn
  everything; paper-&-pen motion (§6, 250–400 ms springs), one signature transition per surface.
- **LOCKED ports untouched:** solver / schedule / matrix / store stay LOCKED. The map is pure
  presentation over `planTripDay` output + `manualOrder` (already built, D2.3). It never reaches
  around the ports.
- **Determinism:** Rough.js is **seeded per feature** so strokes are stable across redraws — no
  wobble-jitter when the route reorders (only the route deliberately re-sketches).
- **No per-request AI at runtime:** all AI generation (textures/brushes) is one-time & offline;
  committed as static assets. Runtime is procedural only. Landing bundle unaffected (engine
  lazy-loads on the reveal route). v2 tiles cache-on-demand (compounding), never planet-pre-rendered.
- **Gates:** `tsc` / `jest` / `playwright` green per task; fixture-mode e2e exercises the reveal;
  Chris visual gates at **M0 (art)** and **M1/M2 (reveal/motion)**.

## File structure (target)
- `src/lib/map/geometry/` — OpenMapTiles vector fetch + decode + **simplify** to our sparse feature
  set (coastline, water, major roads, parks, place labels). One responsibility: geometry in.
- `src/lib/map/project.ts` — pure Web-Mercator geo→pixel for a given bbox/zoom/size. Tested with goldens.
- `src/lib/map/render/paintBasemap.ts` — the render core: watercolor fills (textures) + Rough.js
  strokes + labels + paper/vignette, onto a canvas context for a viewport.
- `src/lib/map/render/strokeStyles.ts` — Rough.js params per feature class, tuned to the board (M0).
- `public/map/assets/` — one-time AI-generated (board-style) seamless textures (water/land/park/paper)
  + pin / washi / marker SVGs + label font.
- `src/ui/reveal/Reveal.tsx` — basemap canvas host + bbox compute + overlay mount.
- `src/ui/reveal/RouteOverlay.tsx` — route/pins/tapes; redraws on reorder; re-sketch animation.
- `app/trip/[id]/page.tsx` — swap the interim reveal (T3) for the real reveal.
- **(v2)** `src/lib/map/tileSource.ts` + `app/api/map/tiles/[z]/[x]/[y]/route.ts` — on-demand tile
  source + server render/cache.

## Phases

### Phase M0 — Art R&D + MVP checkpoint  ← **Chris gate before any engine code**
Prove we can paint a real area in the board's style with procedural rendering + AI-made assets, and
let Chris vet the art & assets first. **No M1+ work starts until M0.5 passes.**

- [ ] **M0.1 [Higgsfield] Board-matched seamless textures** → `public/map/assets/tex/`: watercolor
  **water** (sage, soft bleeding edges), **paper/land** (warm cream, fibrous), **park** (muted
  green wash), **paper background** (weathered, faint edge/stain). Prompts locked to the board;
  request tileable. *Fallback if not seamless: large swatches, mirror-tile/blend in-engine.*
- [ ] **M0.2 Stroke recipe** → tune Rough.js params to the board's linework (warm-tan major roads,
  thin ink minors, coastline) as a sample sheet; record the winning params for `strokeStyles.ts`.
- [ ] **M0.3 Overlay art** → numbered pin circle, washi "Booked" tag + tape row-tabs, marker — SVG,
  hand-drawn 1.5px wobble (§2.6). Pick the **map label font** (Gochi Hand vs a lighter hand face —
  decide by legibility at 12–16px map sizes).
- [ ] **M0.4 MVP render harness** → standalone: fetch real **JB** vector geometry → simplify →
  project → `paintBasemap` with M0 assets + Rough.js + labels + paper/vignette → draw a sample
  pen-blue route + numbered pins + a "Booked" washi. Screenshot desktop + mobile.
- [ ] **M0.5 CHRIS GATE** → present the render side-by-side with the board. Chris vets art + assets;
  iterate M0.1–M0.4 on his notes. **Fallback if procedural can't reach the board's soul after ~2
  iterations:** escalate options (heavier AI base per hero view / hybrid) back to Chris —
  documented, never silently downgraded.

**Done:** Chris-approved art; committed assets; a written **render recipe** (which asset does what,
stroke params, label + overlay treatment) that M1 implements.

### Phase M1 — v1 render core + reveal integration (fixed view)  *[detailed after M0]*
Geometry module (+ tests) · `project.ts` (+ goldens) · `paintBasemap` per the M0 recipe ·
`Reveal.tsx` (compute trip bbox from stops, paint basemap) · `RouteOverlay.tsx` (project stops →
numbered pins, route in visiting order, washi tags) · wire `/trip/[id]` to the real plan
(`planTripDay` + `manualOrder`) → reorder recomputes order → route re-draws (seeded, re-sketch) ·
fixture-mode Playwright (reveal renders, reorder re-paths, pins/tapes present).
**Gate:** tsc/jest/pw green + Chris eyeballs the live reveal.

### Phase M2 — Motion + polish  *[detailed after M0]*
Adopt Motion (lazy on reveal route) · cloud transition (billow-in/part ~1.6 s; reduced-motion →
crossfade) · route draw-on + re-sketch on reorder + pencil-scribble sfx (existing `public/sfx/`,
mute toggle §6) · pin-drop / washi-settle spring micro-motions.
**Gate:** reduced-motion honored everywhere; sfx behind mute; Chris eyeballs motion.

### Phase M3 — v2 pan/zoom tile engine  *[can land after D2.3 launch]*
Generalize `paintBasemap` into `renderTile(z,x,y)` (same recipe, per-tile bbox). **Runtime A (ship
first):** client custom MapLibre source backed by `renderTile` in a web worker, in-session cache →
pan/zoom. **Runtime B (scale):** server `/api/map/tiles/{z}/{x}/{y}` (node-canvas) + CDN/Supabase
cache, render-on-demand & compounding; MapLibre points at the URL. Overlays unchanged.
**Gate:** pan/zoom smooth on mobile 390px; cache hit-rate sane; cost bounded.

### Then — remaining D2.3, integrated with the reveal
- **T6** torn-journal sidebar: dnd reorder → `manualOrder` (built), re-optimize clears,
  infeasible → red margin note, **+ the duplicate `duplicateOf` flag + remove control + reveal
  heads-up** (T4b produced the data).
- **T7** LOCKED §2 surfaces: per-leg walk/drive toggle (both times) + walkMax/driveOverhead
  "planner's notes" pocket.
- **T8** D2.4 Playwright full-flow · **T9** fresh-context audit · **T10** done-check + STATE + merge.

## Risks & mitigations
1. **Procedural render ≠ the AI board's cohesion** (TOP risk) → M0 gate tests it *first* with real
   assets; fidelity carried by AI-made **textures**, not procedural flat color; fallbacks pre-agreed.
2. **Rough.js jitter on reorder** → seed per feature; only the route re-sketches (deliberate).
3. **Client render perf (v2)** → web workers + tile cache, or server tiles (Runtime B).
4. **Non-seamless AI textures** → mirror-tile/blend fallback.
5. **Scope creep** → v1 (M0–M2) ships the reveal; v2 (M3) can follow launch without blocking D2.3.

## MVP checkpoint (the single most important gate)
**End of M0:** Chris vets (a) the generated watercolor/paper **assets** and (b) **one JB view**
rendered by our engine, against the board. **Go/no-go on the art before any engine is built.**

## Verification
Per-task tsc/jest/Playwright · visual gates M0 (art) + M1/M2 (reveal/motion) · fixture-mode e2e for
the whole reveal flow · final fresh-context audit (T9).

## Fit with the master plan
Expands D2.3's "MapLibre + paper style JSON" into a custom render engine (Chris-directed
2026-07-05). **v1 (M0–M2) delivers the D2.3 reveal; v2 (M3) is a post-launch enhancement.** Logged as
an approved deviation in STATE.md.
