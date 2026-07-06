// map-studio-smoketest.mjs
// Throwaway verification harness for map-studio.mjs (NOT part of the
// deliverable). Spawns `node map-studio.mjs` exactly as a user would, scrapes
// the printed URL, drives it headless with the repo's Playwright/chromium
// (same createRequire trick render-engine.mjs uses), asserts the canvas
// paints non-blank, changes one control and asserts a repaint fires with no
// new errors, then tears everything down (kills the child server process).

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRequire = createRequire("C:/Users/65881/dev/itinerary-optimiser/package.json");
const { chromium } = repoRequire("@playwright/test");

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

function startStudioServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [here("./map-studio.mjs")], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let settled = false;
    const onData = (buf) => {
      out += buf.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (m && !settled) {
        settled = true;
        resolve({ child, url: m[0] });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (buf) => { out += buf.toString(); });
    child.on("exit", (code) => {
      if (!settled) { settled = true; reject(new Error("map-studio.mjs exited before printing a URL (code " + code + "): " + out)); }
    });
    setTimeout(() => { if (!settled) { settled = true; reject(new Error("timed out waiting for server URL: " + out)); } }, 15000);
  });
}

const { child, url } = await startStudioServer();
console.log(JSON.stringify({ phase: "server-started", url }));

let ok = true;
const problems = [];
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });

  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push("pageerror: " + String(err)));
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push("console.error: " + msg.text()); });

  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 90000 });

  const boot = await page.evaluate(() => ({
    errs: window.__errs || [],
    paintCount: window.__paintCount || 0,
    tilesFetched: window.__tilesFetched || 0,
  }));
  console.log(JSON.stringify({ phase: "boot", boot }));

  if (boot.errs.length) { ok = false; problems.push("boot errors: " + JSON.stringify(boot.errs)); }
  if (boot.paintCount < 1) { ok = false; problems.push("paintCount is 0 after boot"); }
  if (boot.tilesFetched < 1) { ok = false; problems.push("tilesFetched is 0 after boot"); }

  // ---- canvas non-blank check: sample pixels across the buffer, require
  // opaque alpha everywhere and some real color variance (not a flat fill). --
  const pixelCheck = await page.evaluate(() => {
    const c = document.getElementById("display");
    const ctx = c.getContext("2d");
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonOpaque = 0, samples = 0;
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 997) {
      samples++;
      if (data[i + 3] !== 255) nonOpaque++;
      seen.add(data[i] + "," + data[i + 1] + "," + data[i + 2]);
    }
    return { w: c.width, h: c.height, samples, nonOpaque, distinctColors: seen.size };
  });
  console.log(JSON.stringify({ phase: "pixel-check", pixelCheck }));
  if (!(pixelCheck.w > 0 && pixelCheck.h > 0)) { ok = false; problems.push("canvas has zero size"); }
  if (pixelCheck.distinctColors < 3) { ok = false; problems.push("canvas looks blank/flat (distinctColors=" + pixelCheck.distinctColors + ")"); }

  // ---- change one control (a color input, non-view group -> cheap repaint
  // path) and confirm a repaint fires with no new errors. -------------------
  const before = await page.evaluate(() => ({ paintCount: window.__paintCount, errs: window.__errs.length }));
  const routeColorInput = page.locator('[data-testid="route-route-line-color"]');
  await routeColorInput.waitFor({ state: "attached", timeout: 5000 });
  await routeColorInput.evaluate((el) => {
    el.value = "#ff3300";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(
    (prevCount) => window.__paintCount > prevCount,
    before.paintCount,
    { timeout: 3000 }
  );
  const after = await page.evaluate(() => ({ paintCount: window.__paintCount, errs: window.__errs.slice() }));
  console.log(JSON.stringify({ phase: "control-change", before, after }));
  if (after.paintCount <= before.paintCount) { ok = false; problems.push("repaint did not fire after control change"); }
  if (after.errs.length > before.errs) { ok = false; problems.push("new errors after control change: " + JSON.stringify(after.errs)); }
  if (consoleErrors.length) { ok = false; problems.push("console/page errors: " + JSON.stringify(consoleErrors)); }

  // ---- also verify a VIEW-group change (Z) still triggers a (slower) repaint,
  // exercising the fetchAndDecode path. ---------------------------------------
  const beforeView = await page.evaluate(() => ({ paintCount: window.__paintCount, tilesFetched: window.__tilesFetched }));
  const scaleInput = page.locator('[data-testid="view-scale-resolution-multiplier"]');
  await scaleInput.waitFor({ state: "attached", timeout: 5000 });
  await scaleInput.evaluate((el) => {
    el.value = "2";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(
    (prevCount) => window.__paintCount > prevCount,
    beforeView.paintCount,
    { timeout: 5000 }
  );
  const afterView = await page.evaluate(() => ({ paintCount: window.__paintCount, tilesFetched: window.__tilesFetched, errs: window.__errs.slice() }));
  console.log(JSON.stringify({ phase: "view-change", beforeView, afterView }));
  if (afterView.paintCount <= beforeView.paintCount) { ok = false; problems.push("view-change repaint did not fire"); }
  if (afterView.errs.length > after.errs.length) { ok = false; problems.push("new errors after view change: " + JSON.stringify(afterView.errs)); }

  // ---- colorblind sim: sample canvas pixels, switch Off -> Protanopia,
  // confirm a repaint fires and the pixels actually changed, then switch back
  // to Off and confirm the ORIGINAL colors are restored (not compounded). ----
  const samplePixels = () => {
    const c = document.getElementById("display");
    const ctx = c.getContext("2d");
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const out = [];
    for (let i = 0; i < data.length; i += 4 * 613) out.push(data[i], data[i + 1], data[i + 2]);
    return out;
  };
  const arraysEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  const cbBefore = await page.evaluate(() => ({ paintCount: window.__paintCount, errs: window.__errs.length }));
  const trueColorPixels = await page.evaluate(samplePixels);
  const cbSelect = page.locator('[data-testid="colorblind-sim"]');
  await cbSelect.waitFor({ state: "attached", timeout: 5000 });

  await cbSelect.evaluate((el) => { el.value = "protanopia"; el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForFunction((prevCount) => window.__paintCount > prevCount, cbBefore.paintCount, { timeout: 3000 });
  const cbAfter = await page.evaluate(() => ({ paintCount: window.__paintCount, errs: window.__errs.slice() }));
  const protanopiaPixels = await page.evaluate(samplePixels);
  console.log(JSON.stringify({ phase: "colorblind-on", cbBefore, cbAfter: { paintCount: cbAfter.paintCount, errs: cbAfter.errs.length } }));
  if (cbAfter.paintCount <= cbBefore.paintCount) { ok = false; problems.push("colorblind-sim change did not trigger a repaint"); }
  if (cbAfter.errs.length > afterView.errs.length) { ok = false; problems.push("new errors after enabling colorblind sim: " + JSON.stringify(cbAfter.errs)); }
  if (arraysEqual(trueColorPixels, protanopiaPixels)) { ok = false; problems.push("colorblind sim (protanopia) did not visibly change canvas pixels"); }

  await cbSelect.evaluate((el) => { el.value = "off"; el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForFunction((prevCount) => window.__paintCount > prevCount, cbAfter.paintCount, { timeout: 3000 });
  const restoredPixels = await page.evaluate(samplePixels);
  // Rough.js strokes are seeded per feature since the 2026-07-06 fidelity
  // pass, so repaints with identical config are byte-identical (this check
  // now measures meanDiff 0). The mean-diff tolerance is kept as a guard: a
  // small diff would mean antialiasing drift crept in; a large one would mean
  // the sim compounded instead of resetting from the true colors each time.
  const diffs = trueColorPixels.map((v, i) => Math.abs(v - restoredPixels[i]));
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const maxDiff = Math.max(...diffs);
  console.log(JSON.stringify({ phase: "colorblind-off", exactMatch: arraysEqual(trueColorPixels, restoredPixels), meanDiff, maxDiff }));
  if (meanDiff > 15) { ok = false; problems.push("switching colorblind sim back to Off did not restore the true colors (meanDiff=" + meanDiff + ", compounding bug?)"); }

} catch (e) {
  ok = false;
  problems.push("exception: " + String((e && e.stack) || e));
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  await new Promise((r) => { child.once("exit", r); setTimeout(r, 3000); });
}

console.log(JSON.stringify({ ok, problems }, null, 2));
process.exit(ok ? 0 : 1);
