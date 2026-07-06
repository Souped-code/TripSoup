import { test, expect } from "@playwright/test";

// D2.3 (T3): the real greeting page `/`, driven end to end through the real
// /api/pipeline SSE route in fixture mode (same webServer setup
// e2e/pipeline.spec.ts uses: MAPS_PROVIDER=fixture). Paste on the actual
// product front door -> observe real pipeline progress -> land on the
// interim reveal at /trip/[id] with the cooked plan rendered.

// A couple of Maps links + one label + one time hint, all fixture-resolvable
// (Casterbridge, src/lib/maps/fixtureCity.ts) so the whole day resolves
// cleanly with no failures to account for.
const BLOB = [
  "Day 1",
  "Lunch at Clock Tower Square 1pm https://maps.google.com/?q=Clock+Tower+Square",
  "https://maps.google.com/?q=Guildhall+Museum",
  "https://maps.google.com/?q=Riverside+Cafe",
].join("\n");

test.describe("greeting -> cook -> reveal", () => {
  test("paste on the real greeting runs the real pipeline and lands on a coherent reveal", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByTestId("greeting-paste").fill(BLOB);
    await page.getByTestId("greeting-submit").click();

    // Real streamed progress from the actual pipeline (fixture mode) may
    // flash by quickly, same caveat e2e/pipeline.spec.ts notes — either way,
    // the terminal ok frame redirects to /trip/[id].
    await page.waitForURL(/\/trip\/[^/]+$/, { timeout: 15000 });
    await expect(page.getByTestId("trip-reveal")).toBeVisible();
    await expect(page.getByTestId("trip-reveal-heading")).toHaveText("Your route’s ready.");

    // The plan rendered on the torn-journal sidebar (D2.3 T6): all three
    // stops present. The first line's same-line text becomes that stop's
    // label verbatim (heuristicAdapter.ts pairs the whole line-minus-URL as
    // the label, time hint included; pipeline.ts's label-overrides-display-
    // name rule then uses it as the stop's name) — real, deterministic parse
    // behavior, not a test artifact. The two bare links carry no label, so
    // they resolve to their plain fixture names.
    const names = await page.locator('[data-testid^="sidebar-name-"]').allTextContents();
    expect(names).toContain("Lunch at Clock Tower Square 1pm");
    expect(names).toContain("Guildhall Museum");
    expect(names).toContain("Riverside Cafe");
    expect(names.length).toBe(3);

    // Order coherent: each stop's start time is no earlier than the previous
    // one's. sidebar-time-* renders "HH:MM–HH:MM" for a flexible stop, or
    // "anchored HH:MM" for one the parser treated as booked (the "1pm" hint
    // on the first line can do that, per the pipeline's anchorLikely+timeHint
    // rule) — strip that prefix before parsing either shape.
    const times = await page.locator('[data-testid^="sidebar-time-"]').allTextContents();
    const startMinutes = times.map((t) => {
      const [h, m] = t.replace(/^anchored /, "").split("–")[0].split(":").map(Number);
      return h * 60 + m;
    });
    for (let i = 1; i < startMinutes.length; i++) {
      expect(startMinutes[i]).toBeGreaterThanOrEqual(startMinutes[i - 1]);
    }
  });

  test("submitting an empty paste shows a journal-voice validation error, not a submission", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByTestId("greeting-submit").click();

    await expect(page.getByTestId("greeting-form-error")).toBeVisible();
    await expect(page.getByTestId("greeting-form-error")).not.toBeEmpty();

    // Never left the greeting — no pipeline run was started.
    await expect(page.getByTestId("greeting-paste")).toBeVisible();
    await expect(page).toHaveURL("/");
  });
});
