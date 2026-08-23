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
      // E6a: explicit, not just inherited from host.ts's own `next dev`
      // default (see that file's engineInWorkerEnabled comment for the full
      // measured writeup) — worker mode under THIS dev server, run through
      // trip.spec.ts's full sequential suite, produced a real, repeatable
      // flake (different test each time) that did not reproduce in
      // isolation, under `next build`+`next start`, or in a genuine `tsx`
      // process. Spelled out here so the choice is visible without having to
      // trace into host.ts, and so it survives even if that default's own
      // NODE_ENV logic ever changes. Worker mode itself is proven separately
      // (host.test.ts's mocked-Worker unit tests + the real production-build
      // HTTP smoke test in STATE.md's E6a entry) — this is a `next dev`
      // stability call, not a doubt about the worker path's correctness.
      ENGINE_IN_WORKER: "0",
      // E6 audit finding 6: pin the prose provider so e2e $0 does not depend
      // on the invoking shell's env.
      PROSE_PROVIDER: "fixture",
      // E7 audit finding 4: pinned for the same reason as PROSE_PROVIDER — a
      // dev shell with CONSTRAINTS_PROVIDER=llm + a key must not make every
      // e2e paste a billed compile.
      CONSTRAINTS_PROVIDER: "fixture",
    },
  },
});
