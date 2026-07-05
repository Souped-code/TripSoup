# Task — "Map Studio": a live browser-based tuning tool for the journal map render

## Goal
Build `map-studio.mjs` in the scratchpad — a local web app that lets a designer tune the journal map
render in REAL TIME: a control panel (sliders / color-pickers / inputs) bound to the render CONFIG,
beside a live canvas that re-renders instantly on any change. This replaces the slow
edit-code → re-run → screenshot loop with direct manipulation. Reuse the render logic + CONFIG +
textures from `render-engine.mjs` in the same scratchpad dir.

Scratchpad: `C:\Users\65881\AppData\Local\Temp\claude\C--Users-65881\e74d9f9d-10fb-4d66-8ec9-1682ccd92c10\scratchpad`

## How it will be used
The user runs `node map-studio.mjs`; it starts a local http server and prints a URL (e.g.
http://127.0.0.1:5178). They open it in a browser and tweak; the server stays up until they stop it.
YOU build it and smoke-test it headless (Playwright: page loads, canvas paints non-blank, changing a
control triggers a repaint without error), then report how to run it + the control list. Do NOT try to
keep a server running yourself — verify and report.

## Read / reuse (do not reinvent the paint pipeline)
- `render-engine.mjs` — reuse its browser-side pipeline verbatim where possible: TileJSON fetch → tile
  fetch → MVT decode (Pbf + @mapbox/vector-tile via jsDelivr `/+esm`) → projection → basemap paint
  (textures, coast, water, parks, roads, weathering, vignette) → the label subsystem (curved water
  text-on-path + collision point labels) → route/pins/washi → the `VIEW_BBOX` crop. And its `CONFIG`
  block (all tunables — read it to enumerate every control). Cleanest refactor: a
  `renderMap(ctx, config, decoded)` paint function + a `fetchAndDecode(config)` that returns cached
  geometry keyed by the view (bbox/zoom).
- Textures: serve `tex-{land,water,park,weathering}.png` from the local server; load as `Image`s.

## The studio page
- **Layout:** left = scrollable control panel; right = the live canvas (fit to viewport, showing the
  `VIEW_BBOX` crop region).
- **Controls — bind each to its CONFIG value, grouped, sensible min/max/step, with a live numeric readout:**
  - *View:* `VIEW_BBOX` W/E/N/S (or center lng/lat + `Z` slider 9–14). A view change RE-FETCHES tiles.
  - *Water:* tint color, `TEXTURE_SCALE`; `COLORS.coastStroke` + `WIDTHS.coast`.
  - *Land:* `TEXTURE_SCALE` (land).
  - *Parks:* tint color, `ALPHA.park`.
  - *Roads:* `COLORS.roadMajor` + `WIDTHS.roadMajor`, `COLORS.roadSecondary` + `WIDTHS.roadSecondary`,
    class toggles (motorway/trunk/primary/secondary/tertiary).
  - *Labels:* `WATER_LABEL.fontMin/fontMax/letterSpacing`; `POINT_LABEL` size + `haloWidth`.
  - *Route:* `COLORS.routeLine`, `ROUTE_WIDTH`, `ROUTE_BLEED_EXTRA`, `ROUTE_BLEED_ALPHA`, `ROUTE_SMOOTH`.
  - *Washi:* `COLORS.washiFill`, `WASHI_ALPHA`, `WASHI_TEAR_AMP`, `WASHI_TEAR_SEGMENTS`.
  - *Weathering:* `ALPHA.weathering`, vignette color/strength.
- **Performance (important):** fetch + decode tiles ONCE and cache the decoded geometry per view. A
  control change that does NOT change the view (colors/widths/alphas/labels/route/washi) only REPAINTS
  from the cache — instant. Only a VIEW change re-fetches/decodes (debounce ~250ms). Repaint debounce ~40ms.
- **Buttons:**
  - **"Copy CONFIG"** — serialize the current tuned CONFIG to JSON into the clipboard AND a visible
    textarea (so the tuned values can become the engine's defaults). This is the key output.
  - **"Download PNG"** — `canvas.toBlob` → download the current render.
  - **"Reset"** — restore the file's CONFIG defaults.
- **Studio chrome:** keep it plain/utilitarian — it's a dev tool, not the product. Don't spend design
  effort on the panel styling itself.

## Deliverable + smoke test
`map-studio.mjs`. Smoke-test headless (Playwright, via the repo's `@playwright/test` like
render-engine.mjs): start the server, load the page, wait for the canvas to paint (assert non-blank /
that the map images loaded), programmatically change one control (a color or a width) and assert a
repaint occurred without error, then tear everything down. Report: DONE, the exact run command, the
full grouped control list, and any perf/repaint notes. Do NOT leave a server running.

## Constraints
- Scratchpad only. No repo changes. No npm installs (browser libs via jsDelivr `/+esm`, as
  render-engine.mjs does).
- Reuse render-engine.mjs's render logic — the studio and the harness should paint identically.
