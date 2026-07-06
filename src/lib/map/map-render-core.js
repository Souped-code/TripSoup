// map-render-core.js
// Shared browser-side render pipeline for the hand-illustrated JB map.
// Extracted from render-engine.mjs (M0.4) so a second tool (a live tuning
// studio) can load the EXACT same paint code and re-run it repeatedly with a
// mutated config, without duplicating the pipeline.
//
// Design rule: everything is parameterized over a `config` object and
// `textures` (already-loaded <img>/ImageBitmap elements) passed in at call
// time. This module never string-interpolates CONFIG and has no baked-in
// defaults of its own — the caller (render-engine.mjs / map-studio.mjs) owns
// the CONFIG values and textures. upgradeConfig() (exported) migrates any
// older flat-field CONFIG shape (e.g. a Copy-CONFIG export from an earlier
// studio build) to the current shape, so pasted configs keep working.
//
// FIDELITY PASS (M0.5 audit, 2026-07-05) — what changed vs the first cut:
//   * RESOLUTION-INVARIANT SIZING: every px-dimension in CONFIG (fonts, pin
//     diameter, washi box, stroke widths, tear amplitude, texture grain) is
//     authored at a reference resolution (REF_TILEPX, default TILE*SCALE at
//     author time) and internally multiplied by K = TILEPX/REF_TILEPX, so the
//     same config paints identical PROPORTIONS at any SCALE/DPR. Before this,
//     SCALE silently changed the relative size of all text/pins.
//   * TEXT: optically centered via measured glyph bounds (no em-box + magic
//     +1px), explicit textAlign/Baseline at every draw site (no leaked canvas
//     state), all map lettering in the hand font (design.md §2.4 bans system
//     faces), washi label measured and the tape sized to its content,
//     long point labels wrap to two lines (like the board's mosque label).
//   * WASHI: slight tilt, multi-scale torn ENDS only (long edges straight,
//     no full-perimeter outline), circled stop number ④ + 'Booked' in ink,
//     optional gingham/stripes pattern, placement collision-tested against
//     pins (tape may lie across the route — that's the point of tape — but
//     never covers a pin or leaves the frame).
//   * CROWDING (trip overlay wins): route/pins/washi never yield. Point
//     labels nudge (incl. diagonals) → shrink stepwise → drop; they avoid the
//     route line, pins, washi, each other, and the crop edge (no more labels
//     sliced mid-word at the frame). Curved water labels slide along the
//     channel spine to the clearest window and shrink before ever colliding;
//     glyphs are NEVER dropped mid-word anymore (that produced "Straits …
//     Johor"). Water labels also register their glyph boxes so later labels
//     avoid them.
//   * PINS: per-feature seeded Rough.js strokes (deterministic repaints — a
//     plan-level constraint for M1's reorder redraws) and a declutter pass:
//     overlapping pins get pushed apart with a small ink leader + dot at the
//     true location.
//
// M1 (2026-07-06): this file moved to src/lib/map/ and is now the PRODUCT's
// render engine (the design bench serves it from here). New for M1:
//   * provideLibs({Pbf, VectorTile, rough}) — the app injects npm-bundled libs
//     (lazy, reveal-route only); the CDN import stays as the bench fallback.
//   * BASE/OVERLAY SPLIT (the plan's layer rule: the basemap never re-renders
//     on reorder): buildScene() paints geography + labels once and snapshots
//     it; paintOverlay() restores the snapshot and draws route/pins/washi for
//     a given visit order; renderToDisplay() crops onto a display canvas.
//     paintFull() composes all three (bench behavior unchanged, except water
//     labels now paint under the overlay — placement already keeps them
//     clear of it, so pixels only differ if a REORDERED route crosses one).
//   * WASHI_INDEX may be null/-1/out-of-range → no tape (real trips may have
//     no booked anchor).
//
// Public API (import * as MapRenderCore from './map-render-core.js'):
//   provideLibs({Pbf, VectorTile, rough})                 app-side lib injection
//   preloadLibs() -> Promise<{Pbf, VectorTile, rough}>    CDN fallback / warm-start
//   loadImage(src) -> Promise<HTMLImageElement>
//   upgradeConfig(config) -> config'                      old-shape migration (idempotent)
//   fetchAndDecode(config, opts?) -> Promise<Decoded>     cached per view (Z/BBOX/TILE/SCALE/EXTENT_FALLBACK)
//   clearDecodeCache() -> void
//   buildScene(config, decoded, textures, opts?) -> Promise<Scene>
//     opts.legGeometries: per-leg road polylines to seed label collision from
//     the real pen path (M2) instead of straight chords
//   paintOverlay(scene, {routePoints, washiIndex, legGeometries?,
//     routeProgress?, pinPop?, washiSettle?}) -> {pinsDisplaced, washiPlaced}
//     (M2: road-following pen + draw-on/spring animation params — see the
//     function's doc block)
//   renderToDisplay(scene, canvas, maxW?) -> {crop, dispW, dispH, canvasW, canvasH}
//   paintFull(canvas, config, decoded, textures) -> Promise<Stats>
//
// Decoded shape: { layers, layerCounts, grid, MINX, MAXX, MINY, MAXY, TILEPX,
//                  CANVAS_W, CANVAS_H, tilesFetched, tilesFailed, tileTemplate }
// Stats shape:   { labelStats: {waterCurved, waterStraight, waterSkipped,
//                  pointsPlaced, pointsSkipped, pinsDisplaced},
//                  crop: {x,y,w,h}, dispW, dispH, canvasW, canvasH }
// textures shape: { land, water, park, weathering } (HTMLImageElement each)

// ============================================================================
// 0. Render libs (Pbf, VectorTile, roughjs) — loaded once, memoized.
// Two supply paths:
//   * provideLibs({Pbf, VectorTile, rough}) — the Next app calls this with
//     npm-bundled modules (lazy-imported on the reveal route) BEFORE any
//     engine call, so the CDN path below never executes in the product.
//   * preloadLibs() CDN fallback — the design bench (render-engine.mjs /
//     map-studio.mjs) runs this file as a raw browser module with no bundler,
//     so it self-loads from jsDelivr. The webpackIgnore/turbopackIgnore
//     comments stop Next's bundlers from trying to resolve the URLs.
// ============================================================================
let _libsPromise = null;
export function provideLibs(libs) {
  if (!libs || typeof libs.Pbf !== 'function' || typeof libs.VectorTile !== 'function' || !libs.rough || typeof libs.rough.canvas !== 'function') {
    throw new Error('provideLibs expects {Pbf, VectorTile, rough} with callable shapes');
  }
  _libsPromise = Promise.resolve(libs);
}
export function preloadLibs() {
  if (_libsPromise) return _libsPromise;
  _libsPromise = (async () => {
    const [pbfMod, vtMod, roughMod] = await Promise.all([
      import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'https://cdn.jsdelivr.net/npm/pbf@3.2.1/+esm'),
      import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@1.3.1/+esm'),
      import(/* webpackIgnore: true */ /* turbopackIgnore: true */ 'https://cdn.jsdelivr.net/npm/roughjs@4.6.6/+esm'),
    ]);
    const Pbf = pbfMod.default || pbfMod;
    if (typeof Pbf !== 'function') throw new Error('Pbf import shape unexpected: keys=' + Object.keys(pbfMod).join(','));
    const VectorTile = vtMod.VectorTile || (vtMod.default && vtMod.default.VectorTile);
    if (typeof VectorTile !== 'function') throw new Error('VectorTile import shape unexpected: keys=' + Object.keys(vtMod).join(','));
    const rough = roughMod.default || roughMod;
    if (!rough || typeof rough.canvas !== 'function') throw new Error('roughjs import shape unexpected: keys=' + Object.keys(roughMod).join(','));
    return { Pbf, VectorTile, rough };
  })();
  return _libsPromise;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load: ' + src));
    img.src = src;
  });
}

// ============================================================================
// 0.5 CONFIG shape migration + defaults for the fidelity-pass fields.
// Accepts the pre-fidelity flat shape (FONT_LABEL/"28px 'Gochi Hand'",
// PIN_DIAMETER, WASHI_W/H/ALPHA/TEAR_*, FONT_PIN_NUM, FONT_WASHI) and
// returns the current shape. Idempotent: a new-shape config passes through
// with only missing-field defaults filled. Never mutates its argument.
// ============================================================================
function parseFontPx(fontStr, fallback) {
  const m = /(\d+(?:\.\d+)?)px/.exec(fontStr || '');
  return m ? parseFloat(m[1]) : fallback;
}

