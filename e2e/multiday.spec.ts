// Multi-day board: add a second day, stops and failures stay scoped per day.

import { expect, test } from "@playwright/test";
import { FIXTURE_STOPS } from "../src/lib/maps/fixtureCity";

const byName = new Map(FIXTURE_STOPS.map((s) => [s.name, s]));

test("second day has its own stops, paste box, and failure panel", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-trip").click();
  await expect(page.getByTestId("day-0")).toBeVisible();

  await page.getByTestId("add-day").click();
  await expect(page.getByTestId("day-1")).toBeVisible();

  const day0 = page.getByTestId("day-0");
  const day1 = page.getByTestId("day-1");

  // add a valid stop to day 1 and a bogus line to day 2
  await day0.getByTestId("paste-box").fill("Market Hall");
  await day0.getByTestId("add-stops").click();
  const hall = byName.get("Market Hall")!;
  await expect(day0.getByTestId(`stop-${hall.id}`)).toBeVisible();

  await day1.getByTestId("paste-box").fill("Nonexistent Palace");
  await day1.getByTestId("add-stops").click();

  // failure renders under day 2 only; day 1 keeps its stop and no failures
  await expect(day1.getByTestId("resolve-failures")).toContainText("Nonexistent Palace");
  await expect(day0.getByTestId("resolve-failures")).toHaveCount(0);
  await expect(day1.locator('[data-testid^="stop-fx-"]')).toHaveCount(0);

  // day 1 optimizes independently
  await day0.getByTestId("optimize").click();
  await expect(day0.getByTestId("plan")).toBeVisible();
  await expect(day1.getByTestId("plan")).toHaveCount(0);
});
