// D2.3 T6 done-checks — the torn-journal sidebar at /trip/[id]: rows render
// in the current visit order with times, the booked (anchored) stop wears a
// yellow "Booked" tag, keyboard drag-reorder writes manualOrder and re-paths
// the map (asserted via the optimistic UI outcome, same as the mutation
// itself resolves), re-optimize hands ordering back to the solver, a flagged
// duplicate stop can be removed, and the page is axe-clean.
//
// Same fixture-only, network-stubbed pattern as e2e/reveal.spec.ts: tile
// traffic is stubbed (TileJSON -> a stub template, every tile -> 404 — the
// engine tolerates failed tiles by painting textures + overlay on an empty
// geometry set) and reduced motion is emulated so the M2 choreography
// collapses to instant final frames, keeping the drag assertions timing-free.

import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { FIXTURE_STOPS } from "../src/lib/maps/fixtureCity";
import type { TripDoc } from "../src/lib/store/types";

const [A, B, C] = FIXTURE_STOPS;

async function stubTiles(page: Page) {
  await page.route("**/tiles.openfreemap.org/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/planet")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          tiles: ["https://tiles.openfreemap.org/stub/{z}/{x}/{y}.pbf"],
        }),
      });
    } else {
      await route.fulfill({ status: 404, body: "no tiles in the stub" });
    }
  });
}

// Three stops, one anchored (the "booked" one) — mirrors reveal.spec.ts's
// fixture trip exactly, so the two specs stay easy to compare.
async function createSidebarTrip(page: Page, opts?: { withDuplicate?: boolean }): Promise<TripDoc> {
  const created = await page.request.post("/api/trips");
  expect(created.ok()).toBeTruthy();
  const doc = (await created.json()) as TripDoc;
  doc.days[0].stops = [
    { id: A.id, name: A.name, location: A.location, durationMin: 30 },
    { id: B.id, name: B.name, location: B.location, durationMin: 30, anchor: { startMin: 720 } },
    { id: C.id, name: C.name, location: C.location, durationMin: 30 },
  ];
  if (opts?.withDuplicate) {
    // Mirrors T4b: a same-day duplicate occurrence gets a deterministic
    // suffixed id + duplicateOf pointing at the first occurrence's bare id.
    doc.days[0].stops.push({
      id: `${A.id}#2`,
      name: A.name,
      location: A.location,
      durationMin: 20,
      duplicateOf: A.id,
    });
  }
  const put = await page.request.put(`/api/trips/${doc.tripId}`, { data: doc });
  expect(put.ok()).toBeTruthy();
  return doc;
}

async function expectPainted(page: Page) {
  const map = page.getByTestId("reveal-map");
  await expect(map).toBeVisible();
  await expect(map).toHaveAttribute("data-phase", "ready", { timeout: 30000 });
  return map;
}

async function domRowOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="sidebar-row-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.replace("sidebar-row-", "")));
}