export function upgradeConfig(cfg) {
  const c = structuredClone(cfg);

  // Reference resolution all size values are authored at. For an old config
  // (no REF_TILEPX) this is its OWN TILE*SCALE — proportions render exactly
  // as they did in the tool that exported it, then stay locked at any scale.
  if (!c.REF_TILEPX) c.REF_TILEPX = (c.TILE || 256) * (c.SCALE || 4);

  if (!c.FONT_FAMILY_HAND) c.FONT_FAMILY_HAND = "'Gochi Hand'";
  if (!c.STROKE_SEED) c.STROKE_SEED = 7;

  c.PIN = Object.assign(
    {
      diameter: c.PIN_DIAMETER != null ? c.PIN_DIAMETER : 26,
      strokeWidth: (c.WIDTHS && c.WIDTHS.pinStroke) != null ? c.WIDTHS.pinStroke : 1.7,
      numFontSize: parseFontPx(c.FONT_PIN_NUM, 13),
      declutter: true,
      declutterGap: 4,
      leaderDot: 2.4,
    },
    c.PIN || {}
  );

  c.WASHI = Object.assign(
    {
      h: c.WASHI_H != null ? c.WASHI_H : 30,
      padX: 12,
      minW: c.WASHI_W != null ? Math.min(c.WASHI_W, 240) : 90,
      maxW: 240,
      fontSize: parseFontPx(c.FONT_WASHI, 15),
      alpha: c.WASHI_ALPHA != null ? c.WASHI_ALPHA : 0.94,
      angleDeg: -3,
      tearSegs: c.WASHI_TEAR_SEGMENTS != null ? Math.max(8, c.WASHI_TEAR_SEGMENTS) : 12,
      tearAmp: c.WASHI_TEAR_AMP != null ? c.WASHI_TEAR_AMP : 3.2,
      tearFine: 1.1,
      seed: c.WASHI_TEAR_SEED != null ? c.WASHI_TEAR_SEED : 20260705,
      pattern: 'plain', // 'plain' | 'gingham' | 'stripes'
      patternAlpha: 0.13,
      sheenAlpha: 0, // board tape has no gloss — kept as a dial, default off
      offset: 0.72, // tape center distance from its pin, in tape-heights
    },
    c.WASHI || {}
  );

  c.WATER_LABEL = Object.assign(
    {
      fontStyle: 'italic', fontBase: 24, fontMin: 12, fontMax: 28,
      fillFrac: 0.62, cloudRadiusFrac: 0.09, minCloud: 40, buckets: 12,
      trim: 0.1, smoothPasses: 2, letterSpacing: 2, haloWidth: 4,
      glyphSkipMargin: 4,
    },
    c.WATER_LABEL || {}
  );
  if (!c.WATER_LABEL.fontFamily) c.WATER_LABEL.fontFamily = c.FONT_FAMILY_HAND;

  c.POINT_LABEL = Object.assign(
    {
      fontSize: parseFontPx(c.FONT_LABEL, 22),
      haloPad: 3, haloWidth: 5,
      nudges: [
        [0, 0], [0, -1], [0, 1], [-1, 0], [1, 0],
        [-1, -1], [1, -1], [-1, 1], [1, 1], [0, -2], [0, 2],
        [-2, 0], [2, 0], [-2, -1], [2, 1], [0, -3], [0, 3], [-3, 0], [3, 0], [-2, 1], [2, -1],
      ],
      nudgeStep: 0.9, pinPad: 4,
      maxLabels: 8, // route map, not a street atlas (design.md §8)
      twoLineMaxW: 170, // wider single-line labels wrap like the board's mosque label
      shrinkFloor: 0.8, // labels may shrink to this ×fontSize before dropping
      edgeMargin: 10, // no text within this of the crop edge (kills mid-word slicing)
      routePad: 3, // clearance between labels and the route pen line
    },
    c.POINT_LABEL || {}
  );
  // an OLD-shape config's 5-nudge list would defeat the new placement — but
  // only replace it when the config really is old-shape (FONT_LABEL marks
  // that); a deliberately short NEW-shape list is respected.
  if (c.FONT_LABEL != null && c.POINT_LABEL.nudges.length < 8) {
    c.POINT_LABEL.nudges = [
      [0, 0], [0, -1], [0, 1], [-1, 0], [1, 0],
      [-1, -1], [1, -1], [-1, 1], [1, 1], [0, -2], [0, 2],
      [-2, 0], [2, 0], [-2, -1], [2, 1], [0, -3], [0, 3], [-3, 0], [3, 0], [-2, 1], [2, -1],
    ];
  }

  return c;
}

// Every CONFIG px value is authored at REF_TILEPX; multiply by K at paint
// time so proportions are resolution-invariant. deriveSizes() is the single
// place that scaling happens — draw code below reads D.*, never C.* px.
function deriveSizes(C, K) {
  const s = (v) => v * K;
  return {
    K,
    coast: s(C.WIDTHS.coast), waterway: s(C.WIDTHS.waterway),
    roadMajor: s(C.WIDTHS.roadMajor), roadSecondary: s(C.WIDTHS.roadSecondary),
    washiEdge: s(C.WIDTHS.washiStroke != null ? C.WIDTHS.washiStroke : 1.1),
    routeWidth: s(C.ROUTE_WIDTH), routeBleed: s(C.ROUTE_WIDTH + C.ROUTE_BLEED_EXTRA),
    pinDiam: s(C.PIN.diameter), pinStroke: s(C.PIN.strokeWidth),
    pinNum: s(C.PIN.numFontSize), pinGap: s(C.PIN.declutterGap), leaderDot: s(C.PIN.leaderDot),
    washiH: s(C.WASHI.h), washiPadX: s(C.WASHI.padX),
    washiMinW: s(C.WASHI.minW), washiMaxW: s(C.WASHI.maxW),
    washiFont: s(C.WASHI.fontSize), washiTearAmp: s(C.WASHI.tearAmp),
    washiTearFine: s(C.WASHI.tearFine), washiOffset: C.WASHI.offset, // in tape-heights
    wlFontBase: s(C.WATER_LABEL.fontBase), wlFontMin: s(C.WATER_LABEL.fontMin),
    wlFontMax: s(C.WATER_LABEL.fontMax), wlLetterSpacing: s(C.WATER_LABEL.letterSpacing),
    wlHalo: s(C.WATER_LABEL.haloWidth), wlGlyphMargin: s(C.WATER_LABEL.glyphSkipMargin),
    plFont: s(C.POINT_LABEL.fontSize), plHaloPad: s(C.POINT_LABEL.haloPad),
    plHalo: s(C.POINT_LABEL.haloWidth), plPinPad: s(C.POINT_LABEL.pinPad),
    plTwoLineMaxW: s(C.POINT_LABEL.twoLineMaxW), plEdge: s(C.POINT_LABEL.edgeMargin),
    plRoutePad: s(C.POINT_LABEL.routePad),
    textureScale: C.TEXTURE_SCALE * K,
  };
}

// ============================================================================
// 1. Projection — pure functions of (config, grid). `grid` is the fetched-
//    tile bounding box + tile-px scale, computed once per view by computeGrid
//    (called from fetchAndDecode) and carried on the Decoded object so paint
//    code never has to recompute it.
// ============================================================================
function lon2xFrac(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
function lat2yFrac(lat, z) { return (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z); }

function computeGrid(config) {
  const MINX = Math.floor(lon2xFrac(config.BBOX.W, config.Z));
  const MAXX = Math.floor(lon2xFrac(config.BBOX.E, config.Z));
  const MINY = Math.floor(lat2yFrac(config.BBOX.N, config.Z));
  const MAXY = Math.floor(lat2yFrac(config.BBOX.S, config.Z));
  const TILEPX = config.TILE * config.SCALE;
  const CANVAS_W = (MAXX - MINX + 1) * TILEPX;
  const CANVAS_H = (MAXY - MINY + 1) * TILEPX;
  const TILE_LIST = [];
  for (let tx = MINX; tx <= MAXX; tx++) { for (let ty = MINY; ty <= MAXY; ty++) { TILE_LIST.push([tx, ty]); } }
  return { MINX, MAXX, MINY, MAXY, TILEPX, CANVAS_W, CANVAS_H, TILE_LIST };
}

function px(grid, tx, lx, ext) { return (tx - grid.MINX) * grid.TILEPX + (lx / ext) * grid.TILEPX; }
function py(grid, ty, ly, ext) { return (ty - grid.MINY) * grid.TILEPX + (ly / ext) * grid.TILEPX; }
function lonLatToCanvas(config, grid, lon, lat) {
  return { x: (lon2xFrac(lon, config.Z) - grid.MINX) * grid.TILEPX, y: (lat2yFrac(lat, config.Z) - grid.MINY) * grid.TILEPX };
}

function polyPath(features, grid) {
  const path = new Path2D();
  for (const f of features) {
    for (const ring of f.geom) {
      ring.forEach((pt, i) => {
        const x = px(grid, f.tx, pt.x, f.ext), y = py(grid, f.ty, pt.y, f.ext);
        if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
      });
      path.closePath();
    }
  }
  return path;
}

// ============================================================================
// SMALL SHARED HELPERS
// ============================================================================
// mulberry32 — seeded PRNG so torn washi edges (and any other stochastic art)
// are deterministic run-to-run.
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic per-feature Rough.js seed (plan constraint: strokes stable
// across repaints — only the route deliberately re-sketches at M2).
function featureSeed(C, idx) { return ((C.STROKE_SEED + 1) * 7919 + idx * 104729) % 2147483647 + 1; }

// Smooth stroke through points via Catmull-Rom -> cubic bezier (no jitter).
function strokeSmoothPath(ctx, pts, width, color, alpha) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) { ctx.lineTo(pts[1].x, pts[1].y); }
  else {
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
    }
  }
  ctx.stroke(); ctx.restore();
}

