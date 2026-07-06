// P4 Playwright done-checks, against fixture data only:
//  - add stops -> mark anchor -> optimize -> correct order and times on screen
//  - toggling an eligible leg re-times downstream stops without re-ordering
//  - infeasible case shows the report, not a broken plan
//  - heuristic state rendered
// Expected orders/times are computed DIFFERENTIALLY with the same pure
// libraries the server uses, fed by the committed fixture city.

import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_STOPS, fixtureDriveMinutes } from "../src/lib/maps/fixtureCity";
import { DEFAULT_SETTINGS } from "../src/lib/maps/types";
import { buildEffectiveMatrix } from "../src/lib/solver/effectiveMatrix";
import { planDay } from "../src/lib/schedule/schedule";
import type { Day } from "../src/lib/schedule/types";
import { fmtTime } from "../src/ui/time";

const byName = new Map(FIXTURE_STOPS.map((s) => [s.name, s]));

function expectedPlan(day: Day) {
  const stops = day.stops.map((s) => FIXTURE_STOPS.find((f) => f.id === s.id)!);
  const drive: Record<string, Record<string, number>> = {};
  const locations: Record<string, { lat: number; lng: number }> = {};
  for (const a of stops) {
    drive[a.id] = {};
    locations[a.id] = a.location;
    for (const b of stops) drive[a.id][b.id] = fixtureDriveMinutes(a, b);
  }
  return planDay(day, buildEffectiveMatrix(drive, locations, DEFAULT_SETTINGS), DEFAULT_SETTINGS);
}

async function newTrip(page: Page): Promise<void> {
  await page.goto("/debug/trip");
  await page.getByTestId("new-trip").click();
  await expect(page.getByTestId("day-0")).toBeVisible();
}

async function addStops(page: Page, names: string[]): Promise<void> {
  await page.getByTestId("paste-box").fill(names.join("\n"));
  await page.getByTestId("add-stops").click();
  for (const name of names) {
    const stop = byName.get(name);
    if (stop) await expect(page.getByTestId(`stop-${stop.id}`)).toBeVisible();
  }
}

async function onScreenOrder(page: Page): Promise<string[]> {
  return page.getByTestId("entry-name").allTextContents();
}

test("add stops -> mark anchor -> optimize -> correct order and times on screen", async ({
  page,
}) => {
  await newTrip(page);

  const names = ["Old Port Aquarium", "Botanic Conservatory", "Castle Keep", "Northgate Mall"];
  await addStops(page, [...names, "Nonexistent Palace"]);

  // the bogus line surfaces as a legible failure, never dropped silently
  await expect(page.getByTestId("resolve-failures")).toContainText("Nonexistent Palace");
  await expect(page.getByTestId("resolve-failures")).toContainText("no match in fixture city");

  // mark Northgate Mall as booked, move it from the 12:00 default to 15:00
  // (three 60-min visits + travel cannot precede a 12:00 booking from a 09:00 start)
  const mall = byName.get("Northgate Mall")!;
  await page.getByTestId(`anchor-toggle-${mall.id}`).check();
  await expect(page.getByTestId(`anchor-time-${mall.id}`)).toHaveValue("12:00");
  await page.getByTestId(`anchor-time-${mall.id}`).fill("15:00");
  await page.getByTestId(`anchor-time-${mall.id}`).blur();

  await page.getByTestId("optimize").click();
  await expect(page.getByTestId("plan")).toBeVisible();

  // differential expectation from the same libraries + fixture data
  const day: Day = {
    date: "any",
    dayStartMin: 540,
    dayEndMin: 1320,
    stops: names.map((n) => {
      const f = byName.get(n)!;
      return {
        id: f.id,
        name: f.name,
        durationMin: 60,
        anchor: n === "Northgate Mall" ? { startMin: 900 } : undefined,
      };
    }),
  };
  const expected = expectedPlan(day);
  expect(expected.status).toBe("ok");
  if (expected.status !== "ok") return;

  const expectedNames = expected.order.map(
    (id) => FIXTURE_STOPS.find((f) => f.id === id)!.name
  );
  expect(await onScreenOrder(page)).toEqual(expectedNames);

  // times on screen match the library's arithmetic
  for (const entry of expected.entries) {
    await expect(
      page.getByTestId(`entry-${entry.stopId}`).getByTestId("entry-time")
    ).toHaveText(`${fmtTime(entry.startMin)}–${fmtTime(entry.departMin)}`);
  }

  // legs are labelled walk/drive
  const modes = await page.getByTestId("leg-mode").allTextContents();
  expect(modes.length).toBe(expected.legs.length);
  for (const m of modes) expect(["walk", "drive"]).toContain(m);

  await expect(page.getByTestId("quality-badge")).toContainText("optimal");
});

