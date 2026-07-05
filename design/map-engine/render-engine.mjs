// M0.4 — render-engine.mjs
// Hand-illustrated Johor Bahru map render harness: fetches REAL OpenFreeMap
// vector tiles, decodes MVT client-side (Pbf + @mapbox/vector-tile via
// jsDelivr ESM), and paints the decoded geometry with our AI textures +
// Rough.js strokes onto a canvas — proving the art-direction render engine.
// Scratchpad-only R&D. No repo files touched. No npm installs (browser libs
// load from jsDelivr `/+esm` at runtime).
//
// usage: node render-engine.mjs ["<abs path to board png>"]

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRequire = createRequire("C:/Users/65881/dev/itinerary-optimiser/package.json");
const { chromium } = repoRequire("@playwright/test");

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const BOARD = process.argv[2] || "C:/Users/65881/dev/itinerary-optimiser/design/refs/d1.1-reveal-LOCKED-palette.png";
const OUT = here("./render-engine-v0.png");
const COMP_OUT = here("./render-engine-v0-vs-board.png");

// ============================================================================
// TUNABLE CONSTANTS — every color / width / roughness / alpha / SCALE / Z
// lives here so the orchestrator can art-tune without touching the paint
// logic below. Values are the brief's literal defaults where it gave one;
// where it didn't (pin size, washi box, texture tiling, fill-rule, output
// cap) I picked a reasonable default and say so in the report.
// ============================================================================
const CONFIG = {
  Z: 11, // render zoom — Z11's sparser road geometry reads more like the hand-drawn board than Z12
  EXTENT_FALLBACK: 4096, // MVT extent fallback if layer.extent is missing
  TILE: 256, // base slippy-tile size (px)
  SCALE: 4, // was 2 — bumped to the studio's resolution so the harness output is crisp AND (thanks to
  // REF_TILEPX normalization below) proportions now match the studio exactly at any SCALE.
  REF_TILEPX: 1024, // FIDELITY PASS — the resolution (TILE*SCALE) every px value below is authored at.
  // paintFull scales all sizes by K = TILEPX/REF_TILEPX, so SCALE changes RESOLUTION only, never proportions.
  BBOX: { W: 103.62, E: 103.98, N: 1.57, S: 1.37 }, // fetch footprint — deliberately wider than VIEW_BBOX below so
  // geometry still bleeds to the crop edges instead of the canvas running out of tiles right at the frame.
  VIEW_BBOX: { W: 103.67, E: 103.88, N: 1.525, S: 1.408 }, // tight JB city + Straits crop window (a
  // sub-rect of BBOX above; BBOX itself is NOT re-fetched/changed).
  MAX_SCREENSHOT_W: 1600, // display cap, applied to VIEW_BBOX's crop width (the crop is the deliverable)
  FILL_RULE: "nonzero", // MVT spec winding (exterior CW / holes CCW in tile-px space) -> nonzero is spec-correct for clip()
  STROKE_SEED: 7, // FIDELITY PASS — per-feature Rough.js seeds derive from this: strokes are
  // deterministic across repaints (plan constraint; only the route deliberately re-sketches at M2).

  TEXTURE_SCALE: 0.4, // CanvasPattern scale, authored at REF_TILEPX (scaled by K like every px value,
  // so texture grain keeps the same size relative to the geography at any resolution).

  COLORS: {
    ink: "#2B2620",
    paperHalo: "#F6F1E7",
    coastStroke: "#6f8a86",
    waterNameText: "#5E7F86",
    roadMajor: "#9a7b4f",
    roadSecondary: "#b2a483",
    routeLine: "#3E6C8E",
    pinFill: "#F6F1E7",
    pinStroke: "#2B2620",
    washiFill: "#F4C95D",
    washiShade: "rgba(120,90,20,0.30)", // tear shading on the torn ENDS (never a full outline)
    washiSheen: "rgba(255,255,255,0.20)", // gated by WASHI.sheenAlpha (0 = matte, board-faithful)
    washiPatternTint: "#FFFFFF", // gingham/stripes bar tint over the tape fill (alpha via WASHI.patternAlpha)
    vignetteEdge: "rgba(74,58,38,0.20)",
  },
  WIDTHS: {
    coast: 1.6,
    waterway: 1.2,
    roadMajor: 2.6,
    roadSecondary: 1.6,
    washiStroke: 1.1, // width of the tear shading stroke on the tape's torn ends
  },
  ROUGHNESS: { coast: 1.4, road: 1.2, route: 1.6 },
  BOWING: { coast: 1, route: 2 },
  ALPHA: { park: 0.4, weathering: 0.22 },

  // ---- route line as a fine blue marker (smooth curve + bleed) --------------
  ROUTE_WIDTH: 3, // fine-marker core width
  ROUTE_BLEED_EXTRA: 2, // felt-tip bleed under-stroke width is (core + this)
  ROUTE_BLEED_ALPHA: 0.3, // opacity of the soft bleed under-stroke

  // ---- pins — board proportions: fine thin-ink circles, hand-font digits ----
  PIN: {
    diameter: 26, // board pins are ~2% of the map width — half the first cut's 36
    strokeWidth: 1.7, // thin fineliner ring, not a heavy badge
    numFontSize: 13, // hand-font digit, optically centered
    declutter: true, // overlapping pins (real trips!) push apart deterministically…
    declutterGap: 4, // …to this clearance, with an ink leader + dot at the true spot
    leaderDot: 2.4,
  },

  // ---- washi tape — board-faithful: content-sized, tilted, torn ENDS only ---
  WASHI: {
    h: 30,
    padX: 12, // horizontal padding around the "④ Booked" lettering; tape width follows content
    minW: 90,
    maxW: 240,
    fontSize: 15, // hand-font ink lettering (Segoe UI is banned by design.md §2.4)
    alpha: 0.94, // near-opaque like the board (dial down for see-through tape)
    angleDeg: -3, // the slight hand-placed tilt the board tape has
    tearSegs: 12, // multi-scale torn ends: coarse rip…
    tearAmp: 3.2,
    tearFine: 1.1, // …plus fine fiber serration
    seed: 20260705, // deterministic tear shape
    pattern: "plain", // 'plain' | 'gingham' | 'stripes' (subtle, token-color-safe)
    patternAlpha: 0.13,
    sheenAlpha: 0, // board tape is matte — gloss off by default, dial preserved
    offset: 0.72, // tape center distance from its pin, in tape-heights
  },

  // ---- (a) curved water-body labels — text-on-path along a PCA spine --------
  WATER_LABEL: {
    fontStyle: "italic",
    fontFamily: "'Gochi Hand'",
    fontBase: 24, // base measuring size; auto-scaled to the water-body size
    fontMin: 12, // never render curved water text smaller than this…
    fontMax: 28, // …or larger than this (board's channel lettering is modest — was 40)
    fillFrac: 0.62, // text spans this fraction of the spine (was 0.86 — stretched across the whole strait)
    cloudRadiusFrac: 0.09, // local water-vertex cloud radius, as fraction of canvasW (local body only;
    // wider radii blend multiple water bodies into one cloud and drift the spine onto land)
    minCloud: 40, // need at least this many nearby water vertices to curve
    buckets: 12, // spine centerline resolution (bins along the principal axis)
    trim: 0.1, // trim this fraction off each spine end (text sits inside body)
    smoothPasses: 2, // moving-average passes to smooth the spine polyline
    letterSpacing: 2, // px added between glyphs along the path
    haloWidth: 4, // paper-halo stroke width for curved glyphs
    glyphSkipMargin: 4, // clearance margin for the tight per-glyph pin/washi test inside the
    // window search. Glyphs are NEVER dropped mid-word anymore — the whole word slides along
    // the channel (and shrinks stepwise) until every glyph clears pins/washi/labels/frame.
  },
  // ---- (b) point (city/town) labels — nudge → shrink → drop, edge-aware -----
  POINT_LABEL: {
    fontSize: 22, // board-scale hand lettering (was 28)
    haloPad: 3, // px padding around each label bbox (spacing between labels)
    haloWidth: 5, // paper-halo stroke width
    nudges: [
      [0, 0], [0, -1], [0, 1], [-1, 0], [1, 0],
      [-1, -1], [1, -1], [-1, 1], [1, 1], [0, -2], [0, 2],
    ], // offsets (×fontSize×nudgeStep) tried in order — now incl. diagonals + 2-step verticals
    nudgeStep: 0.9, // nudge magnitude as a multiple of the font size
    pinPad: 4, // extra px clearance between a label's bbox and each route-pin / washi occupied box
    maxLabels: 8, // density cap — route map, not a street atlas (design.md §8; board shows a couple of names)
    twoLineMaxW: 170, // wider single-line labels wrap to two lines (like the board's mosque label)
    shrinkFloor: 0.8, // labels may shrink to this ×fontSize before dropping
    edgeMargin: 10, // no text within this of the crop edge — kills the mid-word frame slicing
    routePad: 3, // clearance between labels and the route pen line (tape may cross it; text may not)
  },

  FONT_FAMILY_HAND: "'Gochi Hand'", // every piece of map lettering (labels, pin digits, washi) — §2.4

  ROAD_CLASSES_MAJOR: ["motorway", "trunk", "primary"],
  ROAD_CLASSES_SECONDARY: ["secondary"],
  PARK_LANDCOVER_CLASSES: ["wood", "grass", "meadow"],
  PLACE_CLASSES: ["city", "town"],

  // [lon, lat] — brief's 5 sample JB points
  ROUTE_POINTS: [
    [103.720, 1.500], // 1 coffee spot (north-west JB)
    [103.750, 1.475], // 2 old town
    [103.770, 1.458], // 3 temple
    [103.800, 1.452], // 4 mosque -> washi "Booked" tag
    [103.820, 1.428], // 5 Straits point (south-east, toward the water)
  ],
  WASHI_INDEX: 3, // 0-based index into ROUTE_POINTS that gets the washi tag
};