// fine blue marker: soft wide bleed under-stroke + crisp core.
function drawMarkerRoute(ctx, pts, C, D) {
  strokeSmoothPath(ctx, pts, D.routeBleed, C.COLORS.routeLine, C.ROUTE_BLEED_ALPHA);
  strokeSmoothPath(ctx, pts, D.routeWidth, C.COLORS.routeLine, 1);
}

// M2 — ROAD-FOLLOWING PEN PATH. Given visit-ordered pin positions and
// optional per-leg road polylines ([lng,lat] arrays aligned to consecutive
// pairs; a null leg falls back to its straight chord), build the single pen
// polyline in canvas px: project, snap each leg's endpoints onto the pins
// (the road snap point rarely equals the stop coordinate — visible gaps
// otherwise), and thin points closer than minGapPx so the Catmull-Rom stroke
// keeps its hand-drawn feel instead of tracing every survey jag.
function buildRoutePath(routeTruePts, legGeometries, config, grid, minGapPx) {
  if (!legGeometries || !legGeometries.length) return routeTruePts.slice();
  const out = [];
  const push = (p) => {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minGapPx) out.push(p);
  };
  for (let i = 0; i < routeTruePts.length - 1; i++) {
    const a = routeTruePts[i], b = routeTruePts[i + 1];
    const leg = legGeometries[i];
    if (Array.isArray(leg) && leg.length >= 2) {
      const pts = leg.map(([lon, lat]) => lonLatToCanvas(config, grid, lon, lat));
      pts[0] = { x: a.x, y: a.y };
      pts[pts.length - 1] = { x: b.x, y: b.y };
      for (const p of pts) push(p);
    } else {
      push(a); push(b);
    }
    const lastOut = out[out.length - 1];
    if (!lastOut || lastOut.x !== b.x || lastOut.y !== b.y) out.push({ x: b.x, y: b.y });
  }
  if (!out.length || out[0].x !== routeTruePts[0].x || out[0].y !== routeTruePts[0].y) {
    out.unshift({ x: routeTruePts[0].x, y: routeTruePts[0].y });
  }
  return out;
}

// M2 — draw-on support: the prefix of `pts` covering fraction p (0..1) of the
// path's arc length, with an interpolated tip point. p>=1 returns pts as-is.
function trimPathByProgress(pts, p) {
  if (p >= 1 || pts.length < 2) return pts;
  if (p <= 0) return [pts[0]];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const target = cum[cum.length - 1] * p;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] <= target) { out.push(pts[i]); continue; }
    const seg = cum[i] - cum[i - 1];
    const f = seg > 0 ? (target - cum[i - 1]) / seg : 0;
    out.push({
      x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
      y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f,
    });
    break;
  }
  return out;
}

// ============================================================================
// TEXT HELPERS — optical centering + explicit state, no leaked canvas state.
// ============================================================================
function fontStr(style, sizePx, family) {
  return (style ? style + ' ' : '') + sizePx + 'px ' + family;
}

// Draw text whose MEASURED glyph box is centered on (x, y) — not the em box
// (em-box 'middle' centering is why lettering used to sit low in pins/tape).
// alsoX additionally centers the visual box horizontally — worth it for
// single digits, whose side bearings are lopsided in hand fonts.
function textOpticalOffsets(ctx, text, alsoX) {
  const m = ctx.measureText(text);
  if (m.actualBoundingBoxAscent == null) return null; // engine without the API
  return {
    dy: (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2,
    dx: alsoX ? (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2 : 0,
  };
}
function fillTextOptical(ctx, text, x, y, alsoX) {
  const o = textOpticalOffsets(ctx, text, alsoX);
  if (!o) {
    const prev = ctx.textBaseline;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.textBaseline = prev;
    return;
  }
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x + o.dx, y + o.dy);
}
function strokeTextOptical(ctx, text, x, y, alsoX) {
  const o = textOpticalOffsets(ctx, text, alsoX);
  if (!o) {
    const prev = ctx.textBaseline;
    ctx.textBaseline = 'middle';
    ctx.strokeText(text, x, y);
    ctx.textBaseline = prev;
    return;
  }
  ctx.textBaseline = 'alphabetic';
  ctx.strokeText(text, x + o.dx, y + o.dy);
}

// ============================================================================
// WASHI TAPE — board-faithful: content-sized, slightly tilted, torn ENDS only
// (long edges straight, no perimeter outline), circled stop number + 'Booked'
// hand-lettered in ink, optional gingham/stripes pattern. Placement is
// collision-tested by planWashiTag; drawWashiTag renders a computed plan.
// ============================================================================

// Torn short edge: multi-scale jitter (coarse tear + fine fiber serration),
// walking top->bottom at x0 in LOCAL tape coords. Returns the polyline points.
function tornEdge(x0, top, bot, segs, ampCoarse, ampFine, rng, dir) {
  const pts = [];
  let coarsePrev = (rng() * 2 - 1) * ampCoarse, coarseNext = (rng() * 2 - 1) * ampCoarse;
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    // low-frequency tear (interpolated so neighbours cohere) + high-frequency fiber nicks
    if (i % 3 === 0) { coarsePrev = coarseNext; coarseNext = (rng() * 2 - 1) * ampCoarse; }
    const coarse = coarsePrev + (coarseNext - coarsePrev) * ((i % 3) / 3);
    const fine = (rng() * 2 - 1) * ampFine;
    pts.push({ x: x0 + dir * Math.abs(coarse) + fine, y: top + (bot - top) * t });
  }
  return pts;
}

// Local-space torn tape outline: (0,0) is the tape center; w/h full size.
// dir on each end points INWARD so tears bite into the tape (like real rips).
function tapeOutline(w, h, C, D, rng) {
  const L = -w / 2, R = w / 2, T = -h / 2, B = h / 2;
  const pts = [{ x: L, y: T }, { x: R, y: T }]; // top edge straight L->R
  pts.push(...tornEdge(R, T, B, C.WASHI.tearSegs, D.washiTearAmp, D.washiTearFine, rng, -1)); // right end
  pts.push({ x: R, y: B }, { x: L, y: B }); // bottom edge straight R->L
  pts.push(...tornEdge(L, B, T, C.WASHI.tearSegs, D.washiTearAmp, D.washiTearFine, rng, +1)); // left end
  return pts;
}

// Measure the tape's label ("④ Booked" = circled index + word) and produce
// the placed, rotated tape plan: center, size, corners, AABB. Placement tries
// candidate anchors around the pin (below, above, right, left, below-far) and
// takes the first whose AABB hits no pin disc and stays inside the crop.
// The tape MAY lie across the route line — that is what tape does — but never
// covers a pin and never leaves the frame.
function planWashiTag(ctx, C, D, pinPos, allPinDiscs, cropInset, numText, wordText) {
  ctx.font = fontStr('', D.washiFont, C.FONT_FAMILY_HAND);
  const circleR = D.washiFont * (numText.length > 1 ? 0.98 : 0.78); // 2-digit stops need a wider ring
  const gap = D.washiFont * 0.42;
  const bookedW = ctx.measureText(wordText).width;
  const innerW = circleR * 2 + gap + bookedW;
  const w = Math.max(D.washiMinW, Math.min(D.washiMaxW, innerW + 2 * D.washiPadX));
  const h = D.washiH;
  const angle = (C.WASHI.angleDeg * Math.PI) / 180;

  const dist = h * D.washiOffset + D.pinDiam / 2;
  const candidates = [
    { dx: 0, dy: dist + h / 2 },            // below the pin (board's choice)
    { dx: 0, dy: -(dist + h / 2) },         // above
    { dx: dist + w / 2, dy: 0 },            // right
    { dx: -(dist + w / 2), dy: 0 },         // left
    { dx: 0, dy: dist + h * 1.6 },          // farther below
  ];

  const corners = (cx, cy) => {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const m = D.washiTearAmp + D.washiTearFine; // tear can poke past the rect
    return [[-w / 2 - m, -h / 2], [w / 2 + m, -h / 2], [w / 2 + m, h / 2], [-w / 2 - m, h / 2]]
      .map(([lx, ly]) => ({ x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos }));
  };
  const aabbOf = (cs) => ({
    x0: Math.min(...cs.map(c => c.x)), y0: Math.min(...cs.map(c => c.y)),
    x1: Math.max(...cs.map(c => c.x)), y1: Math.max(...cs.map(c => c.y)),
  });

  let best = null;
  for (const cand of candidates) {
    const cx = pinPos.x + cand.dx, cy = pinPos.y + cand.dy;
    const box = aabbOf(corners(cx, cy));
    const hitsPin = allPinDiscs.some((p) => {
      const nx = Math.max(box.x0, Math.min(p.x, box.x1)), ny = Math.max(box.y0, Math.min(p.y, box.y1));
      return (nx - p.x) * (nx - p.x) + (ny - p.y) * (ny - p.y) < p.r * p.r;
    });
    const inFrame = box.x0 >= cropInset.x0 && box.x1 <= cropInset.x1 && box.y0 >= cropInset.y0 && box.y1 <= cropInset.y1;
    if (!hitsPin && inFrame) { best = { cx, cy, box }; break; }
    if (!best) best = { cx, cy, box }; // keep the first as a fallback
  }

  return {
    cx: best.cx, cy: best.cy, w, h, angle, aabb: best.box,
    circleR, gap, bookedW, innerW, numText, wordText,
  };
}

