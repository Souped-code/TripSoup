// E6b — trade-off cards + explicit re-cook, end to end at $0 (fixture mode).
//
// Reuses the exact Monday-closed-all-day scenario e2e/hours.spec.ts's third
// test establishes: Guildhall Museum (fx-03) is closed ALL DAY on Mondays, so
// pasting "16 March 2026" (a real, verified Monday) + Guildhall Museum +
// Market Hall lands a genuine, unavoidable HARD "hours" conflict the engine
// cannot schedule around (src/lib/engine/problem.ts's hoursFromDoc) — exactly
// the case E6b's cards exist to make visible and actionable.

import { expect, test, type Page } from "@playwright/test";

async function pasteMondayClosedTrip(page: Page) {
  await page.goto("/");
  await page.getByTestId("greeting-paste").fill(["16 March 2026", "Guildhall Museum", "Market Hall"].join("\n"));
  await page.getByTestId("greeting-submit").click();
  await page.waitForURL(/\/trip\/[^/]+$/, { timeout: 15000 });
  await expect(page.getByTestId("trip-reveal")).toBeVisible();
  const tripId = page.url().match(/\/trip\/([^/]+)$/)![1];
  return tripId;
}

function firstCard(page: Page) {
  return page.locator('[data-testid^="tradeoff-card-"]').first();
}

test.describe("trade-off cards (E6b)", () => {
  test("a Monday-closed stop surfaces a card with provenance wording, and accepting 'Skip it' resolves it", async ({
    page,
  }) => {
    await pasteMondayClosedTrip(page);

    const card = firstCard(page);
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.getByTestId("tradeoff-card-what")).toContainText("Guildhall Museum");
    // provenance: this constraint came from Google's opening hours, not the
    // user or an LLM inference — the card must say so.
    await expect(card.getByTestId("tradeoff-card-who")).toContainText("Google says");

    const skipChip = card.locator('[data-testid^="tradeoff-accept-"]', { hasText: "Skip it" });
    await expect(skipChip).toBeVisible();
    await skipChip.click();

    // Card gone, stop actually removed from the day, plan re-cooked around it.
    await expect(page.locator('[data-testid^="tradeoff-card-"]')).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId("sidebar-rows")).not.toContainText("Guildhall Museum");
    await expect(page.getByTestId("sidebar-rows")).toContainText("Market Hall");

    const url = page.url();
    const tripId = url.match(/\/trip\/([^/]+)$/)![1];
    const saved = await page.request.get(`/api/trips/${tripId}`);
    const doc = await saved.json();
    expect(doc.days[0].stops.some((s: { name: string }) => s.name === "Guildhall Museum")).toBe(false);
  });

  test("dismissing a card hides it and it survives a reload, until the day's settings change", async ({ page }) => {
    const tripId = await pasteMondayClosedTrip(page);

    const card = firstCard(page);
    await expect(card).toBeVisible({ timeout: 15000 });
    const dismissBtn = card.locator('[data-testid^="tradeoff-dismiss-"]');
    await dismissBtn.click();

    // E7.2 — the card hides INSTANTLY (optimistic queue) while the persist
    // runs in the background…
    await expect(page.locator('[data-testid^="tradeoff-card-"]')).toHaveCount(0, { timeout: 15000 });

    // …so wait for the server to actually hold the dismissal before
    // reloading (a reload mid-flight would abort the background PUT).
    await expect
      .poll(
        async () => {
          const doc = await (await page.request.get(`/api/trips/${tripId}`)).json();
          return (doc.dismissedProposals ?? []).length;
        },
        { timeout: 15000 }
      )
      .toBeGreaterThan(0);

    // Survives a reload — the dismissal is persisted on the doc, not client state.
    await page.reload();
    await expect(page.getByTestId("trip-reveal")).toBeVisible();
    await expect(page.locator('[data-testid^="tradeoff-card-"]')).toHaveCount(0);

    // Edit the day (settings change stales every day's content hash — see
    // src/lib/plan/solveProjection.ts) — the dismissal is keyed to the OLD
    // hash, so it no longer matches and the card reappears (same conflict,
    // new plan).
    await page.getByTestId("sidebar-pocket").locator("summary").click();
    await page.getByTestId("sidebar-walkmax").fill("15");
    await page.getByTestId("sidebar-settings-apply").click();

    await expect(firstCard(page)).toBeVisible({ timeout: 15000 });
    await expect(firstCard(page).getByTestId("tradeoff-card-what")).toContainText("Guildhall Museum");
  });

  test("re-cook this day re-solves the day without erroring", async ({ page }) => {
    await pasteMondayClosedTrip(page);
    await expect(firstCard(page)).toBeVisible({ timeout: 15000 });

    // E6c: the decision modal overlays the journal — put it away first. This
    // also marks the current issue set as SEEN, which is what the tail of
    // this test verifies survives the re-cook.
    await page.getByTestId("tradeoff-decide-later").click();
    await expect(page.getByTestId("decision-modal")).toHaveCount(0);

    await page.getByTestId("sidebar-reoptimize").click();

    // Still a real, rendered plan (never a blank/error state) — the closed
    // stop's conflict is unrelated to the button and survives the re-cook.
    await expect(page.getByTestId("journal-sidebar")).not.toContainText("couldn't be cooked");

    // Same conflict set after the re-cook (conflict ids are content-derived):
    // already seen, so it must NOT auto-pop again — the banner owns it and
    // reopens the modal on demand.
    await expect(page.getByTestId("sidebar-tradeoffs")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("decision-modal")).toHaveCount(0);
    await page.getByTestId("tradeoff-banner-open").click();
    await expect(firstCard(page)).toBeVisible();
  });

  test("re-cook whole trip requires confirmation before it runs", async ({ page }) => {
    await pasteMondayClosedTrip(page);

    // E6c: the auto-popped decision modal overlays the sidebar — close it
    // before driving the re-cook affordances underneath.
    await expect(firstCard(page)).toBeVisible({ timeout: 15000 });
    await page.getByTestId("tradeoff-decide-later").click();
    await expect(page.getByTestId("decision-modal")).toHaveCount(0);

    await page.getByTestId("sidebar-recook-trip").click();
    await expect(page.getByTestId("sidebar-recook-trip-confirm")).toBeVisible();

    // Backing out leaves the plan untouched.
    await page.getByTestId("sidebar-recook-trip-cancel").click();
    await expect(page.getByTestId("sidebar-recook-trip-confirm")).toHaveCount(0);

    await page.getByTestId("sidebar-recook-trip").click();
    await page.getByTestId("sidebar-recook-trip-confirm").click();
    await expect(page.getByTestId("journal-sidebar")).not.toContainText("couldn't be cooked", { timeout: 15000 });
  });

  test("a malformed dismissedProposals entry on a PUT is rejected, never silently accepted", async ({ page }) => {
    await page.goto("/debug/trip");
    await page.getByTestId("new-trip").click();
    await expect(page.getByTestId("day-0")).toBeVisible();

    const id = page.url().match(/\/debug\/trip\/([^/]+)$/)?.[1];
    expect(id).toBeTruthy();

    const res = await page.request.put(`/api/trips/${id}`, {
      data: {
        tripId: id,
        days: [{ date: "2026-03-16", dayStartMin: 540, dayEndMin: 1320, stops: [] }],
        settings: { walkMax: 10, driveOverheadMin: 10 },
        legOverrides: [],
        dismissedProposals: [{ id: "conflict-1" /* missing dayHash */ }],
      },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("dismissedProposals");
  });
});
