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

import { MAP_STYLE_DEFAULTS } from "../../src/lib/map/map-style-defaults.mjs";

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
  ...MAP_STYLE_DEFAULTS,
  // ---- VIEW (this tool's JB sample) — STYLE lives in src/lib/map/map-style-defaults.mjs
  Z: 11, // render zoom — Z11's sparser road geometry reads more like the hand-drawn board than Z12
  SCALE: 6, // Chris pass 2 (was 4) — higher-res bench output; REF_TILEPX normalization keeps proportions identical
  BBOX: { W: 103.62, E: 103.98, N: 1.57, S: 1.37 }, // fetch footprint — wider than VIEW_BBOX so geometry bleeds to the crop edges
  VIEW_BBOX: { W: 103.671, E: 103.88, N: 1.525, S: 1.408 }, // tight JB city + Straits crop window (sub-rect of BBOX)
  // [lon, lat] — the 5 sample JB points
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

// Shared browser-side render pipeline — moved to src/lib/map/ at M1 (it is
// the PRODUCT engine now); this harness still serves it at /map-render-core.js.
const CORE_FILE = "map-render-core.js"; // served URL name
const CORE_PATH = "../../src/lib/map/map-render-core.js"; // real location on disk
if (!existsSync(here(CORE_PATH))) {
  console.error(JSON.stringify({ ok: false, error: `missing shared render core: ${CORE_PATH}` }));
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
    res.end(readFileSync(here(CORE_PATH)));
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