function drawWashiTag(ctx, rc, C, D, plan) {
  const rng = makeRng(C.WASHI.seed);
  const pts = tapeOutline(plan.w, plan.h, C, D, rng);
  // M2 settle animation: paintOverlay sets alphaMul while the tape "presses
  // down" onto the page; 1 (or absent) is the resting state.
  const aMul = plan.alphaMul != null ? plan.alphaMul : 1;

  ctx.save();
  ctx.translate(plan.cx, plan.cy);
  ctx.rotate(plan.angle);

  const path = new Path2D();
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  path.closePath();

  // tape body — near-opaque like the board; the dial stays for the studio
  ctx.globalAlpha = C.WASHI.alpha * aMul;
  ctx.fillStyle = C.COLORS.washiFill;
  ctx.fill(path);

  // optional pattern, clipped to the tape (subtle, token-color-safe)
  if (C.WASHI.pattern && C.WASHI.pattern !== 'plain') {
    ctx.save();
    ctx.clip(path);
    ctx.globalAlpha = C.WASHI.alpha * C.WASHI.patternAlpha * aMul;
    ctx.fillStyle = C.COLORS.washiPatternTint || '#FFFFFF'; // tint bar over the token fill, not a new hue
    const pitch = plan.h / 3.2, bar = pitch * 0.42;
    for (let x = -plan.w / 2 - pitch; x < plan.w / 2 + pitch; x += pitch) {
      ctx.fillRect(x, -plan.h / 2, bar, plan.h);
    }
    if (C.WASHI.pattern === 'gingham') {
      for (let y = -plan.h / 2; y < plan.h / 2 + pitch; y += pitch) {
        ctx.fillRect(-plan.w / 2, y, plan.w, bar);
      }
    }
    ctx.restore();
  }

  // faint top sheen — OFF by default (board tape is matte); dial preserved
  if (C.WASHI.sheenAlpha > 0) {
    ctx.globalAlpha = C.WASHI.sheenAlpha * aMul;
    ctx.fillStyle = C.COLORS.washiSheen;
    ctx.fillRect(-plan.w / 2, -plan.h / 2, plan.w, plan.h * 0.45);
  }

  // tear shading on the torn ENDS only — never a full-perimeter outline
  ctx.globalAlpha = aMul;
  ctx.lineWidth = D.washiEdge;
  ctx.strokeStyle = C.COLORS.washiShade;
  const segs = C.WASHI.tearSegs;
  const right = new Path2D(), left = new Path2D();
  // pts layout: [TL, TR, ...right tear (segs-1)..., BR, BL, ...left tear (segs-1)...]
  const rStart = 1, rEnd = 1 + (segs - 1) + 1; // TR .. BR inclusive
  right.moveTo(pts[rStart].x, pts[rStart].y);
  for (let i = rStart + 1; i <= rEnd; i++) right.lineTo(pts[i].x, pts[i].y);
  const lStart = rEnd + 1; // BL
  left.moveTo(pts[lStart].x, pts[lStart].y);
  for (let i = lStart + 1; i < pts.length; i++) left.lineTo(pts[i].x, pts[i].y);
  left.lineTo(pts[0].x, pts[0].y);
  ctx.stroke(right);
  ctx.stroke(left);

  // "④ Booked" — circled stop number + word, hand font, ink, optical centering
  ctx.globalAlpha = aMul;
  const startX = -plan.innerW / 2;
  const circleCx = startX + plan.circleR;
  // NOTE: no `fill` key at all — rough.js treats the string 'none' as a real
  // fill color and paints a stray hachure line through the digit.
  rc.circle(circleCx, 0, plan.circleR * 2, {
    stroke: C.COLORS.pinStroke, strokeWidth: Math.max(1, D.pinStroke * 0.75),
    roughness: 0.6, disableMultiStroke: true, seed: featureSeed(C, 991),
  });
  ctx.fillStyle = C.COLORS.pinStroke;
  ctx.textAlign = 'center';
  ctx.font = fontStr('', D.washiFont * 0.92, C.FONT_FAMILY_HAND);
  fillTextOptical(ctx, plan.numText, circleCx, 0, true);
  ctx.textAlign = 'left';
  ctx.font = fontStr('', D.washiFont, C.FONT_FAMILY_HAND);
  fillTextOptical(ctx, plan.wordText, startX + plan.circleR * 2 + plan.gap, 0);
  ctx.restore();
}

// ============================================================================
// LABEL SUBSYSTEM — governs all map text so it curves/rotates to fit the
// geography and never overlaps (incl. the route pins/washi and the frame
// edge). Crowding policy: TRIP OVERLAY WINS — route/pins/washi never yield;
// basemap text nudges, shrinks, slides, and finally drops.
//   layoutWaterLabels() — curved water-body labels (called AFTER route/pins)
//   layoutPointLabels() — point-label collision pass (occupied-region aware)
//   drawStraightLabel() — axis-aligned fallback when a robust spine fails
//   + PCA / spine / arc-length geometry helpers
// ============================================================================

// Principal axis via PCA — covariance of points -> dominant eigenvector.
function pca2d(points) {
  const n = points.length; let mx = 0, my = 0;
  for (const p of points) { mx += p.x; my += p.y; } mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  sxx /= n; sxy /= n; syy /= n;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  let ex, ey;
  if (Math.abs(sxy) > 1e-6) { ex = l1 - syy; ey = sxy; }
  else if (sxx >= syy) { ex = 1; ey = 0; } else { ex = 0; ey = 1; }
  const len = Math.hypot(ex, ey) || 1; ex /= len; ey /= len;
  return { mean: { x: mx, y: my }, axis: [ex, ey], lambda1: l1, lambda2: l2, angle: Math.atan2(ey, ex) };
}

// Centerline spine: project points onto principal axis, bin along it, take the
// mean point per bucket (averages both shores -> channel centerline), trim the
// ends so text sits inside the body, then lightly smooth.
function buildSpine(points, pca, buckets, trimFrac, smoothPasses) {
  const { mean, axis } = pca;
  const proj = points.map((p) => ({ t: (p.x - mean.x) * axis[0] + (p.y - mean.y) * axis[1], p }));
  let tmin = Infinity, tmax = -Infinity;
  for (const o of proj) { if (o.t < tmin) tmin = o.t; if (o.t > tmax) tmax = o.t; }
  const span = tmax - tmin; if (!(span > 0)) return [];
  const lo = tmin + span * trimFrac, hi = tmax - span * trimFrac, w = (hi - lo) / buckets;
  const bx = new Array(buckets).fill(0), by = new Array(buckets).fill(0), bn = new Array(buckets).fill(0);
  for (const o of proj) {
    if (o.t < lo || o.t > hi) continue;
    let bi = Math.floor((o.t - lo) / w); if (bi < 0) bi = 0; if (bi >= buckets) bi = buckets - 1;
    bx[bi] += o.p.x; by[bi] += o.p.y; bn[bi]++;
  }
  let spine = [];
  for (let i = 0; i < buckets; i++) if (bn[i] > 0) spine.push({ x: bx[i] / bn[i], y: by[i] / bn[i] });
  for (let s = 0; s < smoothPasses; s++) {
    spine = spine.map((p, i) => { const a = spine[i - 1] || p, b = spine[i + 1] || p; return { x: (a.x + p.x + b.x) / 3, y: (a.y + p.y + b.y) / 3 }; });
  }
  if (spine.length >= 2 && spine[0].x > spine[spine.length - 1].x) spine.reverse(); // read L->R
  return spine;
}

function buildArc(spine) {
  const cum = [0];
  for (let i = 1; i < spine.length; i++) cum.push(cum[i - 1] + Math.hypot(spine[i].x - spine[i - 1].x, spine[i].y - spine[i - 1].y));
  return { spine, cum, total: cum[cum.length - 1] };
}
function sampleArc(arc, s) {
  const { spine, cum, total } = arc; if (s < 0) s = 0; if (s > total) s = total;
  let i = 1; while (i < cum.length && cum[i] < s) i++; if (i >= cum.length) i = cum.length - 1;
  const s0 = cum[i - 1], s1 = cum[i], f = s1 > s0 ? (s - s0) / (s1 - s0) : 0, a = spine[i - 1], b = spine[i];
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, angle: Math.atan2(b.y - a.y, b.x - a.x) };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Arc-length position on the spine nearest a given canvas point. Used so
// curved text can be centered on the anchor (the OSM water_name point, always
// ON its own water body) instead of the spine's raw arc midpoint — which can
// drift over land when the local PCA cloud blends multiple nearby water
// bodies (see WATER_LABEL.cloudRadiusFrac).
function nearestArcLength(arc, p) {
  const { spine, cum } = arc;
  let best = 0, bestD2 = Infinity;
  for (let i = 0; i < spine.length; i++) {
    const dx = spine[i].x - p.x, dy = spine[i].y - p.y, d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = cum[i]; }
  }
  return best;
}

// Point-based blocker test for curved-label glyphs: true circles for pins
// (their actual visual disc + a small margin) and the washi AABB (+ margin).
function glyphBlocked(x, y, blockers) {
  if (!blockers) return false;
  for (const c of blockers.pins) { const dx = x - c.x, dy = y - c.y; if (dx * dx + dy * dy <= c.r * c.r) return true; }
  const w = blockers.washi;
  if (w && x >= w.x0 && x <= w.x1 && y >= w.y0 && y <= w.y1) return true;
  return false;
}

