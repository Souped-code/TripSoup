// P5 Playwright done-check: share link round-trip renders the same plan
// read-only — including a persisted leg toggle.
//
// E4: the share page reads the trip's PERSISTED plan (src/lib/planStore.ts's
// readPlanned) — it must never recompute by calling /api/trips/*/plan, since
// that route belongs to the OWNER's editing flow. This is asserted directly
// below by recording every network request the share page load makes.

import { expect, test } from "@playwright/test";
import { FIXTURE_STOPS } from "../src/lib/maps/fixtureCity";

const byName = new Map(FIXTURE_STOPS.map((s) => [s.name, s]));

test("share link round-trip renders the same plan read-only", async ({ page }) => {
  // owner builds a day: old-town cluster so there is an eligible leg to toggle
  await page.goto("/debug/trip");
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

  // visit the share link — record every request the load makes, so we can
  // assert it never recomputes via the plan API (E4: it must read the
  // persisted plan, not re-solve).
  const planRequests: string[] = [];
  page.on("request", (req) => {
    if (/\/api\/trips\/[^/]+\/plan(?:$|\?)/.test(new URL(req.url()).pathname)) {
      planRequests.push(`${req.method()} ${req.url()}`);
    }
  });

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

  // E4: zero requests to /api/trips/*/plan on the share page — it read the
  // persisted plan, it never re-solved.
  expect(planRequests).toEqual([]);
});
