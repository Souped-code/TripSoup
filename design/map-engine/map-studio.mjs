// map-studio.mjs
// "Map Studio" — a live browser-based tuning tool for the journal map render.
// THIN WRAPPER ONLY: all paint/projection/label/decode logic lives in
// map-render-core.js (imported by the browser, untouched here). This file
// just (a) starts a local static server for the studio page + the shared
// core module + the 4 textures, and (b) defines the studio page's CONFIG
// defaults + a declarative CONTROLS table that binds DOM inputs to CONFIG
// fields. No render logic is duplicated.
//
// usage: node map-studio.mjs
//   -> starts a local http server, prints its URL, and stays running until
//      you stop it (Ctrl+C). Open the URL in a browser to tune the map.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

// ============================================================================
// CONFIG defaults — copied verbatim from render-engine.mjs's CONFIG (so the
// studio opens on the exact same look), with ONE deliberate override: SCALE
// 2 -> 4. Z stays 11 (its sparse geometry is what reads like the hand-drawn
// board — do not raise it) but is exposed as a slider for exploration; SCALE
// is bumped to 4 by default so that same sparse Z11 geometry paints at higher
// resolution (crisper), and is exposed as a slider too. Every other field is
// unchanged from render-engine.mjs.
// ============================================================================
const CONFIG_DEFAULTS = {
  Z: 11, // render zoom — Z11's sparser road geometry reads more like the hand-drawn board than Z12. Do not raise.
  EXTENT_FALLBACK: 4096, // MVT extent fallback if layer.extent is missing
  TILE: 256, // base slippy-tile size (px)
  SCALE: 4, // STUDIO OVERRIDE (render-engine.mjs default is 2) — upscale factor -> tilePx = TILE*SCALE; higher
  // SCALE paints the same sparse Z11 geometry at higher resolution instead of raising Z. Exposed as a slider.
  BBOX: { W: 103.62, E: 103.98, N: 1.57, S: 1.37 }, // fetch footprint — deliberately wider than VIEW_BBOX so
  // geometry bleeds to the crop edges. Not exposed as a control (VIEW_BBOX below is the tunable crop window;
  // its slider ranges are kept safely inside this fetch footprint so the crop never runs into unfetched tiles).
  VIEW_BBOX: { W: 103.67, E: 103.88, N: 1.525, S: 1.408 }, // tight JB city + Straits crop window (sub-rect of BBOX)
  MAX_SCREENSHOT_W: 1600, // display-canvas width cap; crop is downscaled onto this only if wider than the cap
  FILL_RULE: "nonzero",

  TEXTURE_SCALE: 0.4, // CanvasPattern scale — shared by land/water/park patterns (one knob, not three)

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
    washiShade: "rgba(120,90,20,0.30)",
    washiSheen: "rgba(255,255,255,0.20)",
    vignetteEdge: "rgba(74,58,38,0.20)",
  },
  WIDTHS: {
    coast: 1.6,
    waterway: 1.2,
    roadMajor: 2.6,
    roadSecondary: 1.6,
    route: 3.4, // NOTE: unused by the current paint code (drawMarkerRoute uses ROUTE_WIDTH/ROUTE_BLEED_EXTRA
    // instead) — kept in config for shape-parity with render-engine.mjs but deliberately not exposed as a
    // studio control since moving it would have no visible effect.
    pinStroke: 2.3,
    washiStroke: 1.6,
  },
  ROUGHNESS: { coast: 1.4, road: 1.2, route: 1.6 },
  BOWING: { coast: 1, route: 2 },
  ALPHA: { park: 0.4, weathering: 0.22 },

  ROUTE_WIDTH: 3,
  ROUTE_BLEED_EXTRA: 2,
  ROUTE_BLEED_ALPHA: 0.3,
  ROUTE_SMOOTH: true, // NOTE: also not currently read by map-render-core.js (strokeSmoothPath always smooths) —
  // kept for shape-parity, not exposed as a control for the same reason as WIDTHS.route above.

  WASHI_ALPHA: 0.82,
  WASHI_TEAR_SEGMENTS: 6,
  WASHI_TEAR_AMP: 2.6,
  WASHI_TEAR_SEED: 20260705,

  WATER_LABEL: {
    fontStyle: "italic",
    fontFamily: "'Gochi Hand'",
    fontBase: 24,
    fontMin: 13,
    fontMax: 40,
    fillFrac: 0.86,
    cloudRadiusFrac: 0.09, // BUG FIX — was 0.17 (see render-engine.mjs CONFIG for the full note); local-water-
    // body-only spine radius, paired with map-render-core.js's anchor-centered drawCurvedLabel.
    minCloud: 40,
    buckets: 10,
    trim: 0.1,
    smoothPasses: 1,
    letterSpacing: 1.5,
    haloWidth: 5,
    glyphSkipMargin: 4,
  },
  POINT_LABEL: {
    haloPad: 3,
    haloWidth: 6,
    nudges: [ [0, 0], [0, -1], [0, 1], [-1, 0], [1, 0] ],
    nudgeStep: 0.9,
    pinPad: 4,
  },

  FONT_LABEL: "28px 'Gochi Hand'",
  FONT_WATER_NAME: "italic 24px 'Gochi Hand'",
  FONT_PIN_NUM: "bold 18px 'Segoe UI', sans-serif",
  FONT_WASHI: "bold 16px 'Segoe UI', sans-serif",

  PIN_DIAMETER: 36,
  WASHI_W: 118,
  WASHI_H: 32,

  ROAD_CLASSES_MAJOR: ["motorway", "trunk", "primary"],
  ROAD_CLASSES_SECONDARY: ["secondary"],
  PARK_LANDCOVER_CLASSES: ["wood", "grass", "meadow"],
  PLACE_CLASSES: ["city", "town"],

  ROUTE_POINTS: [
    [103.720, 1.500],
    [103.750, 1.475],
    [103.770, 1.458],
    [103.800, 1.452],
    [103.820, 1.428],
  ],
  WASHI_INDEX: 3,
};