test("toggling an eligible leg re-times downstream stops without re-ordering", async ({
  page,
}) => {
  await newTrip(page);
  // old-town cluster: hops are walk-eligible, so the auto plan walks them
  const names = ["Market Hall", "Clock Tower Square", "Guildhall Museum", "Riverside Cafe"];
  await addStops(page, names);
  await page.getByTestId("optimize").click();
  await expect(page.getByTestId("plan")).toBeVisible();

  const day: Day = {
    date: "any",
    dayStartMin: 540,
    dayEndMin: 1320,
    stops: names.map((n) => {
      const f = byName.get(n)!;
      return { id: f.id, name: f.name, durationMin: 60 };
    }),
  };
  const expected = expectedPlan(day);
  expect(expected.status).toBe("ok");
  if (expected.status !== "ok") return;
  const walkLeg = expected.legs.find((l) => l.mode === "walk" && l.walkMin !== null);
  expect(walkLeg).toBeDefined(); // the cluster guarantees one
  const orderBefore = await onScreenOrder(page);

  // downstream entry times before the toggle
  const legIndex = expected.legs.indexOf(walkLeg!);
  const downstream = expected.entries[legIndex + 1];
  await expect(
    page.getByTestId(`entry-${downstream.stopId}`).getByTestId("entry-time")
  ).toHaveText(`${fmtTime(downstream.startMin)}–${fmtTime(downstream.departMin)}`);

  // eligible legs show both times
  await expect(
    page.getByTestId(`leg-${walkLeg!.fromId}-${walkLeg!.toId}`).getByTestId("leg-times")
  ).toContainText(/walk \d+ min \/ drive \d+ min/);

  await page.getByTestId(`toggle-${walkLeg!.fromId}-${walkLeg!.toId}`).click();
  await expect(
    page.getByTestId(`leg-${walkLeg!.fromId}-${walkLeg!.toId}`).getByTestId("leg-mode")
  ).toHaveText("drive");

  // same order, shifted downstream time: drive = raw + overhead, walk = estimate
  expect(await onScreenOrder(page)).toEqual(orderBefore);
  const shift = walkLeg!.driveMin + DEFAULT_SETTINGS.driveOverheadMin - walkLeg!.walkMin!;
  await expect(
    page.getByTestId(`entry-${downstream.stopId}`).getByTestId("entry-time")
  ).toHaveText(
    `${fmtTime(downstream.startMin + shift)}–${fmtTime(downstream.departMin + shift)}`
  );

  // and the toggle persisted: reload, re-optimize, still driving
  await page.reload();
  await page.getByTestId("optimize").click();
  await expect(
    page.getByTestId(`leg-${walkLeg!.fromId}-${walkLeg!.toId}`).getByTestId("leg-mode")
  ).toHaveText("drive");
});

test("infeasible case shows the report, not a broken plan", async ({ page }) => {
  await newTrip(page);
  await addStops(page, ["Market Hall", "City Zoo"]);

  // Zoo booked at 09:10 — unreachable after a 60-min visit starting 09:00
  const zoo = byName.get("City Zoo")!;
  await page.getByTestId(`anchor-toggle-${zoo.id}`).check();
  await page.getByTestId(`anchor-time-${zoo.id}`).fill("09:10");
  await page.getByTestId(`anchor-time-${zoo.id}`).blur();

  await page.getByTestId("optimize").click();
  await expect(page.getByTestId("infeasible-report")).toBeVisible();
  await expect(page.getByTestId("infeasible-constraint")).toContainText(
    `anchor-start:${zoo.id}`
  );
  await expect(page.getByTestId("plan")).toHaveCount(0); // no broken plan rendered
});

test("heuristic state is rendered for a 10-stop segment", async ({ page }) => {
  await newTrip(page);
  const names = FIXTURE_STOPS.slice(0, 10).map((s) => s.name);
  await addStops(page, names);
  await page.getByTestId("optimize").click();
  await expect(page.getByTestId("plan")).toBeVisible();
  await expect(page.getByTestId("quality-badge")).toContainText("heuristic");
});

test("walkMax is a live settings field: 0 forces every leg to drive", async ({ page }) => {
  await newTrip(page);
  await addStops(page, ["Market Hall", "Clock Tower Square"]);
  await page.getByTestId("walkmax-input").fill("0");
  await page.getByTestId("optimize").click();
  await expect(page.getByTestId("plan")).toBeVisible();
  const modes = await page.getByTestId("leg-mode").allTextContents();
  expect(modes).toEqual(["drive"]); // adjacent old-town hop would walk at default 10
});
