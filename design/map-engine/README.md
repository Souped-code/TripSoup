# TripSoup Journal Map Render Engine — R&D bundle

This folder is the working bench for TripSoup's **custom map render engine** (design/map-engine-plan.md,
phase **M0**). It paints real-world map geometry in the hand-illustrated journal/watercolor style of the
LOCKED reveal board (`design/refs/d1.1-reveal-LOCKED-palette.png`). It began in a session scratchpad and
was persisted here on branch `d2.3-reveal` for handover.

> **Why it's not literally your board:** the art fidelity comes from **AI-generated watercolor textures**
> (once, offline) + **procedural rendering** (Rough.js strokes, textured fills, a label subsystem). No
> per-trip AI at runtime — a brand-new location paints instantly from committed assets.

## Files
| File | What it is |
|---|---|
| `map-render-core.js` | **The engine core** (browser ES module). The M1 build imports/adapts this. API: `fetchAndDecode(config) -> decoded` (OpenFreeMap MVT fetch+decode, cached per view), `paintFull(canvas, config, decoded, textures) -> stats` (basemap textures + coast + water + parks + Rough.js roads + weathering/vignette + **label subsystem** [curved water text-on-path via PCA channel-spine + collision-avoided point labels] + route/pins/washi + `VIEW_BBOX` crop). Browser libs load from jsDelivr `/+esm` (pbf, @mapbox/vector-tile, roughjs). |
| `render-engine.mjs` | Node+Playwright **screenshot harness**: renders one JB view + a side-by-side vs the board. `node render-engine.mjs` → `render-engine-v0.png` + `render-engine-v0-vs-board.png`. Owns the canonical `CONFIG` block. |
| `map-studio.mjs` | The **live tuning tool** (Node http server + interactive page). `node map-studio.mjs` → open the printed `http://127.0.0.1:PORT/` → drag sliders/color-pickers, map repaints live → **Copy CONFIG** to export tuned values. This is how the art is dialed in. |
| `tex-{land,water,park,weathering}.png` | AI watercolor textures (Recraft V4.1, palette-locked to design.md §3, Chris-approved). Production copies live in `public/map/assets/tex/`. |
| `*-brief.md` | The subagent briefs used to build the above (provenance). |

## Run the studio
```
cd design/map-engine
node map-studio.mjs
```
Open the printed URL. Tune → **Copy CONFIG** → those values become the engine defaults. Ctrl+C to stop.
(Or the convenience launcher `C:\Users\65881\map-studio.bat`, if it still points here.)

## Architecture (from design/map-engine-plan.md)
- **Layer split:** a painted **basemap** + a live **overlay** (route/pins/washi) that redraws on reorder
  — the basemap never re-renders when the user reorders stops.
- **v1 (M0–M2):** fixed-view reveal. **v2 (M3, post-launch):** generalize `paintFull` into an
  on-demand tile source (client canvas layer → server tile endpoint + CDN cache) for pan/zoom —
  **render-on-demand + cache, never a planet pre-render.**
- The `CONFIG` block holds every tunable (colors, stroke weights, texture scale, crop `VIEW_BBOX`,
  label sizes, route/washi params, `Z`, `SCALE`).

## Fidelity pass (2026-07-06, Chris's audit request)
Chris's complaints — text not rendering neatly in its spaces, washi not tape-like, overlap/format
breakdown when elements get close — were audited and fixed in `map-render-core.js`:
- **Resolution-invariant sizing:** every px value in CONFIG is authored at `REF_TILEPX` (1024 =
  TILE 256 × SCALE 4) and scaled by `K = TILEPX/REF_TILEPX` at paint. SCALE now changes resolution
  only, never proportions (this was why studio-tuned text looked wrong at other sizes).
- **Text:** optical centering from measured glyph bounds (pins, washi, labels); ALL map lettering in
  the hand font (`FONT_FAMILY_HAND` — design.md §2.4 bans Segoe/system faces); tape sized to its
  lettering; long place names wrap to two lines (like the board's mosque label).
- **Washi (board-faithful + patterns, per Chris's picks):** slight tilt, multi-scale torn ENDS only,
  no perimeter outline, matte (sheen off), circled stop number ④ + 'Booked' in ink, optional
  gingham/stripes pattern, placement collision-tested (may lie across the route, never covers a pin,
  never leaves the frame).
- **Crowding (trip overlay wins + studio knobs):** point labels nudge (incl. diagonals) → shrink →
  drop; avoid route/pins/washi/each other/frame edge (no more mid-word slicing); density capped
  (route map, not an atlas — §8); curved water labels slide along the channel spine + shrink to a
  fully clear window and NEVER drop glyphs mid-word; pins declutter with an ink leader + true-spot dot.
- **Determinism:** per-feature seeded Rough.js strokes — repaints are byte-identical (M1/M2 constraint;
  smoketest's colorblind-restore now reports meanDiff 0).
- **`upgradeConfig()` (exported):** migrates any older flat-shape CONFIG (e.g. an earlier Copy-CONFIG
  export: `FONT_LABEL`, `PIN_DIAMETER`, `WASHI_*`) to the current `PIN:{}`/`WASHI:{}` shape — old
  pastes keep working, at their own authored proportions.

## Status / next
- **Art direction PROVEN** (see `render-engine-v0-vs-board.png` / `design/refs/d2.3-map-engine-vs-board.png`):
  real JB geometry reads unmistakably as the board's journal map, now at board proportions.
- **M0.5 art gate** closes when Chris pastes his **Copy CONFIG** (older exports auto-migrate via
  `upgradeConfig`), re-tunes the new dials (Pins / Washi pattern / Crowding groups) in the studio,
  and re-exports → those values become the engine's `CONFIG` defaults.
- **Then M1:** wire `map-render-core.js` into the real reveal at `app/trip/[id]` (fixed-view), route
  re-sketching on reorder — see design/map-engine-plan.md phases M1/M2, then the D2.3 sidebar (T6, incl.
  the duplicate `duplicateOf` flag) + §2 surfaces (T7), done-check, merge.
