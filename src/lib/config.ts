// Runtime wiring — which adapter serves this process. Server-side only.
// Fixture is the default whenever no key is present, so development and tests
// can never accidentally spend (§3). The real adapter is chosen ONLY when a
// key exists, and its matrix cache is file-persisted (§3 cache-as-spec) or
// KV-backed when Vercel KV env vars are present.

import * as fs from "fs";
import * as path from "path";
import type { MapsProvider } from "./maps/types";
import { createFixtureAdapter } from "./maps/fixtureAdapter";
import type { MatrixCache } from "./maps/matrixSource";
import { createKvMatrixCache } from "./maps/kvMatrixCache";
import type { TripStore } from "./store/types";
import { createFileStore } from "./store/fileStore";
import { createKvStore } from "./store/kvStore";

// Persistent matrix cache for the real adapter (§3: cached in persistence,
// never re-fetched on cache hit). Async wrappers around sync fs internals —
// volume is tiny (one file, live only).
function createFileMatrixCache(file: string): MatrixCache {
  let data: Record<string, number> = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* first run: empty cache */
  }
  return {
    async getMany(keys) {
      const out: Record<string, number> = {};
      for (const k of keys) {
        if (k in data) out[k] = data[k];
      }
      return out;
    },
    async setMany(entries) {
      for (const { key, minutes } of entries) {
        data[key] = minutes;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    },
  };
}

export function getMapsProvider(): MapsProvider {
  if (process.env.MAPS_PROVIDER === "fixture" || !process.env.GOOGLE_MAPS_API_KEY) {
    return createFixtureAdapter();
  }
  // Lazy import keeps the real adapter out of every bundle that never uses it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRealAdapter } = require("./maps/realAdapter") as typeof import("./maps/realAdapter");
  // KV cache when both env vars present (live Vercel); file cache otherwise (local dev).
  const cache: MatrixCache =
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
      ? createKvMatrixCache()
      : createFileMatrixCache(path.join(process.cwd(), ".cache", "matrix-cache.json"));
  return createRealAdapter({ cache });
}

export function getTripStore(): TripStore {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return createKvStore(); // UNVERIFIED until live checklist (§4)
  }
  return createFileStore(process.env.TRIPS_DIR ?? path.join(process.cwd(), ".trips"));
}