// ============================================================================
// Required local files
// ============================================================================
const TEXTURE_FILES = ["tex-land.png", "tex-water.png", "tex-park.png", "tex-weathering.png"];
const CORE_FILE = "map-render-core.js";
for (const f of [...TEXTURE_FILES, CORE_FILE]) {
  if (!existsSync(here("./" + f))) {
    console.error(JSON.stringify({ ok: false, error: `missing required file: ${f}` }));
    process.exit(1);
  }
}

// ============================================================================
// Client-side studio script. Imports the shared render core (map-render-core.js,
// served locally below) and drives it with a mutable `config` object built
// from CONFIG_DEFAULTS. A declarative CONTROLS table (group, label, input
// type, get/set closures, min/max/step, `view` flag) both builds the left
// control panel DOM and wires each input's live handler — no per-control
// boilerplate, and no paint logic: every visual change is just a mutation of
// `config` followed by MapRenderCore.fetchAndDecode / paintFull.
//
// View-vs-repaint split: fetchAndDecode() caches its result keyed on
// {Z,BBOX,TILE,SCALE,EXTENT_FALLBACK} (see map-render-core.js). VIEW_BBOX is
// NOT part of that key, so calling fetchAndDecode(config) (no force flag)
// after a VIEW_BBOX-only change is a free cache hit -> effectively a repaint;
// after a Z or SCALE change the key differs -> automatic real fetch. Calling
// plain fetchAndDecode(config) (rather than always passing {force:true}) on
// every View/Z/SCALE control therefore gives the correct behavior in both
// cases without ever forcing a redundant network re-fetch on a pure crop-
// window drag, which is the most frequent tuning interaction.
// ============================================================================
const clientScript = `
import * as MapRenderCore from './map-render-core.js';

var DEFAULT_CONFIG = ${JSON.stringify(CONFIG_DEFAULTS)};
var config = structuredClone(DEFAULT_CONFIG);

// ---- path-based get/set for simple dotted CONFIG fields --------------------
function pathAcc(path) {
  var parts = path.split('.');
  return {
    get: function (cfg) { var o = cfg; for (var i = 0; i < parts.length; i++) o = o[parts[i]]; return o; },
    set: function (cfg, val) { var o = cfg; for (var i = 0; i < parts.length - 1; i++) o = o[parts[i]]; o[parts[parts.length - 1]] = val; },
  };
}
function ctl(group, label, type, path, min, max, step, isView) {
  var acc = pathAcc(path);
  return { group: group, label: label, type: type, get: acc.get, set: acc.set, min: min, max: max, step: step, view: !!isView };
}
function ctlCustom(group, label, type, getFn, setFn, min, max, step, isView) {
  return { group: group, label: label, type: type, get: getFn, set: setFn, min: min, max: max, step: step, view: !!isView };
}
function roadToggle(className, arrayPath) {
  var acc = pathAcc(arrayPath);
  return {
    get: function (cfg) { return acc.get(cfg).indexOf(className) !== -1; },
    set: function (cfg, checked) {
      var arr = acc.get(cfg).slice();
      var idx = arr.indexOf(className);
      if (checked && idx === -1) arr.push(className);
      if (!checked && idx !== -1) arr.splice(idx, 1);
      acc.set(cfg, arr);
    },
  };
}
function parseRgba(str) {
  var m = /rgba?\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*(?:,\\s*([\\d.]+))?\\s*\\)/.exec(str || '');
  if (!m) return { r: 0, g: 0, b: 0, a: 1 };
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
}
function hex2(n) { var s = Math.round(n).toString(16); return s.length < 2 ? '0' + s : s; }
function rgbToHex(r, g, b) { return '#' + hex2(r) + hex2(g) + hex2(b); }
function hexToRgb(hex) {
  hex = hex.replace('#', '');
  return { r: parseInt(hex.substr(0, 2), 16), g: parseInt(hex.substr(2, 2), 16), b: parseInt(hex.substr(4, 2), 16) };
}

// ---- control table (grouped per the brief: view/water/land/parks/roads/labels/route/washi/weathering) -----
var CONTROLS = [];
CONTROLS.push(ctl('View', 'Crop West (lon)', 'range', 'VIEW_BBOX.W', 103.63, 103.76, 0.001, true));
CONTROLS.push(ctl('View', 'Crop East (lon)', 'range', 'VIEW_BBOX.E', 103.80, 103.97, 0.001, true));
CONTROLS.push(ctl('View', 'Crop North (lat)', 'range', 'VIEW_BBOX.N', 1.48, 1.565, 0.001, true));
CONTROLS.push(ctl('View', 'Crop South (lat)', 'range', 'VIEW_BBOX.S', 1.375, 1.45, 0.001, true));
CONTROLS.push(ctl('View', 'Zoom (Z) — do not raise past 11 for the board look', 'range', 'Z', 9, 14, 1, true));
CONTROLS.push(ctl('View', 'Scale (resolution multiplier)', 'range', 'SCALE', 1, 6, 0.5, true));

CONTROLS.push(ctl('Water', 'Coast Stroke Color', 'color', 'COLORS.coastStroke'));
CONTROLS.push(ctl('Water', 'Coast Stroke Width', 'range', 'WIDTHS.coast', 0.2, 5, 0.1));

CONTROLS.push(ctl('Land', 'Texture Scale (shared: land/water/park pattern tiling)', 'range', 'TEXTURE_SCALE', 0.1, 1.5, 0.01));

CONTROLS.push(ctl('Parks', 'Park Fill Opacity', 'range', 'ALPHA.park', 0, 1, 0.01));

CONTROLS.push(ctl('Roads', 'Major Road Color', 'color', 'COLORS.roadMajor'));
CONTROLS.push(ctl('Roads', 'Major Road Width', 'range', 'WIDTHS.roadMajor', 0.5, 6, 0.1));
CONTROLS.push(ctl('Roads', 'Secondary Road Color', 'color', 'COLORS.roadSecondary'));
CONTROLS.push(ctl('Roads', 'Secondary Road Width', 'range', 'WIDTHS.roadSecondary', 0.5, 6, 0.1));
(function () {
  var t1 = roadToggle('motorway', 'ROAD_CLASSES_MAJOR');
  CONTROLS.push(ctlCustom('Roads', 'Show motorway', 'checkbox', t1.get, t1.set));
  var t2 = roadToggle('trunk', 'ROAD_CLASSES_MAJOR');
  CONTROLS.push(ctlCustom('Roads', 'Show trunk', 'checkbox', t2.get, t2.set));
  var t3 = roadToggle('primary', 'ROAD_CLASSES_MAJOR');
  CONTROLS.push(ctlCustom('Roads', 'Show primary', 'checkbox', t3.get, t3.set));
  var t4 = roadToggle('secondary', 'ROAD_CLASSES_SECONDARY');
  CONTROLS.push(ctlCustom('Roads', 'Show secondary', 'checkbox', t4.get, t4.set));
  var t5 = roadToggle('tertiary', 'ROAD_CLASSES_SECONDARY');
  CONTROLS.push(ctlCustom('Roads', 'Show tertiary (renders in secondary style — no separate tertiary style exists)', 'checkbox', t5.get, t5.set));
})();

CONTROLS.push(ctl('Labels', 'Water Label Font Min', 'range', 'WATER_LABEL.fontMin', 8, 30, 1));
CONTROLS.push(ctl('Labels', 'Water Label Font Max', 'range', 'WATER_LABEL.fontMax', 20, 60, 1));
CONTROLS.push(ctl('Labels', 'Water Label Letter Spacing', 'range', 'WATER_LABEL.letterSpacing', 0, 5, 0.1));
CONTROLS.push(ctlCustom('Labels', 'Point Label Size (px)', 'range',
  function (cfg) { return parseInt(cfg.FONT_LABEL, 10); },
  function (cfg, val) { cfg.FONT_LABEL = val + "px 'Gochi Hand'"; },
  12, 40, 1));
CONTROLS.push(ctl('Labels', 'Point Label Halo Width', 'range', 'POINT_LABEL.haloWidth', 0, 12, 0.5));

CONTROLS.push(ctl('Route', 'Route Line Color', 'color', 'COLORS.routeLine'));
CONTROLS.push(ctl('Route', 'Route Width', 'range', 'ROUTE_WIDTH', 0.5, 8, 0.1));
CONTROLS.push(ctl('Route', 'Route Bleed Extra', 'range', 'ROUTE_BLEED_EXTRA', 0, 8, 0.1));
CONTROLS.push(ctl('Route', 'Route Bleed Alpha', 'range', 'ROUTE_BLEED_ALPHA', 0, 1, 0.01));

CONTROLS.push(ctl('Washi', 'Washi Fill Color', 'color', 'COLORS.washiFill'));
CONTROLS.push(ctl('Washi', 'Washi Alpha', 'range', 'WASHI_ALPHA', 0, 1, 0.01));
CONTROLS.push(ctl('Washi', 'Washi Tear Amplitude', 'range', 'WASHI_TEAR_AMP', 0, 10, 0.1));
CONTROLS.push(ctl('Washi', 'Washi Tear Segments', 'range', 'WASHI_TEAR_SEGMENTS', 2, 14, 1));

CONTROLS.push(ctl('Weathering', 'Weathering Opacity', 'range', 'ALPHA.weathering', 0, 1, 0.01));
CONTROLS.push(ctlCustom('Weathering', 'Vignette Color', 'color',
  function (cfg) { var p = parseRgba(cfg.COLORS.vignetteEdge); return rgbToHex(p.r, p.g, p.b); },
  function (cfg, hex) { var p = parseRgba(cfg.COLORS.vignetteEdge); var c = hexToRgb(hex); cfg.COLORS.vignetteEdge = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + p.a + ')'; }));
CONTROLS.push(ctlCustom('Weathering', 'Vignette Strength', 'range',
  function (cfg) { return parseRgba(cfg.COLORS.vignetteEdge).a; },
  function (cfg, val) { var p = parseRgba(cfg.COLORS.vignetteEdge); cfg.COLORS.vignetteEdge = 'rgba(' + p.r + ',' + p.g + ',' + p.b + ',' + val + ')'; },
  0, 1, 0.01));

// ---- readout formatting -----------------------------------------------------
function fmt(v) {
  var n = typeof v === 'string' ? parseFloat(v) : v;
  if (typeof n !== 'number' || !isFinite(n)) return String(v);
  return (Math.round(n * 1000) / 1000).toString();
}
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

// ---- build the left control panel DOM from CONTROLS -------------------------
var panelEl = document.getElementById('panel');
var groupEls = {};
function ensureGroup(name) {
  if (groupEls[name]) return groupEls[name];
  var fs = document.createElement('fieldset');
  var lg = document.createElement('legend');
  lg.textContent = name;
  fs.appendChild(lg);
  panelEl.appendChild(fs);
  groupEls[name] = fs;
  return fs;
}
CONTROLS.forEach(function (c) {
  var fs = ensureGroup(c.group);
  var row = document.createElement('div');
  row.className = 'row';
  var label = document.createElement('label');
  label.textContent = c.label;
  row.appendChild(label);
  var input = document.createElement('input');
  input.setAttribute('data-testid', slug(c.group + '-' + c.label));
  if (c.type === 'color') {
    input.type = 'color';
    input.value = c.get(config);
  } else if (c.type === 'checkbox') {
    input.type = 'checkbox';
    input.checked = !!c.get(config);
  } else {
    input.type = 'range';
    input.min = String(c.min);
    input.max = String(c.max);
    input.step = String(c.step);
    input.value = String(c.get(config));
  }
  row.appendChild(input);
  var readout = null;
  if (c.type === 'range') {
    readout = document.createElement('span');
    readout.className = 'readout';
    readout.textContent = fmt(input.value);
    row.appendChild(readout);
  }
  fs.appendChild(row);
  c._input = input;
  c._readout = readout;
  input.addEventListener('input', function () {
    var val;
    if (c.type === 'color') val = input.value;
    else if (c.type === 'checkbox') val = input.checked;
    else val = parseFloat(input.value);
    c.set(config, val);
    if (readout) readout.textContent = fmt(val);
    schedule(c.view);
  });
});

// ---- paint pipeline: initial load, debounced repaint (non-view) / debounced
// fetch+repaint (view) -----------------------------------------------------
var canvas = document.getElementById('display');
var lastDecoded = null;
var textures = null;
var viewTimer = null;
var paintTimer = null;

// ---- colorblind simulation -- STUDIO-ONLY view state, not part of config /
// Copy-CONFIG (it's a testing lens, not a render parameter). Applied to the
// canvas's pixels AFTER paintFull paints, via a per-pixel 3x3 R/G/B matrix. --
var CB_MATRICES = {
  protanopia:   { r: [0.567, 0.433, 0.000], g: [0.558, 0.442, 0.000], b: [0.000, 0.242, 0.758] },
  deuteranopia: { r: [0.625, 0.375, 0.000], g: [0.700, 0.300, 0.000], b: [0.000, 0.300, 0.700] },
  tritanopia:   { r: [0.950, 0.050, 0.000], g: [0.000, 0.433, 0.567], b: [0.000, 0.475, 0.525] },
};
var cbMode = 'off';
function applyColorblindSim() {
  var m = CB_MATRICES[cbMode];
  if (!m) return; // 'off' (or unrecognized) -> leave paintFull's pixels untouched
  var cctx = canvas.getContext('2d');
  var imgData = cctx.getImageData(0, 0, canvas.width, canvas.height);
  var d = imgData.data;
  for (var i = 0; i < d.length; i += 4) {
    var r = d[i], g = d[i + 1], b = d[i + 2];
    d[i]     = m.r[0] * r + m.r[1] * g + m.r[2] * b;
    d[i + 1] = m.g[0] * r + m.g[1] * g + m.g[2] * b;
    d[i + 2] = m.b[0] * r + m.b[1] * g + m.b[2] * b;
  }
  cctx.putImageData(imgData, 0, 0);
}

window.__ready = false;
window.__paintCount = 0;
window.__errs = [];
window.__tilesFetched = 0;

window.addEventListener('error', function (e) { window.__errs.push('window error: ' + e.message); });
window.addEventListener('unhandledrejection', function (e) { window.__errs.push('unhandled rejection: ' + String(e.reason)); });

function doRepaint() {
  MapRenderCore.paintFull(canvas, config, lastDecoded, textures).then(function (stats) {
    applyColorblindSim();
    window.__paintCount++;
    window.__lastStats = stats;
  }).catch(function (e) { window.__errs.push('repaint error: ' + String((e && e.stack) || e)); });
}
function doViewUpdate() {
  MapRenderCore.fetchAndDecode(config).then(function (decoded) {
    lastDecoded = decoded;
    window.__tilesFetched = decoded.tilesFetched;
    return MapRenderCore.paintFull(canvas, config, lastDecoded, textures);
  }).then(function (stats) {
    applyColorblindSim();
    window.__paintCount++;
    window.__lastStats = stats;
  }).catch(function (e) { window.__errs.push('view-update error: ' + String((e && e.stack) || e)); });
}
function schedule(isView) {
  if (isView) {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(doViewUpdate, 250);
  } else {
    clearTimeout(paintTimer);
    paintTimer = setTimeout(doRepaint, 40);
  }
}

function boot() {
  return Promise.all([
    MapRenderCore.preloadLibs(),
    MapRenderCore.loadImage('/tex-land.png'),
    MapRenderCore.loadImage('/tex-water.png'),
    MapRenderCore.loadImage('/tex-park.png'),
    MapRenderCore.loadImage('/tex-weathering.png'),
  ]).then(function (res) {
    textures = { land: res[1], water: res[2], park: res[3], weathering: res[4] };
    return MapRenderCore.fetchAndDecode(config);
  }).then(function (decoded) {
    lastDecoded = decoded;
    window.__tilesFetched = decoded.tilesFetched;
    return MapRenderCore.paintFull(canvas, config, lastDecoded, textures);
  }).then(function (stats) {
    applyColorblindSim();
    window.__paintCount = 1;
    window.__lastStats = stats;
  });
}
boot().catch(function (e) { window.__errs.push('boot error: ' + String((e && e.stack) || e)); }).finally(function () { window.__ready = true; });

// ---- buttons -----------------------------------------------------------
document.getElementById('btn-copy').addEventListener('click', function () {
  var json = JSON.stringify(config, null, 2);
  var ta = document.getElementById('config-output');
  ta.style.display = 'block';
  ta.value = json;
  ta.focus();
  ta.select();
  var status = document.getElementById('copy-status');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(json).then(function () {
      status.textContent = 'Copied to clipboard (also shown below).';
    }).catch(function () {
      status.textContent = 'Clipboard blocked by the browser -- copy manually from the box below.';
    });
  } else {
    status.textContent = 'Clipboard API unavailable -- copy manually from the box below.';
  }
});
document.getElementById('btn-download').addEventListener('click', function () {
  canvas.toBlob(function (blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'map-studio.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
});
document.getElementById('cb-sim').addEventListener('change', function (e) {
  cbMode = e.target.value;
  doRepaint(); // always repaint from the cache: paintFull redraws the TRUE
  // colors fresh, then applyColorblindSim() (above) applies the newly-picked
  // mode on top -- switching modes never compounds onto an already-simulated
  // frame, and picking "Off" cleanly restores the true colors.
});
document.getElementById('btn-reset').addEventListener('click', function () {
  config = structuredClone(DEFAULT_CONFIG);
  CONTROLS.forEach(function (c) {
    var val = c.get(config);
    if (c.type === 'color') { c._input.value = val; }
    else if (c.type === 'checkbox') { c._input.checked = !!val; }
    else { c._input.value = String(val); if (c._readout) c._readout.textContent = fmt(val); }
  });
  clearTimeout(viewTimer);
  clearTimeout(paintTimer);
  doViewUpdate();
});
`;

