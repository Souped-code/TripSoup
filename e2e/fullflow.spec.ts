// D2.3 T8 — THE full product journey in one spec, fixture-only, zero external
// network: paste a messy blob on the real greeting → the real /api/pipeline
// SSE cook → land on the reveal (journal map paints, torn sidebar rows with
// times) → keyboard drag-reorder (manualOrder, map re-paths) → per-leg §2
// toggle (re-times, never re-orders) → the share page mirrors the exact
// pinned order AND the user's leg pick, read-only.
//
// Tile traffic stubbed (engine tolerates 404 tiles by design); reduced motion
// emulated so choreography collapses to instant frames.

import { expect, test, type Page } from "@playwright/test";

const BLOB = [
  "Day 1",
  "Lunch at Clock Tower Square 1pm https://maps.google.com/?q=Clock+Tower+Square",
  "https://maps.google.com/?q=Guildhall+Museum",
  "https://maps.google.com/?q=Riverside+Cafe",
].join("\n");

async function stubTiles(page: Page) {
  await page.route("**/tiles.openfreemap.org/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/planet")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ tiles: ["https://tiles.openfreemap.org/stub/{z}/{x}/{y}.pbf"] }),
      });
    } else {
      await route.fulfill({ status: 404, body: "no tiles in the stub" });
    }
  });
}

// Same settle-pause keyboard path sidebar.spec.ts uses (dnd-kit's
// KeyboardSensor recomputes collision state on the browser's RAF loop).
async function keyboardDragOneSlotDown(page: Page, handleTestId: string) {
  await page.getByTestId(handleTestId).focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  await page.keyboard.press("Space");
}

async function sidebarRowOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="sidebar-row-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.replace("sidebar-row-", "")));
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("full flow: paste → cook → reveal → reorder → toggle → share", async ({ page }) => {
  await stubTiles(page);

  // 1. the greeting IS the product's front door — paste chaos, submit
  await page.goto("/");
  await page.getByTestId("greeting-paste").fill(BLOB);
  await page.getByTestId("greeting-submit").click();

  // 2. the real pipeline cooks and redirects to the reveal
  await page.waitForURL(/\/trip\/[^/]+$/, { timeout: 20000 });
  const tripId = page.url().match(/\/trip\/([^/]+)$/)![1];

  // 3. reveal: journal map paints, sidebar carries the three cooked stops
  const map = page.getByTestId("reveal-map");
  await expect(map).toHaveAttribute("data-phase", "ready", { timeout: 30000 });
  await expect(map).not.toHaveAttribute("data-paints", "0");
  const initialOrder = await sidebarRowOrder(page);
  expect(initialOrder.length).toBe(3);
  await expect(map).toHaveAttribute("data-order", initialOrder.join("|"));

  // 4. drag the first stop one slot down — manualOrder, map re-paths, the
  //    re-optimize control appears
  const pinned = [initialOrder[1], initialOrder[0], initialOrder[2]];
  await keyboardDragOneSlotDown(page, `sidebar-handle-${initialOrder[0]}`);
  await expect(map).toHaveAttribute("data-order", pinned.join("|"), { timeout: 15000 });
  await expect(page.getByTestId("sidebar-reoptimize")).toBeVisible({ timeout: 15000 });
  expect(await sidebarRowOrder(page)).toEqual(pinned);

  // 5. §2 surface: toggle the first eligible leg — mode flips, marked as the
  //    user's pick, and the pinned order does NOT change (re-time only)
  const firstToggle = page.locator('[data-testid^="sidebar-toggle-"]').first();
  await expect(firstToggle).toBeVisible({ timeout: 15000 });
  const pair = (await firstToggle.getAttribute("data-testid"))!.replace("sidebar-toggle-", "");
  const legBox = page.getByTestId(`sidebar-leg-${pair}`);
  const modeBefore = (await legBox.getByTestId("sidebar-leg-mode").textContent())!.trim();
  const modeAfter = modeBefore === "walk" ? "drive" : "walk";
  await firstToggle.click();
  await expect(legBox.getByTestId("sidebar-leg-mode")).toHaveText(modeAfter, { timeout: 15000 });
  await expect(legBox.getByTestId("sidebar-leg-times")).toContainText("your pick");
  await expect(map).toHaveAttribute("data-order", pinned.join("|"));

  // 6. the share page recomputes the same doc: exact pinned order, the leg
  //    pick honoured, and zero editing affordances
  await page.goto(`/share/${tripId}`);
  const shareIds = (
    await page
      .locator('[data-testid^="entry-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!))
  )
    .filter((t) => t !== "entry-time" && t !== "entry-name")
    .map((t) => t.replace("entry-", ""));
  expect(shareIds).toEqual(pinned);
  await expect(page.getByTestId(`leg-${pair}`).getByTestId("leg-mode")).toHaveText(modeAfter);
  await expect(page.locator('[data-testid^="toggle-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="sidebar-handle-"]')).toHaveCount(0);
});