function boxOverlap(a, b) { return !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0); }
function boxInside(a, r) { return a.x0 >= r.x0 && a.y0 >= r.y0 && a.x1 <= r.x1 && a.y1 <= r.y1; }

// Measure a curved label at `size`: per-glyph widths + candidate glyph
// geometry (positions, tangent angles, boxes) for a window starting at arc
// position `start`. Angles are neighbor-smoothed so lettering doesn't kink
// on a coarse spine.
function measureCurvedWindow(ctx, chars, size, ls, arc, start) {
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + ls * (chars.length - 1);
  const glyphs = [];
  let cursor = start;
  for (let i = 0; i < chars.length; i++) {
    const w = widths[i];
    const s = sampleArc(arc, cursor + w / 2);
    const half = Math.max(w, size) * 0.62;
    glyphs.push({
      ch: chars[i], x: s.x, y: s.y, angle: s.angle,
      box: { x0: s.x - half, y0: s.y - half, x1: s.x + half, y1: s.y + half },
    });
    cursor += w + ls;
  }
  // smooth glyph angles (moving average, one pass) — kills spine-bucket kinks
  for (let pass = 0; pass < 1; pass++) {
    const angles = glyphs.map((g) => g.angle);
    for (let i = 0; i < glyphs.length; i++) {
      const a = angles[i - 1] != null ? angles[i - 1] : angles[i];
      const b = angles[i + 1] != null ? angles[i + 1] : angles[i];
      // average via vectors so ±π wraps don't explode
      const vx = Math.cos(a) + Math.cos(angles[i]) * 2 + Math.cos(b);
      const vy = Math.sin(a) + Math.sin(angles[i]) * 2 + Math.sin(b);
      glyphs[i].angle = Math.atan2(vy, vx);
    }
  }
  return { total, glyphs };
}

// Find a clear window for the whole word: try the anchor position first, then
// slide along the channel, then shrink a step and repeat. NEVER drops glyphs
// mid-word — if no window fits, the caller falls back (straight label / skip).
function planCurvedLabel(ctx, text, arc, cfg, D, anchor, blockers, occupied, cropInset) {
  const chars = [...text];
  // auto-size from the spine length (measure at fontBase, scale to fillFrac)
  ctx.font = fontStr(cfg.fontStyle, D.wlFontBase, cfg.fontFamily);
  let base = 0; for (const c of chars) base += ctx.measureText(c).width;
  base += D.wlLetterSpacing * (chars.length - 1);
  const autoSize = (D.wlFontBase * (arc.total * cfg.fillFrac)) / (base || 1);

  const slides = [0, -0.06, 0.06, -0.12, 0.12, -0.2, 0.2, -0.3, 0.3];
  for (const mul of [1, 0.88, 0.78, 0.7]) {
    const size = clamp(autoSize * mul, D.wlFontMin, D.wlFontMax);
    ctx.font = fontStr(cfg.fontStyle, size, cfg.fontFamily);
    const probe = measureCurvedWindow(ctx, chars, size, D.wlLetterSpacing, arc, 0);
    if (probe.total > arc.total * 0.97) continue; // word longer than the water body at this size
    const sAnchor = anchor ? nearestArcLength(arc, anchor) : arc.total / 2;
    for (const off of slides) {
      const start = clamp(sAnchor - probe.total / 2 + off * arc.total, 0, arc.total - probe.total);
      const win = measureCurvedWindow(ctx, chars, size, D.wlLetterSpacing, arc, start);
      let ok = true;
      for (const g of win.glyphs) {
        if (glyphBlocked(g.x, g.y, blockers)) { ok = false; break; }
        if (!boxInside(g.box, cropInset)) { ok = false; break; }
        for (const pb of occupied) { if (boxOverlap(g.box, pb)) { ok = false; break; } }
        if (!ok) break;
      }
      if (ok) return { size, glyphs: win.glyphs };
    }
  }
  return null;
}

function drawCurvedPlanned(ctx, plan, cfg, D) {
  ctx.font = fontStr(cfg.fontStyle, plan.size, cfg.fontFamily);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  for (const g of plan.glyphs) {
    ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(g.angle);
    ctx.lineWidth = D.wlHalo; ctx.strokeStyle = cfg.halo; ctx.strokeText(g.ch, 0, 0);
    ctx.fillStyle = cfg.fill; ctx.fillText(g.ch, 0, 0);
    ctx.restore();
  }
}

// Fallback: whole label rotated to the principal-axis angle (straight, still
// axis-aligned — far better than horizontal when a spine can't be built).
function drawStraightLabel(ctx, text, x, y, angle, cfg, sizePx, D) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
  ctx.font = fontStr(cfg.fontStyle, sizePx, cfg.fontFamily);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.lineWidth = D.wlHalo; ctx.strokeStyle = cfg.halo; ctx.strokeText(text, 0, 0);
  ctx.fillStyle = cfg.fill; ctx.fillText(text, 0, 0);
  ctx.restore();
}

// (a) WATER-BODY curved labels. waterCloud = ALL water ring vertices in canvas
// px; each label pulls its own local subset within a radius (survives MVT
// tile-clipping). waterNameFeatures carries a precomputed canvas-space anchor
// point (pt). Labels avoid pins/washi (blockers), everything already placed
// (occupied, incl. point labels and the route), each other, and the frame.
function layoutWaterLabels(ctx, opts) {
  const { waterNameFeatures, waterCloud, canvasW, blockers, occupied, cropInset, C, D } = opts;
  const wl = C.WATER_LABEL;
  const R = wl.cloudRadiusFrac * canvasW, R2 = R * R;
  const seenW = new Set();
  let curved = 0, straight = 0, skippedW = 0;
  for (const f of waterNameFeatures) {
    const text = f.props['name:en'] || f.props['name']; if (!text || seenW.has(text)) continue; seenW.add(text);
    const p = f.pt;
    const cloud = [];
    for (const q of waterCloud) { const dx = q.x - p.x, dy = q.y - p.y; if (dx * dx + dy * dy <= R2) cloud.push(q); }
    const cfg = { ...wl, fill: C.COLORS.waterNameText, halo: C.COLORS.paperHalo };
    if (cloud.length >= wl.minCloud) {
      const pca = pca2d(cloud);
      const spine = buildSpine(cloud, pca, wl.buckets, wl.trim, wl.smoothPasses);
      if (spine.length >= 2) {
        const arc = buildArc(spine);
        if (arc.total > 20) {
          const plan = planCurvedLabel(ctx, text, arc, cfg, D, p, blockers, occupied, cropInset);
          if (plan) {
            drawCurvedPlanned(ctx, plan, cfg, D);
            for (const g of plan.glyphs) occupied.push(g.box); // later labels avoid this one
            curved++;
            continue;
          }
        }
      }
      // no clear curved window — try a straight fallback if ITS box is clear.
      // The fallback DRAWS rotated to pca.angle, so test the ROTATED extents
      // (review finding: a steep water body could pass an axis-aligned test
      // yet draw past the frame or onto a pin).
      const size = clamp(D.wlFontBase, D.wlFontMin, D.wlFontMax);
      ctx.font = fontStr(cfg.fontStyle, size, cfg.fontFamily);
      const m = ctx.measureText(text);
      const hw = m.width / 2 + D.plHaloPad, hh = size * 0.75;
      const rcos = Math.abs(Math.cos(pca.angle)), rsin = Math.abs(Math.sin(pca.angle));
      const hx = rcos * hw + rsin * hh, hy = rsin * hw + rcos * hh;
      const box = { x0: p.x - hx, y0: p.y - hy, x1: p.x + hx, y1: p.y + hy };
      const clear = boxInside(box, cropInset) && !occupied.some((pb) => boxOverlap(box, pb)) &&
        !glyphBlocked(p.x, p.y, blockers);
      if (clear) {
        drawStraightLabel(ctx, text, p.x, p.y, pca.angle, cfg, size, D);
        occupied.push(box);
        straight++;
      } else { skippedW++; } // trip overlay wins — water name is decor
      continue;
    }
    skippedW++; // not enough local water to place respectfully
  }
  return { waterCurved: curved, waterStraight: straight, waterSkipped: skippedW };
}

// ---------------------------------------------------------------------------
// POINT (city/town) labels — greedy collision avoidance with nudges (incl.
// diagonals), stepwise shrink, two-line wrapping for long names, an edge
// margin so nothing slices at the frame, and a density cap (route map, not a
// street atlas). opts.occupied is pre-seeded with pins + washi + the route
// line, and this pass PUSHES every placed label box into it (shared with the
// water pass that runs later).
// ---------------------------------------------------------------------------
function splitTwoLines(text) {
  const idx = [];
  for (let i = 0; i < text.length; i++) if (text[i] === ' ') idx.push(i);
  if (!idx.length) return null;
  let best = idx[0], bestDiff = Infinity;
  for (const i of idx) {
    const diff = Math.abs(i - (text.length - i - 1));
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return [text.slice(0, best), text.slice(best + 1)];
}

function measurePointLabel(ctx, lines, sizePx, family, pad) {
  ctx.font = fontStr('', sizePx, family);
  const lineH = sizePx * 1.12;
  let w = 0;
  for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
  const h = lineH * lines.length;
  return { w, h, lineH, box: (x, y) => ({ x0: x - w / 2 - pad, y0: y - h / 2 - pad, x1: x + w / 2 + pad, y1: y + h / 2 + pad }) };
}

function drawPointLabel(ctx, lines, x, y, sizePx, family, fill, halo, haloW, lineH) {
  ctx.font = fontStr('', sizePx, family);
  ctx.textAlign = 'center'; ctx.lineJoin = 'round';
  const y0 = y - (lineH * (lines.length - 1)) / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.lineWidth = haloW; ctx.strokeStyle = halo;
    strokeTextOptical(ctx, lines[i], x, y0 + i * lineH);
    ctx.fillStyle = fill;
    fillTextOptical(ctx, lines[i], x, y0 + i * lineH);
  }
}

