// E7 — notes become constraints, end to end at $0 (fixture compiler):
// paste-time compile -> evidence-tethered chips -> the solve honours them ->
// confirm/delete -> the standalone "tell Gracie more" compile.

import { expect, test, type Page } from "@playwright/test";

async function paste(page: Page, lines: string[]): Promise<string> {
  await page.goto("/");
  await page.getByTestId("greeting-paste").fill(lines.join("\n"));
  await page.getByTestId("greeting-submit").click();
  await page.waitForURL(/\/trip\/[^/]+$/, { timeout: 15000 });
  await expect(page.getByTestId("trip-reveal")).toBeVisible();
  return page.url().match(/\/trip\/([^/]+)$/)![1];
}

test("paste notes compile into chips with evidence, and the solve honours the window", async ({ page }) => {
  const tripId = await paste(page, [
    "Day 1",
    "Market Hall at sunset",
    "Riverside Cafe",
    "mum walks slow so keep it chill",
  ]);

  // Trip-level pace chip, evidence carried from the paste.
  const tripChips = page.getByTestId("sidebar-trip-chips");
  await expect(tripChips).toContainText("chill pace");
  await expect(tripChips).toContainText("walks slow");

  // Market Hall wears its sunset window chip…
  const hallChips = page.getByTestId("sidebar-chips-fx-01");
  await expect(hallChips).toContainText("17:30–19:30");
  await expect(hallChips).toContainText("sunset");

  // UNCONFIRMED, the window is a soft nudge: the schedule walk never idles
  // for a guess, so a two-stop morning can't reach sunset yet. CONFIRMING is
  // what makes it binding (hard window -> the walk waits for it) — the whole
  // soft-until-confirmed ladder, exercised here.
  await hallChips.getByTestId("constraint-chip-confirm").click();
  await expect(
    page.getByTestId("sidebar-chips-fx-01").locator('[data-chip-confirmed="1"]')
  ).toHaveCount(1, { timeout: 15000 });

  const doc = await (await page.request.get(`/api/trips/${tripId}`)).json();
  const entry = doc.plan.days[0].entries.find((e: { stopId: string }) => e.stopId === "fx-01");
  expect(entry.startMin).toBeGreaterThanOrEqual(1050);
  expect(entry.startMin).toBeLessThanOrEqual(1170);

  // The confirm persisted across reload.
  await page.reload();
  await expect(page.getByTestId("trip-reveal")).toBeVisible();
  await expect(
    page.getByTestId("sidebar-chips-fx-01").locator('[data-chip-confirmed="1"]')
  ).toHaveCount(1);

  // Delete the pace chip: gone, and gone after reload too.
  await page.getByTestId("sidebar-trip-chips").getByTestId("constraint-chip-delete").click();
  await expect(page.getByTestId("sidebar-trip-chips")).toHaveCount(0, { timeout: 15000 });
  await page.reload();
  await expect(page.getByTestId("trip-reveal")).toBeVisible();
  await expect(page.getByTestId("sidebar-trip-chips")).toHaveCount(0);
});

test("the pocket's 'tell Gracie more' compiles standalone notes into chips", async ({ page }) => {
  await paste(page, ["Day 1", "Market Hall", "Riverside Cafe"]);

  // No chips from a constraint-free paste.
  await expect(page.getByTestId("sidebar-chips-fx-01")).toHaveCount(0);

  await page.getByTestId("sidebar-pocket").locator("summary").click();
  await page
    .getByTestId("sidebar-notes-input")
    .fill("Market Hall last entry 4pm — must see it");
  await page.getByTestId("sidebar-notes-compile").click();

  const hallChips = page.getByTestId("sidebar-chips-fx-01");
  await expect(hallChips).toContainText("last entry 16:00", { timeout: 15000 });
  await expect(hallChips).toContainText("must-see");
});
