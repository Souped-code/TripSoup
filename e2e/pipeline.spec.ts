import { test, expect } from "@playwright/test";

// D2.2: the streaming pipeline, driven end to end through the real /api/pipeline
// SSE route in fixture mode (MAPS_PROVIDER=fixture, DEBUG_BOARD=1 — set for the
// whole Playwright webServer). Paste a synthetic blob of fixture-resolvable Maps
// URLs → observe genuine progress → reach the reveal handoff (tripId + plans).

// Four Casterbridge fixture stops as pasted Maps links, one with a label + a 2pm
// time (→ anchor), plus a "drop bags first" ordering line, and one bad link.
const BLOB = [
  "Day 1",
  "Drop bags at Market Hall first https://maps.google.com/?q=Market+Hall",
  "Lunch at Clock Tower Square 2pm https://maps.google.com/?q=Clock+Tower+Square",
  "https://maps.google.com/?q=Guildhall+Museum",
  "https://maps.google.com/?q=Riverside+Cafe",
  "https://maps.google.com/?q=Nonexistent+Palace",
].join("\n");

test.describe("pipeline streaming flow", () => {
  test("paste → real progress → reveal handoff with a persisted trip", async ({ page }) => {
    await page.goto("/debug/pipeline");

    await page.getByTestId("pipeline-paste").fill(BLOB);
    await page.getByTestId("pipeline-run").click();

    // The loading surface shows Gracie + the soup-pot progressbar bound to real
    // events (it may flash by quickly in fixture mode — either it's visible or
    // we've already reached done).
    const done = page.getByTestId("pipeline-done");
    await expect(done).toBeVisible({ timeout: 15000 });

    // Reveal handoff carries a real persisted trip id and the assembled shape:
    // one day (single "Day 1" marker), one unresolved link (Nonexistent Palace).
    await expect(page.getByTestId("pipeline-result-trip-id")).not.toBeEmpty();
    await expect(page.getByTestId("pipeline-result-days")).toContainText("1 day(s)");
    await expect(page.getByTestId("pipeline-result-days")).toContainText("1 unresolved");
  });

  test("a bad request surfaces Gracie's error state with a retry", async ({ page }) => {
    await page.goto("/debug/pipeline");

    // Running with empty text makes the route reject (400) → the loading view's
    // failure branch: frozen "this is fine" Gracie + legible message + retry.
    await page.getByTestId("pipeline-run").click();

    await expect(page.getByTestId("pipeline-error")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("pipeline-error-message")).not.toBeEmpty();
    await expect(page.getByTestId("pipeline-retry")).toBeVisible();
  });
});