// ============================================================================
// Page shell — plain/utilitarian chrome (this is a dev tool, not the product).
// Left: scrollable control panel (#panel, filled by clientScript). Right:
// toolbar + live canvas (#display) + the Copy-CONFIG textarea.
// ============================================================================
const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Map Studio</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Gochi+Hand&display=swap">
<style>
  html,body{margin:0;height:100%;font-family:system-ui,Segoe UI,sans-serif;font-size:13px}
  body{display:flex}
  #panel{width:360px;flex:0 0 360px;height:100vh;overflow-y:auto;background:#f2f2f0;border-right:1px solid #ccc;padding:8px;box-sizing:border-box}
  #stage{flex:1 1 auto;height:100vh;overflow:auto;padding:12px;box-sizing:border-box;background:#dcdcd8}
  fieldset{margin:0 0 10px;padding:6px 8px;border:1px solid #bbb}
  legend{font-weight:600;padding:0 4px}
  .row{display:flex;align-items:center;gap:6px;margin:4px 0}
  .row label{flex:1 1 auto;min-width:0;line-height:1.2}
  .row input[type=range]{flex:1 1 90px;min-width:60px}
  .readout{width:56px;text-align:right;font-variant-numeric:tabular-nums;color:#333;font-family:monospace}
  .toolbar{margin-bottom:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  button{padding:5px 12px;cursor:pointer}
  #config-output{display:none;width:100%;max-width:900px;height:200px;margin-top:8px;font-family:monospace;font-size:12px;box-sizing:border-box}
  #copy-status{font-size:12px;color:#555}
  #display{display:block;background:#F6F1E7;max-width:100%;box-shadow:0 1px 4px rgba(0,0,0,0.3)}
</style>
</head><body>
<div id="panel"></div>
<div id="stage">
  <div class="toolbar">
    <button id="btn-copy">Copy CONFIG</button>
    <button id="btn-download">Download PNG</button>
    <button id="btn-reset">Reset</button>
    <label style="display:flex;align-items:center;gap:4px">Colorblind sim
      <select id="cb-sim" data-testid="colorblind-sim">
        <option value="off">Off</option>
        <option value="protanopia">Protanopia</option>
        <option value="deuteranopia">Deuteranopia</option>
        <option value="tritanopia">Tritanopia</option>
      </select>
    </label>
    <span id="copy-status"></span>
  </div>
  <canvas id="display"></canvas>
  <textarea id="config-output" readonly spellcheck="false"></textarea>
</div>
<script type="module">
${clientScript}
</script>
</body></html>`;

// ============================================================================
// Local static server: textures + map-render-core.js by filename, studio HTML
// at every other path. Ephemeral port (OS-assigned), same convention as
// render-engine.mjs.
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

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;
console.log(`Map Studio running at ${url}`);
console.log("Open this URL in a browser to tune the map live. Press Ctrl+C to stop.");
