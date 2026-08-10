// E3 — opening hours, end to end at $0 (fixture mode only, per playwright.config.ts).
//
// Test 1 exercises the full real path: a paste lands a real calendar date on
// the fixture's hand-written Monday-closed stop (fx-03 Guildhall Museum,
// src/lib/maps/fixtureCity.ts) -> fixtureAdapter.ts mirrors Google's raw
// shape -> pipeline.ts parses it via the REAL parseGoogleHours -> the FIRST
// solve already carries the advisory (src/lib/plan/hoursAdvisory.ts) ->
// JournalSidebar renders it. "16 March 2026" is a real, verified Monday.
//
// Test 2 hits the PUT boundary directly to prove a hand-crafted/corrupted
// `hours` payload is rejected (app/api/trips/[id]/route.ts's malformed()),
// never silently accepted and misread downstream.

import { expect, test } from "@playwright/test";

test.describe("opening hours (E3)", () => {
  test("a Monday-closed stop landing on a real Monday date shows a closed warning in the sidebar", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByTestId("greeting-paste").fill(["16 March 2026", "Guildhall Museum"].join("\n"));
    await page.getByTestId("greeting-submit").click();

    await page.waitForURL(/\/trip\/[^/]+$/, { timeout: 15000 });
    await expect(page.getByTestId("trip-reveal")).toBeVisible();

    // A real date was given — the heading must be the formatted date, not a
    // "Day N" placeholder label (M1.5), and the advisory check must run.
    const heading = await page.getByTestId("sidebar-day-heading").textContent();
    expect(heading).not.toMatch(/^Day \d+$/);
    expect(heading).toMatch(/Mar/);
    expect(heading).toMatch(/Monday/);

    await expect(page.getByTestId("sidebar-hours-note")).toBeVisible();
    await expect(page.getByTestId("sidebar-hours-note")).toContainText("Guildhall Museum");
    await expect(page.getByTestId("sidebar-hours-note")).toContainText("closed on Mondays");
  });

  test("malformed hours on a PUT are rejected, never silently accepted", async ({ page }) => {
    await page.goto("/debug/trip");
    await page.getByTestId("new-trip").click();
    await expect(page.getByTestId("day-0")).toBeVisible();

    const url = page.url();
    const id = url.match(/\/debug\/trip\/([^/]+)$/)?.[1];
    expect(id).toBeTruthy();

    const res = await page.request.put(`/api/trips/${id}`, {
      data: {
        tripId: id,
        days: [
          {
            date: "2026-03-16",
            dayStartMin: 540,
            dayEndMin: 1320,
            stops: [
              {
                id: "fx-03",
                name: "Guildhall Museum",
                location: { lat: 51.4491, lng: -2.5979 },
                durationMin: 60,
                hours: { byWeekday: "not-an-array-of-7" }, // junk shape
              },
            ],
          },
        ],
        settings: { walkMax: 10, driveOverheadMin: 10 },
        legOverrides: [],
      },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("hours");
  });
});
