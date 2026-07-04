import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// D1.4: smoke test for the journal design system gallery. DEBUG_BOARD=1 is
// set for the whole Playwright webServer (playwright.config.ts), so this
// suite always sees the gallery. The notFound() gate for DEBUG_BOARD being
// unset is verified by code review, not a second webServer run — see the
// report for that confirmation.
test.describe("debug design gallery", () => {
  test("renders all five journal components", async ({ page }) => {
    await page.goto("/debug/design");

    await expect(page.getByTestId("gallery-paper-card")).toBeVisible();
    await expect(page.getByTestId("gallery-ink-button-primary")).toBeVisible();
    await expect(page.getByTestId("gallery-ink-button-secondary")).toBeVisible();
    await expect(page.getByTestId("gallery-journal-input")).toBeVisible();
    await expect(page.getByTestId("gallery-washi-tag")).toBeVisible();
    await expect(page.getByTestId("gallery-sketch-divider")).toBeVisible();
  });

  test("all five Gracie sprite scenes render with their sheets served", async ({ page }) => {
    await page.goto("/debug/design");

    for (const scene of ["pin-throw", "route-scribble", "journal", "this-is-fine", "soup-stir"]) {
      await expect(page.getByTestId(`gallery-gracie-${scene}`)).toBeVisible();
      // the sprite sheet itself must actually be served (guards against a
      // missing/renamed file in public/gracie/)
      const res = await page.request.get(`/gracie/${scene}.webp`);
      expect(res.status()).toBe(200);
    }
  });

  test("has no automatically detectable accessibility violations", async ({ page }) => {
    await page.goto("/debug/design");

    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    expect(accessibilityScanResults.violations).toEqual([]);
  });
});