// Focus a row's handle, then Space (pick up) -> ArrowDown (move one slot) ->
// Space (drop) — the deterministic keyboard path dnd-kit's KeyboardSensor
// supports, driven the same way a real AT user would. dnd-kit's keyboard
// coordinate/collision recompute runs off the browser's own RAF loop rather
// than settling synchronously within one task, so a short pause after each
// key lets it land before the next key fires; without it, the final Space
// can arrive while `over` still equals `active` (pre-move), and the drop
// silently no-ops.
async function keyboardDragOneSlotDown(page: Page, handleTestId: string) {
  await page.getByTestId(handleTestId).focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  await page.keyboard.press("Space");
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("rows render in plan order with times, and the booked stop shows a yellow Booked tag", async ({ page }) => {
  await stubTiles(page);
  const doc = await createSidebarTrip(page);
  await page.goto(`/trip/${doc.tripId}`);

  const map = await expectPainted(page);
  const order = (await map.getAttribute("data-order"))!.split("|");

  // sidebar rows exist for every stop, in the exact same order the map painted
  expect(await domRowOrder(page)).toEqual(order);

  // every row has a time (this fixture's plan solves "ok" — no infeasibility)
  for (const id of order) {
    await expect(page.getByTestId(`sidebar-time-${id}`)).toBeVisible();
  }

  // the anchored stop's row: yellow washi tone, a checkmark, and the word
  // "Booked" (§3: booked is never color-only) — plus its time reads
  // "anchored HH:MM", not a start–depart range.
  const bookedHandle = page.getByTestId(`sidebar-handle-${B.id}`);
  await expect(bookedHandle).toHaveClass(/journal-washi-tag--washi/);
  await expect(bookedHandle).toContainText("✓");
  await expect(bookedHandle).toContainText("Booked");
  await expect(page.getByTestId(`sidebar-time-${B.id}`)).toHaveText("anchored 12:00");
});

test("keyboard reorder moves a row, re-paths the map, and offers re-optimize", async ({ page }) => {
  await stubTiles(page);
  const doc = await createSidebarTrip(page);
  await page.goto(`/trip/${doc.tripId}`);

  const map = await expectPainted(page);
  const initialOrder = (await map.getAttribute("data-order"))!.split("|");
  const expectedOrder = [initialOrder[1], initialOrder[0], ...initialOrder.slice(2)];

  await keyboardDragOneSlotDown(page, `sidebar-handle-${initialOrder[0]}`);

  // Optimistic UI outcome: the map re-paths and the rows re-render in the
  // new order immediately (before/without needing to poll the network).
  await expect(map).toHaveAttribute("data-order", expectedOrder.join("|"), { timeout: 15000 });
  expect(await domRowOrder(page)).toEqual(expectedOrder);

  // The mutation round-trip (PUT then POST /plan) completed: manual quality
  // is now in effect, offering Re-optimize.
  await expect(page.getByTestId("sidebar-reoptimize")).toBeVisible();
  await expect(page.getByText(/Your order/)).toBeVisible();

  // And it's actually persisted server-side, not just a client-only optimistic fiction.
  const saved = await page.request.get(`/api/trips/${doc.tripId}`);
  const savedDoc = (await saved.json()) as TripDoc;
  expect(savedDoc.days[0].manualOrder).toEqual(expectedOrder);
});

test("re-optimize clears the manual order and hands it back to the solver", async ({ page }) => {
  await stubTiles(page);
  const doc = await createSidebarTrip(page);
  await page.goto(`/trip/${doc.tripId}`);

  const map = await expectPainted(page);
  const solverOrder = (await map.getAttribute("data-order"))!;

  const firstId = solverOrder.split("|")[0];
  await keyboardDragOneSlotDown(page, `sidebar-handle-${firstId}`);

  await expect(page.getByTestId("sidebar-reoptimize")).toBeVisible();
  await expect(map).not.toHaveAttribute("data-order", solverOrder);

  await page.getByTestId("sidebar-reoptimize").click();

  // The solver is deterministic (proven at the unit level), so clearing
  // manualOrder reproduces the exact same order as the original auto-plan.
  await expect(map).toHaveAttribute("data-order", solverOrder, { timeout: 15000 });
  await expect(page.getByTestId("sidebar-reoptimize")).toHaveCount(0);
});

test("a flagged duplicate stop shows a remove note, and removing it drops it from the map order", async ({
  page,
}) => {
  await stubTiles(page);
  const doc = await createSidebarTrip(page, { withDuplicate: true });
  await page.goto(`/trip/${doc.tripId}`);

  const map = await expectPainted(page);
  const dupId = `${A.id}#2`;

  const dupNote = page.getByTestId(`sidebar-dup-note-${dupId}`);
  await expect(dupNote).toBeVisible();
  await expect(dupNote).toContainText("same place as");
  await expect(dupNote).toContainText("remove if it snuck in twice?");

  const beforeOrder = (await map.getAttribute("data-order"))!.split("|");
  expect(beforeOrder).toContain(dupId);
  expect(beforeOrder.length).toBe(4);

  await page.getByTestId(`sidebar-remove-${dupId}`).click();

  await expect(page.getByTestId(`sidebar-row-${dupId}`)).toHaveCount(0, { timeout: 15000 });
  const afterOrder = (await map.getAttribute("data-order"))!.split("|");
  expect(afterOrder).not.toContain(dupId);
  expect(afterOrder.length).toBe(3);

  // persisted: the stop is actually gone from the stored document, not just
  // hidden client-side.
  const saved = await page.request.get(`/api/trips/${doc.tripId}`);
  const savedDoc = (await saved.json()) as TripDoc;
  expect(savedDoc.days[0].stops.some((s) => s.id === dupId)).toBe(false);
});

test("the reveal page has no automatically detectable accessibility violations", async ({ page }) => {
  await stubTiles(page);
  const doc = await createSidebarTrip(page);
  await page.goto(`/trip/${doc.tripId}`);
  await expectPainted(page);

  const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
  expect(accessibilityScanResults.violations).toEqual([]);
});
