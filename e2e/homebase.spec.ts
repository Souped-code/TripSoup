// E6c — home base: detected from the paste ("staying at…" — the fixture parse
// adapter mirrors the LLM prompt's rule 11), shown and edited in the planner's
// pocket, persisted on the doc. Setting it goes through the same metered
// resolve boundary as every other lookup (fixture city here — $0).

import { expect, test } from "@playwright/test";

test("home base: paste-detected, editable in the pocket, persisted, clearable", async ({ page }) => {
  await page.goto("/");
  await page
    .getByTestId("greeting-paste")
    .fill(["Day 1", "staying at Market Hall", "Clock Tower Square", "Riverside Cafe"].join("\n"));
  await page.getByTestId("greeting-submit").click();
  await page.waitForURL(/\/trip\/[^/]+$/, { timeout: 15000 });
  await expect(page.getByTestId("trip-reveal")).toBeVisible();

  // Paste detection filled it in.
  await page.getByTestId("sidebar-pocket").locator("summary").click();
  await expect(page.getByTestId("sidebar-homebase-name")).toContainText("Market Hall");

  // E6d — the day now leaves the base and returns to it, visibly.
  await expect(page.getByTestId("sidebar-base-lead")).toContainText("Market Hall");
  await expect(page.getByTestId("sidebar-base-back")).toContainText("Market Hall");

  // Override it: resolves through the fixture city and persists via PUT.
  await page.getByTestId("sidebar-homebase-change").click();
  await page.getByTestId("sidebar-homebase-input").fill("Riverside Cafe");
  await page.getByTestId("sidebar-homebase-set").click();
  await expect(page.getByTestId("sidebar-homebase-name")).toContainText("Riverside Cafe", {
    timeout: 15000,
  });

  // Survives a reload — it's on the doc, not client state.
  await page.reload();
  await expect(page.getByTestId("trip-reveal")).toBeVisible();
  await page.getByTestId("sidebar-pocket").locator("summary").click();
  await expect(page.getByTestId("sidebar-homebase-name")).toContainText("Riverside Cafe");
  const tripId = page.url().match(/\/trip\/([^/]+)$/)![1];
  const saved = await (await page.request.get(`/api/trips/${tripId}`)).json();
  expect(saved.homeBase).toMatchObject({ id: "fx-04", source: "user" });

  // E6d — changing the base stales every day (it's in the solve projection),
  // so the re-plan re-cooked with the NEW base's legs.
  await expect(page.getByTestId("sidebar-base-lead")).toContainText("Riverside Cafe", {
    timeout: 15000,
  });

  // Clear it — back to the empty input, the doc drops the field, and the
  // depot rows leave the timeline with it.
  await page.getByTestId("sidebar-homebase-clear").click();
  await expect(page.getByTestId("sidebar-homebase-input")).toBeVisible({ timeout: 15000 });
  const cleared = await (await page.request.get(`/api/trips/${tripId}`)).json();
  expect(cleared.homeBase).toBeUndefined();
  await expect(page.getByTestId("sidebar-base-lead")).toHaveCount(0, { timeout: 15000 });
});