// ---- Node-side projection (informational pre-flight log only; the browser
// recomputes the same formulas independently from CONFIG at runtime) --------
const lon2xFracN = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2yFracN = (lat, z) =>
  ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;
const nMinX = Math.floor(lon2xFracN(CONFIG.BBOX.W, CONFIG.Z));
const nMaxX = Math.floor(lon2xFracN(CONFIG.BBOX.E, CONFIG.Z));
const nMinY = Math.floor(lat2yFracN(CONFIG.BBOX.N, CONFIG.Z));
const nMaxY = Math.floor(lat2yFracN(CONFIG.BBOX.S, CONFIG.Z));
const nTilePx = CONFIG.TILE * CONFIG.SCALE;
const nCanvasW = (nMaxX - nMinX + 1) * nTilePx;
const nCanvasH = (nMaxY - nMinY + 1) * nTilePx;
const nTileCount = (nMaxX - nMinX + 1) * (nMaxY - nMinY + 1);
console.log(
  JSON.stringify({
    phase: "preflight-projection",
    minX: nMinX,
    maxX: nMaxX,
    minY: nMinY,
    maxY: nMaxY,
    canvasW: nCanvasW,
    canvasH: nCanvasH,
    tileCount: nTileCount,
  })
);

// FIX 1 — mirror the browser's VIEW_BBOX crop projection here too (same
// lon/lat->canvas-px math), purely so this preflight log + the Playwright
// viewport sizing below reflect the cropped output, not the full fetched grid.
const nLonLatToCanvas = (lon, lat) => ({
  x: (lon2xFracN(lon, CONFIG.Z) - nMinX) * nTilePx,
  y: (lat2yFracN(lat, CONFIG.Z) - nMinY) * nTilePx,
});
const nCropTL = nLonLatToCanvas(CONFIG.VIEW_BBOX.W, CONFIG.VIEW_BBOX.N);
const nCropBR = nLonLatToCanvas(CONFIG.VIEW_BBOX.E, CONFIG.VIEW_BBOX.S);
const nCrop = { x: nCropTL.x, y: nCropTL.y, w: nCropBR.x - nCropTL.x, h: nCropBR.y - nCropTL.y };
console.log(JSON.stringify({ phase: "preflight-crop", VIEW_BBOX: CONFIG.VIEW_BBOX, crop: nCrop }));

