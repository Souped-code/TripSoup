// M1.8 — the headline M1 feature, end to end on the real product surface:
// paste PLAIN TEXT with no links at all and get back a correctly dated,
// ordered, anchored, multi-day itinerary.
//
// Runs against the real greeting page and the real /api/pipeline SSE route in
// fixture mode (MAPS_PROVIDER=fixture, no LLM key), so the whole path —
// fixture parse adapter -> placeQuery -> entitlement gate -> resolve
// checkpoint -> day assembly -> reveal — is exercised at ZERO spend.
//
// Before M1 every one of these lines would have been dropped: only URLs
// survived the resolve checkpoint.

import { expect, test } from "@playwright/test";

// Bare Casterbridge place names (src/lib/maps/fixtureCity.ts). No URLs.
// "2pm" anchors the cafe; "first" states an order intent on day 2; the last
// line names nowhere at all and must be treated as a note, not a place.
const TEXT_ONLY = [
  "Day 1",
  "Market Hall",
  "Riverside Cafe 2pm",
  "Day 2",
  "Guildhall Museum first",
  "Castle Keep",
  "remember to book the ferry, it sells out",
].join("\n");

test.describe("whole-paste interpretation (text-only)", () => {
  test("a link-free two-day paste resolves into two labelled days with pins, an anchor, and honoured order", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByTestId("greeting-paste").fill(TEXT_ONLY);
    await page.getByTestId("greeting-submit").click();

    await page.waitForURL(/\/trip\/[^/]+$/, { timeout: 15000 });
    await expect(page.getByTestId("trip-reveal")).toBeVisible();

    // --- two days, kept separate -------------------------------------------
    await expect(page.getByTestId("day-tab-0")).toBeVisible();
    await expect(page.getByTestId("day-tab-1")).toBeVisible();
    await expect(page.getByTestId("day-tab-2")).toHaveCount(0);

    // --- day 1: the named places became real stops -------------------------
    // The paste gave no calendar date, so the heading must be the honest
    // label — never today's date dressed up as the trip date (M1.5).
    await expect(page.getByTestId("sidebar-day-heading")).toHaveText("Day 1");

    const day1Names = await page.locator('[data-testid^="sidebar-name-"]').allTextContents();
    expect(day1Names).toContain("Market Hall");
    expect(day1Names).toContain("Riverside Cafe 2pm");
    expect(day1Names.length).toBe(2);

    // The "2pm" hint anchored the cafe: its row renders as anchored, not as a
    // flexible window.
    const day1Times = await page.locator('[data-testid^="sidebar-time-"]').allTextContents();
    expect(day1Times.some((t) => /^anchored 14:00/.test(t))).toBe(true);

    // --- day 2: order intent honoured --------------------------------------
    await page.getByTestId("day-tab-1").click();
    await expect(page.getByTestId("sidebar-day-heading")).toHaveText("Day 2");

    const day2Names = await page.locator('[data-testid^="sidebar-name-"]').allTextContents();
    // "remember to book the ferry" names no place — it must NOT have become a
    // stop. This is the LOCKED rule holding: note text is never a query.
    expect(day2Names.length).toBe(2);
    expect(day2Names.some((n) => /ferry/i.test(n))).toBe(false);

    // "Guildhall Museum first" must be planned before Castle Keep.
    const guildhallIdx = day2Names.findIndex((n) => /Guildhall Museum/.test(n));
    const keepIdx = day2Names.findIndex((n) => /Castle Keep/.test(n));
    expect(guildhallIdx).toBeGreaterThanOrEqual(0);
    expect(keepIdx).toBeGreaterThanOrEqual(0);
    expect(guildhallIdx).toBeLessThan(keepIdx);
  });

  test("a real date in the paste is shown as that date, not as a Day N label", async ({ page }) => {
    await page.goto("/");

    // "15 March" is an explicit day+month: the heading must become a real
    // formatted date. (Year inference is unit-tested; here we only assert the
    // heading stopped being a placeholder label.)
    await page.getByTestId("greeting-paste").fill(["15 March", "Market Hall"].join("\n"));
    await page.getByTestId("greeting-submit").click();

    await page.waitForURL(/\/trip\/[^/]+$/, { timeout: 15000 });
    await expect(page.getByTestId("trip-reveal")).toBeVisible();

    const heading = await page.getByTestId("sidebar-day-heading").textContent();
    expect(heading).not.toMatch(/^Day \d+$/);
    expect(heading).toMatch(/Mar/);
  });
});