function layoutPointLabels(ctx, opts) {
  const { placeFeatures, occupied, cropInset, C, D } = opts;
  const pl = C.POINT_LABEL;
  const classOrder = { city: 0, town: 1 };
  const seenP = new Set(), cands = [];
  for (const f of placeFeatures) {
    const cls = f.props['class']; if (!(cls in classOrder)) continue;
    const text = f.props['name:en'] || f.props['name']; if (!text || seenP.has(text)) continue; seenP.add(text);
    const rank = f.props['rank'] != null ? f.props['rank'] : 99;
    cands.push({ text, x: f.pt.x, y: f.pt.y, order: classOrder[cls], rank, len: text.length });
  }
  cands.sort((a, b) => a.order - b.order || a.rank - b.rank || a.len - b.len || a.text.localeCompare(b.text));
  // the fetch footprint is far wider than the visible crop — the density cap
  // must ration IN-VIEW labels, not hand the budget to off-screen anchors
  const inView = cands.filter((c) =>
    c.x >= cropInset.x0 - D.plFont * 4 && c.x <= cropInset.x1 + D.plFont * 4 &&
    c.y >= cropInset.y0 - D.plFont * 4 && c.y <= cropInset.y1 + D.plFont * 4);
  const capped = inView.slice(0, pl.maxLabels);

  const shrinkSteps = [1];
  if (pl.shrinkFloor < 1) { shrinkSteps.push((1 + pl.shrinkFloor) / 2, pl.shrinkFloor); }

  let placedCount = 0, skipped = 0;
  for (const c of capped) {
    let done = false;
    for (const mul of shrinkSteps) {
      const size = D.plFont * mul;
      // layout preference: single line, unless the name is long — then the
      // board's answer is a stacked two-liner (see its mosque label)
      ctx.font = fontStr('', size, C.FONT_FAMILY_HAND);
      const oneLineW = ctx.measureText(c.text).width;
      const layouts = [];
      const two = splitTwoLines(c.text);
      if (oneLineW > D.plTwoLineMaxW && two) layouts.push(two, [c.text]);
      else { layouts.push([c.text]); if (two && oneLineW > D.plTwoLineMaxW * 0.8) layouts.push(two); }

      for (const lines of layouts) {
        const mm = measurePointLabel(ctx, lines, size, C.FONT_FAMILY_HAND, D.plHaloPad);
        for (const [ox, oy] of pl.nudges) {
          const x = c.x + ox * size * pl.nudgeStep, y = c.y + oy * size * pl.nudgeStep;
          const box = mm.box(x, y);
          if (!boxInside(box, cropInset)) continue;
          let hit = false;
          for (const pb of occupied) { if (boxOverlap(box, pb)) { hit = true; break; } }
          if (!hit) {
            occupied.push(box);
            drawPointLabel(ctx, lines, x, y, size, C.FONT_FAMILY_HAND, C.COLORS.ink, C.COLORS.paperHalo, D.plHalo, mm.lineH);
            done = true; placedCount++;
            break;
          }
        }
        if (done) break;
      }
      if (done) break;
    }
    if (!done) skipped++; // all candidate positions collide -> drop (no overlaps in output)
  }
  return { pointsPlaced: placedCount, pointsSkipped: skipped };
}

// ---------------------------------------------------------------------------
// PIN DECLUTTER — overlapping pins (real trips put stops close together) get
// pushed apart deterministically; a short ink leader + dot marks the true
// location of any displaced pin. Returns draw positions aligned by index.
// ---------------------------------------------------------------------------
function resolvePinPositions(truePts, D, declutter) {
  if (!declutter) return truePts.map((p) => ({ ...p, moved: false }));
  const minDist = D.pinDiam + D.pinGap;
  const placed = [];
  for (const p of truePts) {
    const pos = { x: p.x, y: p.y };
    for (let iter = 0; iter < 4; iter++) {
      let pushed = false;
      for (const q of placed) {
        const dx = pos.x - q.x, dy = pos.y - q.y;
        const d = Math.hypot(dx, dy);
        if (d < minDist) {
          const ux = d > 1e-3 ? dx / d : 1, uy = d > 1e-3 ? dy / d : 0;
          pos.x = q.x + ux * minDist; pos.y = q.y + uy * minDist;
          pushed = true;
        }
      }
      if (!pushed) break;
    }
    placed.push(pos);
  }
  return truePts.map((p, i) => ({
    x: placed[i].x, y: placed[i].y,
    moved: Math.hypot(placed[i].x - p.x, placed[i].y - p.y) > D.pinDiam * 0.35,
    trueX: p.x, trueY: p.y,
  }));
}

// Sample the route polyline into small occupied boxes so labels keep clear of
// the pen line (the tape may cross it; text may not).
function routeOccupiedBoxes(pts, D) {
  const boxes = [];
  const half = D.routeBleed / 2 + D.plRoutePad;
  const step = Math.max(12, D.pinDiam * 0.9);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / step));
    for (let j = 0; j <= n; j++) {
      const x = a.x + ((b.x - a.x) * j) / n, y = a.y + ((b.y - a.y) * j) / n;
      boxes.push({ x0: x - half, y0: y - half, x1: x + half, y1: y + half });
    }
  }
  return boxes;
}

// ============================================================================
// fetchAndDecode(config, opts?) -> Decoded
// TileJSON fetch -> tile fetch -> MVT decode (Pbf + @mapbox/vector-tile).
// Cached per view: memoized on {Z, BBOX, TILE, SCALE, EXTENT_FALLBACK} so a
// studio can call this freely after a non-view control change (color, width,
// label tuning, ...) and get the same decoded geometry back instantly instead
// of re-fetching over the network. Pass {force:true} to bypass the cache.
// ============================================================================
const _decodeCache = new Map();
function viewKey(config) {
  return JSON.stringify({
    Z: config.Z, BBOX: config.BBOX, TILE: config.TILE, SCALE: config.SCALE,
    EXTENT_FALLBACK: config.EXTENT_FALLBACK,
  });
}
export function clearDecodeCache() { _decodeCache.clear(); }

export async function fetchAndDecode(config, opts = {}) {
  const key = viewKey(config);
  if (!opts.force && _decodeCache.has(key)) return _decodeCache.get(key);

  const p = (async () => {
    const { Pbf, VectorTile } = await preloadLibs();
    const grid = computeGrid(config);

    const tjResp = await fetch(config.TILEJSON_URL || 'https://tiles.openfreemap.org/planet');
    if (!tjResp.ok) throw new Error('TileJSON fetch failed: HTTP ' + tjResp.status);
    const tj = await tjResp.json();
    if (!tj || !Array.isArray(tj.tiles) || !tj.tiles.length) throw new Error('TileJSON missing tiles[]: ' + JSON.stringify(tj).slice(0, 300));
    const template = tj.tiles[0];

    const LAYER_NAMES = config.LAYER_NAMES || ['water', 'waterway', 'landcover', 'park', 'transportation', 'place', 'water_name'];
    const layers = Object.fromEntries(LAYER_NAMES.map((n) => [n, []]));
    const tilesFailed = [];
    let tilesFetched = 0;

    await Promise.all(grid.TILE_LIST.map(async ([tx, ty]) => {
      const url = template.replace('{z}', config.Z).replace('{x}', tx).replace('{y}', ty);
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
        const buf = await resp.arrayBuffer();
        const vt = new VectorTile(new Pbf(new Uint8Array(buf)));
        for (const name of LAYER_NAMES) {
          const layer = vt.layers[name];
          if (!layer) continue;
          const ext = layer.extent || config.EXTENT_FALLBACK;
          for (let i = 0; i < layer.length; i++) {
            const f = layer.feature(i);
            layers[name].push({ tx, ty, ext, props: f.properties, geom: f.loadGeometry() });
          }
        }
        tilesFetched++;
      } catch (e) {
        tilesFailed.push({ tx, ty, error: String((e && e.message) || e) });
      }
    }));

    const layerCounts = Object.fromEntries(LAYER_NAMES.map((n) => [n, layers[n].length]));
    return {
      layers, layerCounts, grid,
      MINX: grid.MINX, MAXX: grid.MAXX, MINY: grid.MINY, MAXY: grid.MAXY, TILEPX: grid.TILEPX,
      CANVAS_W: grid.CANVAS_W, CANVAS_H: grid.CANVAS_H,
      tilesFetched, tilesFailed, tileTemplate: template,
    };
  })();

  _decodeCache.set(key, p);
  try { return await p; } catch (e) { _decodeCache.delete(key); throw e; } // don't poison the cache with a failed fetch
}