// ============================================================================
// Texture files served locally
// ============================================================================
const TEXTURE_FILES = ["tex-land.png", "tex-water.png", "tex-park.png", "tex-weathering.png"];
for (const f of TEXTURE_FILES) {
  if (!existsSync(here("./" + f))) {
    console.error(JSON.stringify({ ok: false, error: `missing texture file: ${f}` }));
    process.exit(1);
  }
}

// Shared browser-side render pipeline (DRY refactor — also loaded by the
// upcoming live tuning studio so both tools paint with identical code).
const CORE_FILE = "map-render-core.js";
if (!existsSync(here("./" + CORE_FILE))) {
  console.error(JSON.stringify({ ok: false, error: `missing shared render core: ${CORE_FILE}` }));
  process.exit(1);
}

// ============================================================================
// Client-side page. Runs inside Chromium. Fetches TileJSON, fetches tiles,
// decodes MVT with jsDelivr ESM bundles, paints the full layer stack, and
// reports back via window.__* globals for Playwright to read.
// ============================================================================
// Client-side page now just bootstraps: imports the shared render pipeline
// from map-render-core.js (served locally, see server below) and drives it
// with this run's CONFIG + freshly-loaded textures. The pipeline itself
// (TileJSON/tile fetch, MVT decode, projection, basemap paint, labels,
// route/pins/washi, VIEW_BBOX crop) lives entirely in map-render-core.js —
// see MapRenderCore.fetchAndDecode() / MapRenderCore.paintFull().
const clientScript = `
import * as MapRenderCore from './map-render-core.js';

window.__errs = [];
window.__ready = false;
window.__tilesFetched = 0;
window.__tilesFailed = [];
window.__tileTemplate = null;
window.__layerCounts = null;

window.addEventListener('error', function (e) { window.__errs.push('window error: ' + e.message); });
window.addEventListener('unhandledrejection', function (e) { window.__errs.push('unhandled rejection: ' + String(e.reason)); });

const CONFIG = ${JSON.stringify(CONFIG)};

async function main() {
  const [, landImg, waterImg, parkImg, weatherImg] = await Promise.all([
    MapRenderCore.preloadLibs(),
    MapRenderCore.loadImage('/tex-land.png'),
    MapRenderCore.loadImage('/tex-water.png'),
    MapRenderCore.loadImage('/tex-park.png'),
    MapRenderCore.loadImage('/tex-weathering.png'),
  ]);

  const decoded = await MapRenderCore.fetchAndDecode(CONFIG);
  window.__tilesFetched = decoded.tilesFetched;
  window.__tilesFailed = decoded.tilesFailed;
  window.__tileTemplate = decoded.tileTemplate;
  window.__layerCounts = decoded.layerCounts;

  const stats = await MapRenderCore.paintFull(
    document.getElementById('display'),
    CONFIG,
    decoded,
    { land: landImg, water: waterImg, park: parkImg, weathering: weatherImg }
  );

  window.__labelStats = stats.labelStats;
  window.__canvasW = stats.canvasW;
  window.__canvasH = stats.canvasH;
  window.__crop = stats.crop;
  window.__dispW = stats.dispW;
  window.__dispH = stats.dispH;
}

main().catch((e) => { window.__errs.push(String((e && e.stack) || e)); }).finally(() => { window.__ready = true; });
`;

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Gochi+Hand&display=swap">
<style>html,body{margin:0;background:#F6F1E7}#display{display:block}</style>
</head><body>
<canvas id="display"></canvas>
<script type="module">
${clientScript}
</script>
</body></html>`;

// ============================================================================
// Local server: main HTML at "/", textures at their filenames
// ============================================================================
const server = createServer((req, res) => {
  const name = (req.url || "/").replace(/^\//, "").split("?")[0];
  if (TEXTURE_FILES.includes(name)) {
    res.setHeader("content-type", "image/png");
    res.end(readFileSync(here("./" + name)));
    return;
  }
  if (name === CORE_FILE) {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.end(readFileSync(here("./" + name)));
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

// ============================================================================
// Playwright drive
// ============================================================================
const nCropW = Math.round(nCrop.w), nCropH = Math.round(nCrop.h);
const dispW0 = Math.min(nCropW, CONFIG.MAX_SCREENSHOT_W);
const dispScale0 = dispW0 / nCropW;
const dispH0 = Math.round(nCropH * dispScale0);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: dispW0 + 40, height: dispH0 + 40 }, deviceScaleFactor: 1 });

const consoleErrors = [];
page.on("pageerror", (err) => consoleErrors.push("pageerror: " + String(err)));
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push("console.error: " + msg.text());
});

await page.goto(url, { waitUntil: "load" });

let idle = true;
try {
  await page.waitForFunction(() => window.__ready === true, { timeout: 90000 });
} catch {
  idle = false;
}
await page.waitForTimeout(500);

const info = await page.evaluate(() => ({
  errs: window.__errs || [],
  tilesFetched: window.__tilesFetched || 0,
  tilesFailed: window.__tilesFailed || [],
  tileTemplate: window.__tileTemplate,
  layerCounts: window.__layerCounts,
  labelStats: window.__labelStats,
  canvasW: window.__canvasW,
  canvasH: window.__canvasH,
  crop: window.__crop,
  dispW: window.__dispW,
  dispH: window.__dispH,
}));

await page.locator("#display").screenshot({ path: OUT });

// ---- stacked composite vs the board ----------------------------------------
const b64 = (p) => readFileSync(p).toString("base64");
const panel = (cap, sub, imgPath) =>
  `<div class="cap">${cap}</div><div class="sub">${sub}</div>` + `<img src="data:image/png;base64,${b64(imgPath)}">`;
const compHtml = `<!doctype html><meta charset="utf-8">
<style>
  body{margin:0;background:#F6F1E7;font-family:Segoe UI,system-ui,sans-serif}
  .cap{padding:14px 18px 4px;font-size:19px;color:#2B2620;font-weight:700}
  .sub{padding:0 18px 10px;font-size:14px;color:#6B6155}
  img{display:block;max-width:1376px;width:100%;border-top:1px solid #D8CEBB}
</style>
${panel(
  "A · LOCKED reveal board — the mood target (hand-illustrated)",
  "design/refs/d1.1-reveal-LOCKED-palette.png",
  BOARD
)}
${panel(
  "B · render-engine v0 — real OpenFreeMap JB geometry painted with our textures + Rough.js",
  `tiles fetched: ${info.tilesFetched} / ${nTileCount} · labels: ${JSON.stringify(info.labelStats)} · new textures + curved water labels + torn washi + fine-marker route`,
  OUT
)}`;
const page2 = await browser.newPage({ viewport: { width: 1376, height: 900 }, deviceScaleFactor: 1 });
await page2.setContent(compHtml, { waitUntil: "load" });
await page2.screenshot({ path: COMP_OUT, fullPage: true });

await browser.close();
server.close();

const errors = [...info.errs, ...info.tilesFailed.map((t) => `tile ${t.tx},${t.ty}: ${t.error}`), ...consoleErrors];
const ok = idle && errors.length === 0 && info.tilesFetched > 0;

console.log(
  JSON.stringify(
    {
      ok,
      idle,
      tilesFetched: info.tilesFetched,
      tilesExpected: nTileCount,
      tileTemplate: info.tileTemplate,
      layerCounts: info.layerCounts,
      labelStats: info.labelStats,
      canvasW: info.canvasW,
      canvasH: info.canvasH,
      crop: info.crop,
      dispW: info.dispW,
      dispH: info.dispH,
      errors,
      out: OUT,
      composite: COMP_OUT,
    },
    null,
    2
  )
);
