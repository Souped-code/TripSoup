// map-render-core.js
// Shared browser-side render pipeline for the hand-illustrated JB map.
// Extracted from render-engine.mjs (M0.4) so a second tool (a live tuning
// studio) can load the EXACT same paint code and re-run it repeatedly with a
// mutated config, without duplicating the pipeline.
//
// Design rule: everything is parameterized over a `config` object and
// `textures` (already-loaded <img>/ImageBitmap elements) passed in at call
// time. This module never string-interpolates CONFIG and has no baked-in
// defaults of its own — the caller (render-engine.mjs today; map-studio.mjs
// next) owns the CONFIG values and textures.
//
// Public API (import * as MapRenderCore from './map-render-core.js'):
//   preloadLibs() -> Promise<{Pbf, VectorTile, rough}>   optional warm-start
//   loadImage(src) -> Promise<HTMLImageElement>
//   fetchAndDecode(config, opts?) -> Promise<Decoded>    cached per view (Z/BBOX/TILE/SCALE/EXTENT_FALLBACK)
//   clearDecodeCache() -> void
//   paintFull(canvas, config, decoded, textures) -> Promise<Stats>
//
// Decoded shape: { layers, layerCounts, grid, MINX, MAXX, MINY, MAXY, TILEPX,
//                  CANVAS_W, CANVAS_H, tilesFetched, tilesFailed, tileTemplate }
// Stats shape:   { labelStats: {waterCurved, waterStraight, pointsPlaced, pointsSkipped},
//                  crop: {x,y,w,h}, dispW, dispH, canvasW, canvasH }
// textures shape: { land, water, park, weathering } (HTMLImageElement each)