// ============================================================================
// buildScene(config, decoded, textures) -> Scene
// Paints the BASE layer once onto a detached working canvas at the full
// fetched-grid size: land -> water/coast/waterway -> parks -> roads -> point
// labels -> weathering/vignette -> curved water labels — then snapshots it.
// Label collision runs against the INITIAL route/pins/washi geometry from
// config.ROUTE_POINTS/WASHI_INDEX (pin POSITIONS are order-independent; only
// the pen path and numbering change on reorder, and the overlay redraws those
// on top of the snapshot without re-laying labels — the plan's "basemap never
// re-renders on reorder" rule).
// ============================================================================
export async function buildScene(rawConfig, decoded, textures, opts = {}) {
  const { rough } = await preloadLibs();
  const config = upgradeConfig(rawConfig);
  const grid = decoded.grid || computeGrid(config);
  const { CANVAS_W, CANVAS_H, layers } = decoded;
  const D = deriveSizes(config, grid.TILEPX / config.REF_TILEPX);

  const work = document.createElement('canvas');
  work.width = CANVAS_W; work.height = CANVAS_H;
  const ctx = work.getContext('2d');
  const rc = rough.canvas(work);

  // load BOTH styles of the hand face (loading is per-face, not per-size)
  await document.fonts.load('16px ' + config.FONT_FAMILY_HAND);
  await document.fonts.load('italic 16px ' + config.FONT_FAMILY_HAND);
  await document.fonts.ready;

  const mkPattern = (img) => {
    const p = ctx.createPattern(img, 'repeat');
    p.setTransform(new DOMMatrix().scale(D.textureScale));
    return p;
  };
  const landPattern = mkPattern(textures.land);
  const waterPattern = mkPattern(textures.water);
  const parkPattern = mkPattern(textures.park);

  // Crop rect (canvas px) — computed EARLY because label layout needs the
  // frame: no text may cross the crop edge (that's how labels stopped being
  // sliced mid-word at the frame).
  const tl = lonLatToCanvas(config, grid, config.VIEW_BBOX.W, config.VIEW_BBOX.N);
  const br = lonLatToCanvas(config, grid, config.VIEW_BBOX.E, config.VIEW_BBOX.S);
  const CROP = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  const cropInset = {
    x0: CROP.x + D.plEdge, y0: CROP.y + D.plEdge,
    x1: CROP.x + CROP.w - D.plEdge, y1: CROP.y + CROP.h - D.plEdge,
  };

  // ==========================================================================
  // PAINT ORDER (bottom -> top)
  // ==========================================================================

  // 1. land base
  ctx.fillStyle = landPattern;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // 2. water fill + hand-drawn coastline + waterway rivers
  const waterFeatures = layers.water;
  const waterPath = polyPath(waterFeatures, grid);
  ctx.save();
  ctx.clip(waterPath, config.FILL_RULE);
  ctx.fillStyle = waterPattern;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.restore();

  let fIdx = 0;
  for (const f of waterFeatures) {
    for (const ring of f.geom) {
      if (ring.length < 2) continue;
      const pts = ring.map((pt) => [px(grid, f.tx, pt.x, f.ext), py(grid, f.ty, pt.y, f.ext)]);
      pts.push(pts[0]); // close the ring for a continuous coast stroke
      rc.linearPath(pts, { stroke: config.COLORS.coastStroke, strokeWidth: D.coast, roughness: config.ROUGHNESS.coast, bowing: config.BOWING.coast, seed: featureSeed(config, fIdx++) });
    }
  }
  for (const f of layers.waterway) {
    for (const ring of f.geom) {
      if (ring.length < 2) continue;
      const pts = ring.map((pt) => [px(grid, f.tx, pt.x, f.ext), py(grid, f.ty, pt.y, f.ext)]);
      rc.linearPath(pts, { stroke: config.COLORS.coastStroke, strokeWidth: D.waterway, roughness: config.ROUGHNESS.coast, seed: featureSeed(config, fIdx++) });
    }
  }

  // 3. parks (park layer + landcover wood/grass/meadow)
  const parkFeatures = [
    ...layers.park,
    ...layers.landcover.filter((f) => config.PARK_LANDCOVER_CLASSES.includes(f.props['class'])),
  ];
  const parkPath = polyPath(parkFeatures, grid);
  ctx.save();
  ctx.clip(parkPath, config.FILL_RULE);
  ctx.globalAlpha = config.ALPHA.park;
  ctx.fillStyle = parkPattern;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.restore();

  // 4. roads — sparse arterials only
  const MAJOR = new Set(config.ROAD_CLASSES_MAJOR);
  const SECONDARY = new Set(config.ROAD_CLASSES_SECONDARY);
  for (const f of layers.transportation) {
    const cls = f.props['class'];
    const isMajor = MAJOR.has(cls), isSecondary = SECONDARY.has(cls);
    if (!isMajor && !isSecondary) continue;
    const opts = isMajor
      ? { stroke: config.COLORS.roadMajor, strokeWidth: D.roadMajor, roughness: config.ROUGHNESS.road }
      : { stroke: config.COLORS.roadSecondary, strokeWidth: D.roadSecondary, roughness: config.ROUGHNESS.road };
    for (const ring of f.geom) {
      if (ring.length < 2) continue;
      const pts = ring.map((pt) => [px(grid, f.tx, pt.x, f.ext), py(grid, f.ty, pt.y, f.ext)]);
      rc.linearPath(pts, { ...opts, seed: featureSeed(config, fIdx++) });
    }
  }

  // 5a. pre-compute route/pin/washi geometry so the label passes can treat
  //     pins + washi + the pen line as occupied regions. The overlay itself
  //     is NOT drawn here — paintOverlay() draws it on top of the snapshot,
  //     per visit order; these coordinates only seed collision.
  const routeTruePts = config.ROUTE_POINTS.map(([lon, lat]) => lonLatToCanvas(config, grid, lon, lat));
  const pinPos = resolvePinPositions(routeTruePts, D, config.PIN.declutter);

  const pinR = D.pinDiam / 2 + D.pinStroke + D.plPinPad; // pin disc + stroke + clearance
  const pinBoxes = pinPos.map((p) => ({ x0: p.x - pinR, y0: p.y - pinR, x1: p.x + pinR, y1: p.y + pinR }));
  const pinDiscs = pinPos.map((p) => ({ x: p.x, y: p.y, r: pinR }));

  // Washi is optional (M1: real trips may have no booked anchor) — index must
  // be a valid position in the route or no tape is planned at all.
  const washiOk = Number.isInteger(config.WASHI_INDEX) &&
    config.WASHI_INDEX >= 0 && config.WASHI_INDEX < pinPos.length;
  const washiPlan = washiOk
    ? planWashiTag(ctx, config, D, pinPos[config.WASHI_INDEX], pinDiscs, cropInset,
        String(config.WASHI_INDEX + 1), 'Booked')
    : null;

  // M2: when the caller already has road-following leg geometry, seed label
  // collision from the REAL pen path (opts.legGeometries, aligned to the
  // consecutive pairs of config.ROUTE_POINTS) instead of the straight chords —
  // otherwise labels can end up under the road-following line.
  const routeSeedPath = buildRoutePath(routeTruePts, opts.legGeometries || null, config, grid, 2.5 * D.K);
  const routeBoxes = routeOccupiedBoxes(routeSeedPath, D);
  const occupied = [...pinBoxes, ...(washiPlan ? [washiPlan.aabb] : []), ...routeBoxes];

  // Separate, TIGHTER blockers for the curved water-label glyph test — true
  // pin discs + the washi AABB, each with only a small glyph margin, NOT the
  // generous pinPad above (that would blank out most of a channel label when
  // several pins sit near the centerline).
  const waterLabelBlockers = {
    pins: pinPos.map((p) => ({ x: p.x, y: p.y, r: D.pinDiam / 2 + D.pinStroke + D.wlGlyphMargin })),
    washi: washiPlan ? {
      x0: washiPlan.aabb.x0 - D.wlGlyphMargin, y0: washiPlan.aabb.y0 - D.wlGlyphMargin,
      x1: washiPlan.aabb.x1 + D.wlGlyphMargin, y1: washiPlan.aabb.y1 + D.wlGlyphMargin,
    } : null,
  };

  // 5b. POINT (city/town) labels — collision-avoids the occupied regions and
  //     pushes each placed box back into `occupied` (shared with 7.5).
  const placeFeatures = layers.place.map((f) => ({ props: f.props, pt: { x: px(grid, f.tx, f.geom[0][0].x, f.ext), y: py(grid, f.ty, f.geom[0][0].y, f.ext) } }));
  const pointLabelStats = layoutPointLabels(ctx, { placeFeatures, occupied, cropInset, C: config, D });

  // 6. weathering overlay + vignette
  ctx.save();
  ctx.globalAlpha = config.ALPHA.weathering;
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(textures.weathering, 0, 0, CANVAS_W, CANVAS_H);
  ctx.restore();
  const vg = ctx.createRadialGradient(
    CANVAS_W / 2, CANVAS_H / 2, Math.min(CANVAS_W, CANVAS_H) * 0.2,
    CANVAS_W / 2, CANVAS_H / 2, Math.max(CANVAS_W, CANVAS_H) * 0.72
  );
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, config.COLORS.vignetteEdge);
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // 7. WATER-BODY curved labels — the last BASE layer. Placement avoids the
  //    initial overlay geometry (blockers + occupied incl. the route corridor
  //    and washi AABB), each other, point labels, and the frame edge, and
  //    never drops glyphs mid-word. Drawn under the overlay: pixels only
  //    differ from the old order if a REORDERED route later crosses one.
  const waterCloud = [];
  for (const f of layers.water) for (const ring of f.geom) for (const pt of ring)
    waterCloud.push({ x: px(grid, f.tx, pt.x, f.ext), y: py(grid, f.ty, pt.y, f.ext) });
  const waterNameFeatures = layers.water_name.map((f) => ({ props: f.props, pt: { x: px(grid, f.tx, f.geom[0][0].x, f.ext), y: py(grid, f.ty, f.geom[0][0].y, f.ext) } }));
  const waterLabelStats = layoutWaterLabels(ctx, {
    waterNameFeatures, waterCloud, canvasW: CANVAS_W,
    blockers: waterLabelBlockers, occupied, cropInset, C: config, D,
  });

  // 8. snapshot the finished base so overlay redraws restore it losslessly
  const base = document.createElement('canvas');
  base.width = CANVAS_W; base.height = CANVAS_H;
  base.getContext('2d').drawImage(work, 0, 0);

  return {
    work, ctx, rc, D, grid, config, CROP, cropInset, base,
    baseLabelStats: { ...waterLabelStats, ...pointLabelStats },
  };
}

