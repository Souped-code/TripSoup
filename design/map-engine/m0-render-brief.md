# Task M0.4 — Journal-style map render harness (the art proof)

## Goal
Build a **scratchpad** Node + Playwright harness that renders a hand-illustrated, journal/watercolor
map of **Johor Bahru** by painting REAL vector-tile geometry with our AI-generated textures + Rough.js
strokes, and screenshots it (plus a side-by-side vs the target board). This is R&D to prove the map
render engine's art direction. **Work ONLY in the scratchpad dir — touch NO repo files, add NO deps.**

Scratchpad dir: `C:\Users\65881\AppData\Local\Temp\claude\C--Users-65881\e74d9f9d-10fb-4d66-8ec9-1682ccd92c10\scratchpad`

## Reference pattern (read it first)
`…/scratchpad/shoot-map.mjs` — an existing harness in this same dir. Copy its proven scaffolding:
`createRequire("C:/Users/65881/dev/itinerary-optimiser/package.json")` → `chromium` from
`@playwright/test`; a local `http.createServer` serving an HTML page; `page.goto`; wait; screenshot.
Your harness will be `…/scratchpad/render-engine.mjs`.

## Inputs available in the scratchpad
- Textures (2048² PNGs), serve these from your local server and load as canvas images:
  `tex-land.png` (warm cream paper — the base land), `tex-water.png` (sage watercolor — water),
  `tex-park.png` (muted green — parks), `tex-weathering.png` (aged paper — the overlay).
- Target board to self-compare against: `C:/Users/65881/dev/itinerary-optimiser/design/refs/d1.1-reveal-LOCKED-palette.png`

## Data source — OpenFreeMap vector tiles (OpenMapTiles schema)
1. First fetch the TileJSON `https://tiles.openfreemap.org/planet` and read its `tiles[0]` URL
   template (it is date-stamped, e.g. `.../planet/<date>/{z}/{x}/{y}.pbf` — do NOT hardcode the date;
   read it from the TileJSON at runtime).
2. Fetch the `.pbf` tiles covering JB and decode them in the browser with jsDelivr ESM bundles:
   ```js
   import Pbf from 'https://cdn.jsdelivr.net/npm/pbf@3.2.1/+esm';
   import { VectorTile } from 'https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@1.3.1/+esm';
   import rough from 'https://cdn.jsdelivr.net/npm/roughjs@4.6.6/+esm';
   ```
   `const vt = new VectorTile(new Pbf(arrayBuffer));` → `vt.layers[name]` → `layer.feature(i)` →
   `feature.loadGeometry()` returns arrays of rings of `{x,y}` in tile extent units (extent 4096) →
   `feature.properties` has `class`, `name`, `name:en`, etc.

## Projection (tile-pixel space, single zoom — keep it simple)
```
const Z = 11;                    // render zoom
const EXTENT = 4096, TILE = 256, SCALE = 2; const tilePx = TILE * SCALE;
const lon2x = (lon,z)=>Math.floor((lon+180)/360*2**z);
const lat2y = (lat,z)=>Math.floor((1-Math.log(Math.tan(lat*Math.PI/180)+1/Math.cos(lat*Math.PI/180))/Math.PI)/2*2**z);
// JB bbox (covers city + Straits of Johor + a strip of Singapore north)
const W=103.55, E=104.08, N=1.60, S=1.28;
const minX=lon2x(W,Z), maxX=lon2x(E,Z), minY=lat2y(N,Z), maxY=lat2y(S,Z); // y grows south
const canvasW=(maxX-minX+1)*tilePx, canvasH=(maxY-minY+1)*tilePx;
// a feature point in tile (tx,ty) with local (lx,ly):
const px = (tx,lx)=>(tx-minX)*tilePx + (lx/EXTENT)*tilePx;
const py = (ty,ly)=>(ty-minY)*tilePx + (ly/EXTENT)*tilePx;
```
Fetch every tile `(Z, tx, ty)` for `tx∈[minX,maxX]`, `ty∈[minY,maxY]` (a handful of tiles). Decode all,
collect features per layer.

