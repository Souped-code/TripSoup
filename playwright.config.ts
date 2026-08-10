import { defineConfig } from "@playwright/test";

// E2E runs against fixture data only (§3): MAPS_PROVIDER=fixture and no key.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3111",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx next dev -p 3111",
    url: "http://localhost:3111",
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      MAPS_PROVIDER: "fixture",
      TRIPS_DIR: ".trips-e2e",
      DEBUG_BOARD: "1",
      // E5b: fixture-city e2e docs are small; the production default (20s)
      // would spend it on every optimize/toggle for no product benefit here.
      // Still finite, still generous relative to what these tiny problems need.
      ENGINE_BUDGET_MS: "3000",
    },
  },
});