// ============================================================================
// 0. CDN ESM libs (Pbf, VectorTile, roughjs) — loaded once, memoized.
// ============================================================================
let _libsPromise = null;
export function preloadLibs() {
  if (_libsPromise) return _libsPromise;
  _libsPromise = (async () => {
    const [pbfMod, vtMod, roughMod] = await Promise.all([
      import('https://cdn.jsdelivr.net/npm/pbf@3.2.1/+esm'),
      import('https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@1.3.1/+esm'),
      import('https://cdn.jsdelivr.net/npm/roughjs@4.6.6/+esm'),
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
// SMALL SHARED HELPERS (overlay art — used by washi + route below). Already
// parameterized in the original (no closure over module-level config), so
// carried over verbatim.
// ============================================================================
// mulberry32 — seeded PRNG so the torn washi edge is deterministic run-to-run.
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

// CHANGE 3 — fine blue marker: soft wide bleed under-stroke + crisp core.
function drawMarkerRoute(ctx, pts, C) {
  strokeSmoothPath(ctx, pts, C.ROUTE_WIDTH + C.ROUTE_BLEED_EXTRA, C.COLORS.routeLine, C.ROUTE_BLEED_ALPHA);
  strokeSmoothPath(ctx, pts, C.ROUTE_WIDTH, C.COLORS.routeLine, 1);
}

// CHANGE 2 — washi tape: long (top/bottom) edges straight, short (left/right)
// edges torn with small seeded perpendicular jitter; translucent body so the
// map shows through; faint inner sheen + torn-edge shadow; label at full alpha.
function tornTapePath(x, y, w, h, segs, amp, rng) {
  const left = x, right = x + w, top = y, bot = y + h;
  const pts = [];
  pts.push({ x: left, y: top }); pts.push({ x: right, y: top });        // top edge straight L->R
  for (let i = 1; i < segs; i++) { const t = i / segs; pts.push({ x: right + (rng() * 2 - 1) * amp, y: top + (bot - top) * t }); } // right torn top->bottom
  pts.push({ x: right, y: bot });
  pts.push({ x: left, y: bot });                                        // bottom edge straight R->L
  for (let i = segs - 1; i >= 1; i--) { const t = i / segs; pts.push({ x: left + (rng() * 2 - 1) * amp, y: top + (bot - top) * t }); } // left torn bottom->top
  return pts;
}
function drawWashiTape(ctx, x, y, w, h, label, C) {
  const rng = makeRng(C.WASHI_TEAR_SEED);
  const pts = tornTapePath(x, y, w, h, C.WASHI_TEAR_SEGMENTS, C.WASHI_TEAR_AMP, rng);
  ctx.save();
  ctx.globalAlpha = C.WASHI_ALPHA; // translucent tape body
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = C.COLORS.washiFill; ctx.fill();
  // faint inner sheen — lighter toward the top edge
  const sheen = ctx.createLinearGradient(0, y, 0, y + h);
  sheen.addColorStop(0, C.COLORS.washiSheen); sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen; ctx.fill();
  // torn-edge shadow — faint darker outline to sell the ragged ends
  ctx.lineWidth = 1; ctx.strokeStyle = C.COLORS.washiShade; ctx.stroke();
  ctx.restore();
  // "N · Booked" label on top at full opacity
  ctx.font = C.FONT_WASHI; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = C.COLORS.pinStroke; ctx.fillText(label, x + w / 2, y + h / 2 + 1);
}

// ============================================================================
// LABEL SUBSYSTEM — governs all map text so it curves/rotates to fit the
// geography and never overlaps (incl. the route pins/washi). Self-contained;
// already parameterized over an explicit `C`/`cfg` config param in the
// original, so carried over verbatim.
//   layoutWaterLabels() — curved water-body labels (called AFTER route/pins)
//   layoutPointLabels()  — point-label collision pass (occupied-region aware)
//   drawCurvedLabel() — text-on-path along a water-body spine (PCA centerline),
//                        centered on the on-water anchor point (not spine midpoint)
//   drawStraightLabel() — axis-aligned fallback when a robust spine fails
//   drawPointLabel()  — horizontal city/town label w/ paper halo
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

// BUG FIX (water-label-on-land): arc-length position on the spine nearest a
// given canvas point. Used so curved text can be centered on the anchor (the
// OSM water_name point, always ON its own water body) instead of the spine's
// raw arc midpoint — which can drift over land when the local PCA cloud
// blends multiple nearby water bodies (see WATER_LABEL.cloudRadiusFrac).
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
// (their actual visual disc + a small margin) and the washi rect (+ margin).
// Deliberately tighter than the occupied rects used for point-label
// placement — this only flags a glyph whose own sample point truly lands on
// a pin/tag, not anything merely nearby (see glyphSkipMargin comment in CONFIG).
function glyphBlocked(x, y, blockers) {
  if (!blockers) return false;
  for (const c of blockers.pins) { const dx = x - c.x, dy = y - c.y; if (dx * dx + dy * dy <= c.r * c.r) return true; }
  const w = blockers.washi;
  if (w && x >= w.x0 && x <= w.x1 && y >= w.y0 && y <= w.y1) return true;
  return false;
}

// Text-on-path: measure each glyph, advance a cursor along the spine by its
// width, draw it translated to the cursor + rotated to the local tangent.
// blockers (route-pin discs + washi rect, see glyphBlocked above) — any glyph
// whose sample point falls inside one is skipped (cursor still advances, so
// the rest of the word keeps correct spacing) so a pin/tag under the spine
// stays fully legible instead of being painted over.
function drawCurvedLabel(ctx, text, arc, cfg, blockers, anchor) {
  const chars = [...text];
  ctx.font = cfg.fontStyle + ' ' + cfg.fontBase + 'px ' + cfg.fontFamily;
  let base = 0; for (const c of chars) base += ctx.measureText(c).width; base += cfg.letterSpacing * (chars.length - 1);
  let size = (cfg.fontBase * (arc.total * cfg.fillFrac)) / (base || 1);
  size = Math.max(cfg.fontMin, Math.min(cfg.fontMax, size));
  ctx.font = cfg.fontStyle + ' ' + size + 'px ' + cfg.fontFamily;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + cfg.letterSpacing * (chars.length - 1);
  // BUG FIX — center on the anchor's own nearest arc-length position (always
  // on-water) instead of the spine's raw midpoint (arc.total/2), which can
  // land on LAND when the spine's cloud blends multiple water bodies.
  const sAnchor = anchor ? nearestArcLength(arc, anchor) : arc.total / 2;
  let cursor = clamp(sAnchor - total / 2, 0, Math.max(0, arc.total - total));
  for (let i = 0; i < chars.length; i++) {
    const w = widths[i]; const s = sampleArc(arc, cursor + w / 2);
    const blocked = glyphBlocked(s.x, s.y, blockers);
    if (!blocked) {
      ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.angle);
      ctx.lineWidth = cfg.haloWidth; ctx.strokeStyle = cfg.halo; ctx.strokeText(chars[i], 0, 0);
      ctx.fillStyle = cfg.fill; ctx.fillText(chars[i], 0, 0);
      ctx.restore();
    }
    cursor += w + cfg.letterSpacing;
  }
  return size;
}

// Fallback: whole label rotated to the principal-axis angle (straight, still
// axis-aligned — far better than horizontal when a spine can't be built).
function drawStraightLabel(ctx, text, x, y, angle, cfg) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
  ctx.font = cfg.fontStyle + ' ' + cfg.fontBase + 'px ' + cfg.fontFamily;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.lineWidth = cfg.haloWidth; ctx.strokeStyle = cfg.halo; ctx.strokeText(text, 0, 0);
  ctx.fillStyle = cfg.fill; ctx.fillText(text, 0, 0);
  ctx.restore();
}

function labelBox(ctx, text, x, y, font, pad) {
  ctx.font = font; const m = ctx.measureText(text);
  const asc = m.actualBoundingBoxAscent || parseInt(font) * 0.72;
  const desc = m.actualBoundingBoxDescent || parseInt(font) * 0.28;
  const w = m.width, h = asc + desc;
  return { x0: x - w / 2 - pad, y0: y - h / 2 - pad, x1: x + w / 2 + pad, y1: y + h / 2 + pad };
}
function boxOverlap(a, b) { return !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0); }

function drawPointLabel(ctx, text, x, y, font, fill, halo, haloW) {
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.lineWidth = haloW; ctx.strokeStyle = halo; ctx.strokeText(text, x, y);
  ctx.fillStyle = fill; ctx.fillText(text, x, y);
}

// Two independently-callable phases so the caller can (a) seed the
// point-label collision pass with pin/washi occupied regions and (b) choose
// to run water labels AFTER the route/pins are painted, so curved water text
// always reads on top of them.

// (a) WATER-BODY curved labels. waterCloud = ALL water ring vertices in canvas
// px; each label pulls its own local subset within a radius (survives MVT
// tile-clipping). waterNameFeatures carries a precomputed canvas-space anchor
// point (pt).
function layoutWaterLabels(ctx, opts) {
  const { waterNameFeatures, waterCloud, canvasW, blockers, C } = opts;
  const wl = C.WATER_LABEL;
  const R = wl.cloudRadiusFrac * canvasW, R2 = R * R;
  const seenW = new Set();
  let curved = 0, straight = 0;
  for (const f of waterNameFeatures) {
    const text = f.props['name:en'] || f.props['name']; if (!text || seenW.has(text)) continue; seenW.add(text);
    const p = f.pt;
    const cloud = [];
    for (const q of waterCloud) { const dx = q.x - p.x, dy = q.y - p.y; if (dx * dx + dy * dy <= R2) cloud.push(q); }
    const cfg = { ...wl, fill: C.COLORS.waterNameText, halo: C.COLORS.paperHalo };
    if (cloud.length >= wl.minCloud) {
      const pca = pca2d(cloud);
      const spine = buildSpine(cloud, pca, wl.buckets, wl.trim, wl.smoothPasses);
      if (spine.length >= 2) { const arc = buildArc(spine); if (arc.total > 20) { drawCurvedLabel(ctx, text, arc, cfg, blockers, p); curved++; continue; } }
      drawStraightLabel(ctx, text, p.x, p.y, pca.angle, cfg); straight++; continue; // axis-aligned fallback
    }
    drawStraightLabel(ctx, text, p.x, p.y, 0, cfg); straight++; // last resort: horizontal
  }
  return { waterCurved: curved, waterStraight: straight };
}

// (b) POINT (city/town) labels — greedy collision avoidance. opts.occupied
// (route-pin bounding squares + the washi tag box, in canvas px) is pre-seeded
// into the placed-boxes list so drawPointLabel's nudge loop treats them exactly
// like already-placed labels — skip/nudge around them, never draw under them.
function layoutPointLabels(ctx, opts) {
  const { placeFeatures, occupied, C } = opts;
  const placed = [...(occupied || [])]; // pins + washi pre-seeded as occupied regions
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
  const fontSize = parseInt(C.FONT_LABEL);
  let placedCount = 0, skipped = 0;
  for (const c of cands) {
    let done = false;
    for (const [ox, oy] of pl.nudges) {
      const x = c.x + ox * fontSize * pl.nudgeStep, y = c.y + oy * fontSize * pl.nudgeStep;
      const box = labelBox(ctx, c.text, x, y, C.FONT_LABEL, pl.haloPad);
      let hit = false; for (const pb of placed) { if (boxOverlap(box, pb)) { hit = true; break; } }
      if (!hit) { placed.push(box); drawPointLabel(ctx, c.text, x, y, C.FONT_LABEL, C.COLORS.ink, C.COLORS.paperHalo, pl.haloWidth); done = true; placedCount++; break; }
    }
    if (!done) skipped++; // all candidate positions collide -> drop (no overlaps in output)
  }
  return { pointsPlaced: placedCount, pointsSkipped: skipped };
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
// paintFull(canvas, config, decoded, textures) -> Stats
// Does the whole basemap+labels+route+crop: builds its own detached working
// canvas at the full fetched-grid size, paints the complete layer stack onto
// it (land -> water/coast/waterway -> parks -> roads -> point labels ->
// weathering/vignette -> route/pins/washi -> curved water labels), then crops
// to config.VIEW_BBOX and downscales the result onto the passed-in `canvas`
// (resized to fit, capped at config.MAX_SCREENSHOT_W). Returns a small stats
// object (label placement counts + the crop/display geometry) so callers
// don't have to re-derive them — the pixels land on `canvas` either way.
// ============================================================================
export async function paintFull(canvas, config, decoded, textures) {
  const { rough } = await preloadLibs();
  const grid = decoded.grid || computeGrid(config);
  const { CANVAS_W, CANVAS_H, layers } = decoded;

  const work = document.createElement('canvas');
  work.width = CANVAS_W; work.height = CANVAS_H;
  const ctx = work.getContext('2d');
  const rc = rough.canvas(work);

  await document.fonts.load(config.FONT_LABEL);
  await document.fonts.load(config.FONT_WATER_NAME);
  await document.fonts.ready;

  const mkPattern = (img) => {
    const p = ctx.createPattern(img, 'repeat');
    p.setTransform(new DOMMatrix().scale(config.TEXTURE_SCALE));
    return p;
  };
  const landPattern = mkPattern(textures.land);
  const waterPattern = mkPattern(textures.water);
  const parkPattern = mkPattern(textures.park);

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

  for (const f of waterFeatures) {
    for (const ring of f.geom) {
      if (ring.length < 2) continue;
      const pts = ring.map((pt) => [px(grid, f.tx, pt.x, f.ext), py(grid, f.ty, pt.y, f.ext)]);
      pts.push(pts[0]); // close the ring for a continuous coast stroke
      rc.linearPath(pts, { stroke: config.COLORS.coastStroke, strokeWidth: config.WIDTHS.coast, roughness: config.ROUGHNESS.coast, bowing: config.BOWING.coast });
    }
  }
  for (const f of layers.waterway) {
    for (const ring of f.geom) {
      if (ring.length < 2) continue;
      const pts = ring.map((pt) => [px(grid, f.tx, pt.x, f.ext), py(grid, f.ty, pt.y, f.ext)]);
      rc.linearPath(pts, { stroke: config.COLORS.coastStroke, strokeWidth: config.WIDTHS.waterway, roughness: config.ROUGHNESS.coast });
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
      ? { stroke: config.COLORS.roadMajor, strokeWidth: config.WIDTHS.roadMajor, roughness: config.ROUGHNESS.road }
      : { stroke: config.COLORS.roadSecondary, strokeWidth: config.WIDTHS.roadSecondary, roughness: config.ROUGHNESS.road };
    for (const ring of f.geom) {
      if (ring.length < 2) continue;
      const pts = ring.map((pt) => [px(grid, f.tx, pt.x, f.ext), py(grid, f.ty, pt.y, f.ext)]);
      rc.linearPath(pts, opts);
    }
  }

  // 5a. pre-compute route/pin/washi geometry BEFORE labels are laid out, so
  //     the point-label collision pass (5b) can treat pins + the washi tag
  //     box as occupied regions to skip/nudge around. Actual DRAWING of the
  //     route/pins/washi still happens later (step 7) so they remain the
  //     crisp top layer; this just reuses the same coordinates.
  const routeCanvasPts = config.ROUTE_POINTS.map(([lon, lat]) => lonLatToCanvas(config, grid, lon, lat));
  const pinR = config.PIN_DIAMETER / 2 + config.WIDTHS.pinStroke + config.POINT_LABEL.pinPad; // pin path radius + stroke + clearance
  const pinBoxes = routeCanvasPts.map((p) => ({ x0: p.x - pinR, y0: p.y - pinR, x1: p.x + pinR, y1: p.y + pinR }));
  const tag = routeCanvasPts[config.WASHI_INDEX];
  const tagX = tag.x - config.WASHI_W / 2, tagY = tag.y + 34;
  const washiBox = {
    x0: tagX - config.POINT_LABEL.pinPad, y0: tagY - config.POINT_LABEL.pinPad,
    x1: tagX + config.WASHI_W + config.POINT_LABEL.pinPad, y1: tagY + config.WASHI_H + config.POINT_LABEL.pinPad,
  };
  const occupied = [...pinBoxes, washiBox];
  // Separate, TIGHTER blockers for the curved water-label glyph-skip test —
  // true pin discs + exact washi rect, each with only a small glyphSkipMargin,
  // NOT the generous pinPad above (pinPad is sized for keeping whole
  // point-labels comfortably clear; reused here it would blank out most of
  // "Straits of Johor" since pins 3/4/5 all sit close to the strait's centerline).
  const glyphMargin = config.WATER_LABEL.glyphSkipMargin;
  const waterLabelBlockers = {
    pins: routeCanvasPts.map((p) => ({ x: p.x, y: p.y, r: config.PIN_DIAMETER / 2 + config.WIDTHS.pinStroke + glyphMargin })),
    washi: {
      x0: tagX - glyphMargin, y0: tagY - glyphMargin,
      x1: tagX + config.WASHI_W + glyphMargin, y1: tagY + config.WASHI_H + glyphMargin,
    },
  };

  // 5b. POINT (city/town) labels — collision-avoids other labels AND the
  //     occupied pin/washi regions above. See layoutPointLabels().
  const placeFeatures = layers.place.map((f) => ({ props: f.props, pt: { x: px(grid, f.tx, f.geom[0][0].x, f.ext), y: py(grid, f.ty, f.geom[0][0].y, f.ext) } }));
  const pointLabelStats = layoutPointLabels(ctx, { placeFeatures, occupied, C: config });

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

  // 7. overlay — sample route + numbered pins + "Booked" washi tag (geometry
  //    already computed in 5a; reused here so labels and pins agree exactly).
  // fine blue marker — smooth curve through the points (no wobble), soft
  // wide bleed under-stroke beneath a crisp core.
  drawMarkerRoute(ctx, routeCanvasPts, config);
  routeCanvasPts.forEach((p, i) => {
    rc.circle(p.x, p.y, config.PIN_DIAMETER, {
      stroke: config.COLORS.pinStroke, strokeWidth: config.WIDTHS.pinStroke, fill: config.COLORS.pinFill, fillStyle: 'solid',
    });
    ctx.font = config.FONT_PIN_NUM;
    ctx.fillStyle = config.COLORS.pinStroke;
    ctx.fillText(String(i + 1), p.x, p.y + 1);
  });
  // translucent washi tape with torn short edges (see drawWashiTape).
  drawWashiTape(ctx, tagX, tagY, config.WASHI_W, config.WASHI_H, (config.WASHI_INDEX + 1) + ' · Booked', config);

  // 7.5. WATER-BODY curved labels, drawn AFTER the route/pins/washi so
  //      "Straits of Johor" (or any water label) reads on top even where its
  //      PCA spine happens to cross the pen line or a pin, rather than being
  //      painted under it. (Point labels stay at 5b, before weathering, so
  //      they still receive the same aged/weathered tint; only water labels
  //      sit as the un-weathered top layer, matching route/pins/washi.)
  const waterCloud = [];
  for (const f of layers.water) for (const ring of f.geom) for (const pt of ring)
    waterCloud.push({ x: px(grid, f.tx, pt.x, f.ext), y: py(grid, f.ty, pt.y, f.ext) });
  const waterNameFeatures = layers.water_name.map((f) => ({ props: f.props, pt: { x: px(grid, f.tx, f.geom[0][0].x, f.ext), y: py(grid, f.ty, f.geom[0][0].y, f.ext) } }));
  const waterLabelStats = layoutWaterLabels(ctx, { waterNameFeatures, waterCloud, canvasW: CANVAS_W, blockers: waterLabelBlockers, C: config });

  const labelStats = { ...waterLabelStats, ...pointLabelStats };

  // 8. crop to VIEW_BBOX, then downscale the CROP (not the whole fetched
  //    grid) onto the passed-in display `canvas`. CROP is projected with the
  //    same lonLatToCanvas() math used for every pin/label, so it's
  //    pixel-exact against everything just painted.
  const tl = lonLatToCanvas(config, grid, config.VIEW_BBOX.W, config.VIEW_BBOX.N);
  const br = lonLatToCanvas(config, grid, config.VIEW_BBOX.E, config.VIEW_BBOX.S);
  const CROP = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  const cropW = Math.round(CROP.w), cropH = Math.round(CROP.h);
  const dispW = Math.min(cropW, config.MAX_SCREENSHOT_W);
  const scale = dispW / cropW;
  const dispH = Math.round(cropH * scale);
  canvas.width = dispW; canvas.height = dispH;
  const dctx = canvas.getContext('2d');
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(work, CROP.x, CROP.y, cropW, cropH, 0, 0, dispW, dispH);

  return {
    labelStats,
    crop: { x: CROP.x, y: CROP.y, w: cropW, h: cropH },
    dispW, dispH,
    canvasW: CANVAS_W, canvasH: CANVAS_H,
  };
}