## Paint order (bottom → top) — expose ALL the art values below as named consts at the top of the file
1. **Land base:** `ctx.fillStyle = ctx.createPattern(landImg,'repeat'); ctx.fillRect(0,0,canvasW,canvasH)`.
2. **Water:** from layer `water` (all features): build each polygon path (moveTo/lineTo over rings, using
   `px/py`), then `ctx.save(); ctx.clip(); fillStyle=waterPattern; fillRect(all); ctx.restore()`. Then
   draw a **hand-drawn coastline edge** along the water polygon outlines with Rough.js
   (`rc.linearPath(ring, {stroke:'#6f8a86', strokeWidth:1.6, roughness:1.4, bowing:1})`) — the defined
   watercolor coast edge is the board's signature; make water read as painted, not flat.
   Also include layer `waterway` (rivers) as thin water-colored rough lines.
3. **Parks:** layer `park` (+ `landcover` features with `class` in wood/grass/meadow) — clip + fill with
   parkPattern at ~0.55 alpha.
4. **Roads:** layer `transportation`. Draw ONLY `class` in [motorway,trunk,primary,secondary] at this
   zoom (sparse arterials — NOT every street). Rough.js: majors (motorway/trunk/primary) stroke
   `#9a7b4f` width 2.6 roughness 1.2; secondary `#b2a483` width 1.6. `rc.linearPath(points,{...})` per line.
5. **Labels:** layer `place`, `class` in [city,town]. Load **Gochi Hand** via a Google-Fonts `@font-face`
   in the HTML `<head>` and `await document.fonts.ready`. Draw `name:en ?? name` with a paper halo:
   `ctx.font="28px 'Gochi Hand'"; ctx.strokeStyle='#F6F1E7'; ctx.lineWidth=6; ctx.strokeText(...);
   ctx.fillStyle='#2B2620'; ctx.fillText(...)`. Sparse — city/town only. Also `water_name` in italic-ish
   blue-grey `#5E7F86` for "Straits of Johor".
6. **Weathering:** draw `tex-weathering.png` scaled over the whole canvas, `globalAlpha≈0.22`,
   `globalCompositeOperation='multiply'`, then reset. Add a vignette (radial gradient, transparent
   center → `rgba(74,58,38,0.20)` edges).
7. **Overlay — sample route + pins:** pick ~5 real JB lng/lat points (e.g. a coffee spot ~[103.76,1.49],
   old town ~[103.75,1.46], a temple ~[103.76,1.455], the mosque ~[103.79,1.46], a Straits point
   ~[103.80,1.44]) → project to canvas (convert lng/lat → tile-space at Z: `tx=lon in tiles`,
   use `(lon+180)/360*2**Z` for fractional tile X, and the lat formula for fractional tile Y, then the
   same `px/py` mapping). Draw the route through them with Rough.js in pen-blue `#3E6C8E`
   (strokeWidth 3.4, roughness 1.6, bowing 2). Numbered **pin circles**: paper fill `#F6F1E7`, ink
   stroke `#2B2620` width 2.3, number in `#2B2620`. One **"Booked" washi tag**: rounded rect fill
   `#F4C95D`, ink border, "4 · Booked" label.

## Output
- Screenshot the canvas to `…/scratchpad/render-engine-v0.png`. If the canvas is very large, scale the
  screenshot down to ≤1600px wide but keep it crisp.
- Build a stacked composite (board on top, our render below, captioned) → `…/scratchpad/render-engine-v0-vs-board.png` (same technique as `shoot-map.mjs`'s composite).
- Print JSON: `{ ok, tilesFetched, errors, out, composite }`.

## Success = a WORKING render (plumbing correct), reasonable art defaults
Your job is to get the mechanism working end-to-end: real JB geometry, textures clipped to the right
polygons, sparse rough roads, hand labels, weathering, route/pins — and a screenshot. The orchestrator
will art-tune the params afterward, so **put every color / width / roughness / alpha / SCALE / Z as a
clearly-named `const` block at the top** for easy tuning. Do NOT chase pixel-perfection with the board;
get it working and reasonably close.

## Report
Return: status (DONE / BLOCKED), the two screenshot paths, tiles fetched, any errors/decisions, and the
list of tunable consts you exposed. If a CDN import or the MVT decode fights you, say exactly how — do
not silently stub geometry.