// ============================================================================
// paintOverlay(scene, overlay) — restore the base snapshot, then draw the
// trip overlay for a VISIT ORDER: pen route through the points in order,
// numbered pins (declutter + ink leader for displaced ones), and the washi
// tag on the booked stop (skipped when washiIndex is null/invalid). Cheap
// relative to buildScene — this is the reorder/animation redraw path.
//
// overlay:
//   routePoints    [lon,lat][] in visit order (default config.ROUTE_POINTS)
//   washiIndex     number|null (default config.WASHI_INDEX)
//   legGeometries  ([lng,lat][]|null)[] per consecutive pair — road-following
//                  pen (M2); null/absent legs draw their straight chord
//   routeProgress  0..1 draw-on clip of the pen path (default 1)
//   pinPop         number[] per-pin scale for the drop-in spring (default 1s;
//                  <=0.02 skips the pin, digit fades in above 0.6)
//   washiSettle    0..1 settle of the tape (alpha + rotation, default 1)
// ============================================================================
export function paintOverlay(scene, overlay) {
  const { ctx, rc, config, D, grid } = scene;
  const routePoints = (overlay && overlay.routePoints) || config.ROUTE_POINTS;
  const washiIndex = overlay && 'washiIndex' in overlay ? overlay.washiIndex : config.WASHI_INDEX;
  const legGeometries = (overlay && overlay.legGeometries) || null;
  const routeProgress = overlay && overlay.routeProgress != null ? overlay.routeProgress : 1;
  const pinPop = (overlay && overlay.pinPop) || null;
  const washiSettle = overlay && overlay.washiSettle != null ? overlay.washiSettle : 1;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(scene.base, 0, 0);
  ctx.restore();

  const routeTruePts = routePoints.map(([lon, lat]) => lonLatToCanvas(config, grid, lon, lat));
  const pinPos = resolvePinPositions(routeTruePts, D, config.PIN.declutter);
  let pinsDisplaced = 0; for (const p of pinPos) if (p.moved) pinsDisplaced++;

  const penPath = buildRoutePath(routeTruePts, legGeometries, config, grid, 2.5 * D.K);
  drawMarkerRoute(ctx, trimPathByProgress(penPath, routeProgress), config, D);

  pinPos.forEach((p, i) => {
    const pop = pinPop ? clamp(pinPop[i] != null ? pinPop[i] : 1, 0, 1.15) : 1;
    if (pop <= 0.02) return;
    if (p.moved && pop >= 1) {
      // ink leader from the true location to the displaced pin + a dot
      ctx.save();
      ctx.strokeStyle = config.COLORS.pinStroke; ctx.lineWidth = Math.max(1, D.pinStroke * 0.6);
      ctx.beginPath(); ctx.moveTo(p.trueX, p.trueY); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.fillStyle = config.COLORS.pinStroke;
      ctx.beginPath(); ctx.arc(p.trueX, p.trueY, D.leaderDot, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    rc.circle(p.x, p.y, D.pinDiam * pop, {
      stroke: config.COLORS.pinStroke, strokeWidth: D.pinStroke, fill: config.COLORS.pinFill, fillStyle: 'solid',
      roughness: 0.9, seed: featureSeed(config, 5000 + i),
    });
    if (pop > 0.6) {
      ctx.save();
      ctx.globalAlpha = clamp((pop - 0.6) / 0.35, 0, 1);
      ctx.font = fontStr('', D.pinNum, config.FONT_FAMILY_HAND);
      ctx.textAlign = 'center';
      ctx.fillStyle = config.COLORS.pinStroke;
      fillTextOptical(ctx, String(i + 1), p.x, p.y, true);
      ctx.restore();
    }
  });

  let washiPlaced = false;
  if (washiSettle > 0.02 &&
      Number.isInteger(washiIndex) && washiIndex >= 0 && washiIndex < pinPos.length) {
    const pinDiscs = pinPos.map((p) => ({ x: p.x, y: p.y, r: D.pinDiam / 2 + D.pinStroke + D.plPinPad }));
    const plan = planWashiTag(ctx, config, D, pinPos[washiIndex], pinDiscs, scene.cropInset,
      String(washiIndex + 1), 'Booked');
    if (washiSettle < 1) {
      // settling tape: fades in while rotating down onto its final angle
      plan.angle = ((config.WASHI.angleDeg + (1 - washiSettle) * 4) * Math.PI) / 180;
      plan.alphaMul = washiSettle;
    }
    drawWashiTag(ctx, rc, config, D, plan);
    washiPlaced = true;
  }

  return { pinsDisplaced, washiPlaced };
}

// ============================================================================
// computePinArcFractions(scene, overlay) — for the M2 draw-on choreography:
// each pin's position along the pen path as a fraction of total arc length
// (0..1), so a pin can pop exactly when the drawing tip passes it. Uses the
// same path construction as paintOverlay.
// ============================================================================
export function computePinArcFractions(scene, overlay) {
  const { config, D, grid } = scene;
  const routePoints = (overlay && overlay.routePoints) || config.ROUTE_POINTS;
  const legGeometries = (overlay && overlay.legGeometries) || null;
  const routeTruePts = routePoints.map(([lon, lat]) => lonLatToCanvas(config, grid, lon, lat));
  const path = buildRoutePath(routeTruePts, legGeometries, config, grid, 2.5 * D.K);
  if (path.length < 2) return routeTruePts.map(() => 0);
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  }
  const total = cum[cum.length - 1] || 1;
  return routeTruePts.map((pin) => {
    let best = 0, bestD2 = Infinity;
    for (let i = 0; i < path.length; i++) {
      const dx = path[i].x - pin.x, dy = path[i].y - pin.y, d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = cum[i]; }
    }
    return best / total;
  });
}

// ============================================================================
// renderToDisplay(scene, canvas, maxW?) — crop the work canvas to VIEW_BBOX
// and downscale onto the passed-in display canvas (resized to fit, capped at
// maxW or config.MAX_SCREENSHOT_W). CROP is projected with the same
// lonLatToCanvas() math used for every pin/label, so it's pixel-exact
// against everything painted.
// ============================================================================
export function renderToDisplay(scene, canvas, maxW) {
  const { work, config, CROP } = scene;
  const cropW = Math.round(CROP.w), cropH = Math.round(CROP.h);
  const dispW = Math.min(cropW, maxW != null ? maxW : config.MAX_SCREENSHOT_W);
  const scale = dispW / cropW;
  const dispH = Math.round(cropH * scale);
  canvas.width = dispW; canvas.height = dispH;
  const dctx = canvas.getContext('2d');
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(work, CROP.x, CROP.y, cropW, cropH, 0, 0, dispW, dispH);
  return {
    crop: { x: CROP.x, y: CROP.y, w: cropW, h: cropH },
    dispW, dispH,
    canvasW: work.width, canvasH: work.height,
  };
}

// ============================================================================
// paintFull(canvas, config, decoded, textures) -> Stats
// The bench-compatible one-shot: base + overlay (from config's own
// ROUTE_POINTS/WASHI_INDEX) + crop to display. Same signature and stats shape
// as before the M1 split.
// ============================================================================
export async function paintFull(canvas, rawConfig, decoded, textures) {
  const scene = await buildScene(rawConfig, decoded, textures);
  const overlayStats = paintOverlay(scene, {
    routePoints: scene.config.ROUTE_POINTS,
    washiIndex: scene.config.WASHI_INDEX,
  });
  const disp = renderToDisplay(scene, canvas);
  return {
    labelStats: { ...scene.baseLabelStats, pinsDisplaced: overlayStats.pinsDisplaced },
    ...disp,
  };
}
