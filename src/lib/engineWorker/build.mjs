#!/usr/bin/env node
// E6a — bundles workerEntry.ts into worker.generated.cjs: a single,
// dependency-free CommonJS file that host.ts points a real `worker_thread`
// at DIRECTLY, as a plain runtime path string.
//
// WHY A PRE-BUNDLED PLAIN FILE, NOT `new Worker(new URL("./workerEntry.ts",
// import.meta.url))`:
// That pattern IS something webpack recognises (native Worker asset-module
// support), but its documented, stable Next.js support surface is Edge
// runtime / client bundles emitting a WEB worker — there is no contract for
// it emitting a physically loadable file for a Node.js-runtime API route's
// `worker_threads` use, and Next's route-handler bundling target (Node.js,
// server-only, traced for serverless deploy) is exactly the case that
// surface doesn't promise. Investigating further (rather than assuming it
// works) was out of budget for a mechanism this file makes moot anyway: a
// plain, pre-built .cjs file on disk needs NO bundler cooperation to load —
// `new Worker(somePathString)` in host.ts is an ordinary runtime function
// call as far as webpack is concerned (nothing to statically analyse or
// rewrite), so whatever webpack does or doesn't support for worker assets
// never enters the picture.
//
// Run via package.json's `prebuild`/`predev` npm hooks (before `next build` /
// `next dev` — npm auto-runs `pre<name>` for `npm run <name>`), and lazily by
// host.ts itself for dev/test convenience when the bundle is missing (see
// that file's `bundlePath`). Deterministic given the same source — safe to
// re-run any time, including redundantly.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, "workerEntry.ts")],
  outfile: path.join(here, "worker.generated.cjs"),
  bundle: true,
  platform: "node",
  // Old enough to be safe on any Node Vercel currently offers, new enough for
  // the engine's own syntax (private-free classless modules, ES2020+ — the
  // engine module graph targets ES2022 per tsconfig.json, but esbuild's own
  // downleveling here is a formality: nothing in src/lib/engine/** uses
  // syntax node18 lacks).
  target: "node18",
  format: "cjs",
  logLevel: "info",
  // No `external` list beyond esbuild's own automatic node-builtin handling
  // (platform: "node" leaves `node:worker_threads` etc. as runtime requires
  // rather than trying to bundle them — esbuild's documented default). The
  // ENTIRE point of `bundle: true` with nothing else external is that a
  // stray import of something that ISN'T pure (fs, config.ts, a Next/React
  // import) fails THIS build loudly instead of silently reaching a worker
  // thread that can't do server-only I/O — the engine module graph
  // (src/lib/engine, schedule, solver, maps, constraints, util) is pure by
  // design (verified by grep across its imports; see STATE.md's E6a entry),
  // and this build is what keeps that true.
});
