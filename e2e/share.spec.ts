// P5 Playwright done-check: share link round-trip renders the same plan
// read-only — including a persisted leg toggle.

import { expect, test } from "@playwright/test";
import { FIXTURE_STOPS } from "../src/lib/maps/fixtureCity";

const byName = new Map(FIXTURE_STOPS.map((s) => [s.name, s]));

test("share link round-trip renders the same plan read-only", async ({ page }) => {
  // owner builds a day: old-town cluster so there is an eligible leg to toggle
  await page.goto("/");
  await page.getByTestId("new-trip").click();
  await expect(page.getByTestId("day-0")).toBeVisible();

  const names = ["Market Hall", "Clock Tower Square", "Guildhall Museum"];
  await page.getByTestId("paste-box").fill(names.join("\n"));
  await page.getByTestId("add-stops").click();
  for (const n of names) {
    await expect(page.getByTestId(`stop-${byName.get(n)!.id}`)).toBeVisible();
  }

  await page.getByTestId("optimize").click();
  await expect(page.getByTestId("plan")).toBeVisible();

  // toggle the first eligible leg so the share view must honour persistence
  const toggle = page.locator('[data-testid^="toggle-"]').first();
  await expect(toggle).toBeVisible();
  const toggleId = (await toggle.getAttribute("data-testid"))!; // toggle-<from>-<to>
  const legId = toggleId.replace(/^toggle-/, "leg-");
  await toggle.click();
  // wait for the re-planned result to land before capturing (avoid stale read)
  await expect(page.getByTestId(legId).getByTestId("leg-mode")).toHaveText("drive");

  const ownerOrder = await page.getByTestId("entry-name").allTextContents();
  const ownerTimes = await page.getByTestId("entry-time").allTextContents();
  const ownerModes = await page.getByTestId("leg-mode").allTextContents();

  // visit the share link
  const shareHref = await page.getByTestId("share-link").getAttribute("href");
  expect(shareHref).toBeTruthy();
  await page.goto(shareHref!);
  await expect(page.getByTestId("share-view")).toBeVisible();

  // same plan: order, times, leg modes (toggle included)
  expect(await page.getByTestId("entry-name").allTextContents()).toEqual(ownerOrder);
  expect(await page.getByTestId("entry-time").allTextContents()).toEqual(ownerTimes);
  expect(await page.getByTestId("leg-mode").allTextContents()).toEqual(ownerModes);

  // read-only: no toggles, no editing controls
  await expect(page.locator('[data-testid^="toggle-"]')).toHaveCount(0);
  await expect(page.getByTestId("optimize")).toHaveCount(0);
  await expect(page.getByTestId("paste-box")).toHaveCount(0);
});
