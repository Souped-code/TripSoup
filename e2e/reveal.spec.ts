// D2.3 M1 done-checks — the real reveal map at /trip/[id], fixture data only.
//  - the journal engine paints: canvas has real pixels, all stops in the
//    painted order, the booked (anchored) stop wears the washi tag
//  - manualOrder re-paths the map: pin the reverse order, reload, the painted
//    order follows it exactly (through the real planTripDay machinery)
// Tile traffic is stubbed at the network layer (TileJSON → a stub template,
// every tile → 404): the engine tolerates failed tiles by design (paints
// textures + overlay on an empty geometry set), so the wiring is exercised
// end-to-end with zero external network and zero flake.

import { expect, test, type Page } from "@playwright/test";
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

async function createRevealTrip(page: Page): Promise<TripDoc> {
  const created = await page.request.post("/api/trips");
  expect(created.ok()).toBeTruthy();
  const doc = (await created.json()) as TripDoc;
  doc.days[0].stops = [
    { id: A.id, name: A.name, location: A.location, durationMin: 30 },
    // the anchored stop is the "booked" one — it should wear the washi tag
    { id: B.id, name: B.name, location: B.location, durationMin: 30, anchor: { startMin: 720 } },
    { id: C.id, name: C.name, location: C.location, durationMin: 30 },
  ];
  const put = await page.request.put(`/api/trips/${doc.tripId}`, { data: doc });
  expect(put.ok()).toBeTruthy();
  return doc;
}

async function expectPainted(page: Page) {
  const map = page.getByTestId("reveal-map");
  await expect(map).toBeVisible();
  await expect(map).toHaveAttribute("data-phase", "ready", { timeout: 30000 });
  await expect(map).not.toHaveAttribute("data-paints", "0");
  return map;
}

test("reveal paints the journal map: canvas pixels, full order, washi on the booked stop", async ({
  page,
}) => {
  await stubTiles(page);
  const doc = await createRevealTrip(page);

  await page.goto(`/trip/${doc.tripId}`);
  const map = await expectPainted(page);

  // every stop is in the painted visit order (permutation is the solver's call)
  const order = (await map.getAttribute("data-order"))!;
  expect(order.split("|").sort()).toEqual([A.id, B.id, C.id].sort());

  // the anchored stop wears the tape
  await expect(map).toHaveAttribute("data-washi", "1");

  // the canvas holds a real painting, not a blank or flat rect
  const px = await page.evaluate(() => {
    const c = document.querySelector(
      '[data-testid="reveal-map"] canvas'
    ) as HTMLCanvasElement;
    const ctx = c.getContext("2d")!;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<string>();
    for (let i = 0; i < d.length; i += 4 * 997) {
      seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    }
    return { w: c.width, h: c.height, distinctColors: seen.size };
  });
  expect(px.w).toBeGreaterThan(200);
  expect(px.h).toBeGreaterThan(100);
  expect(px.distinctColors).toBeGreaterThan(3);
});

test("manualOrder re-paths the reveal: pinned order paints exactly", async ({ page }) => {
  await stubTiles(page);
  const doc = await createRevealTrip(page);

  await page.goto(`/trip/${doc.tripId}`);
  const map = await expectPainted(page);
  const initial = (await map.getAttribute("data-order"))!;

  // pin the REVERSE of whatever the solver painted (a valid permutation;
  // feasible: the 540–1320 window dwarfs three 30-min stops around a 12:00
  // anchor), then reload — planTripDay honors manualOrder (quality "manual")
  // and the map paints that exact order
  const pinned = initial.split("|").reverse();
  doc.days[0].manualOrder = pinned;
  const put = await page.request.put(`/api/trips/${doc.tripId}`, { data: doc });
  expect(put.ok()).toBeTruthy();

  await page.reload();
  await expectPainted(page);
  await expect(map).toHaveAttribute("data-order", pinned.join("|"));
});
