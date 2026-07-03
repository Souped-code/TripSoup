// KV matrix cache — Vercel KV (Upstash REST) backed MatrixCache.
// Same plain-fetch style as src/lib/store/kvStore.ts (Authorization: Bearer token).
// Keys are prefixed with "mx:" to namespace away from "trip:" store keys.
// Uses the POST {url}/pipeline endpoint with JSON command arrays so key counts
// never hit URL-length limits.

import type { MatrixCache } from "./matrixSource";

const KEY_PREFIX = "mx:";

export function createKvMatrixCache(): MatrixCache {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      "KV matrix cache constructed without KV_REST_API_URL / KV_REST_API_TOKEN"
    );
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  return {
    // getMany: pipeline [["MGET", ...prefixedKeys]] — one round-trip.
    async getMany(keys) {
      if (keys.length === 0) return {};
      const prefixed = keys.map((k) => `${KEY_PREFIX}${k}`);
      const res = await fetch(`${url}/pipeline`, {
        method: "POST",
        headers,
        body: JSON.stringify([["MGET", ...prefixed]]),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`KV getMany failed: ${res.status} ${text.slice(0, 200)}`);
      }
      const [{ result: values }] = (await res.json()) as [{ result: (string | null)[] }];
      const out: Record<string, number> = {};
      for (let i = 0; i < keys.length; i++) {
        const raw = values[i];
        if (raw !== null) {
          const n = parseFloat(raw);
          if (Number.isFinite(n)) out[keys[i]] = n;
        }
      }
      return out;
    },

    // setMany: pipeline [["MSET", k1, v1, k2, v2, ...]] — one round-trip.
    async setMany(entries) {
      if (entries.length === 0) return;
      const kv: string[] = [];
      for (const { key, minutes } of entries) {
        kv.push(`${KEY_PREFIX}${key}`, String(minutes));
      }
      const res = await fetch(`${url}/pipeline`, {
        method: "POST",
        headers,
        body: JSON.stringify([["MSET", ...kv]]),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`KV setMany failed: ${res.status} ${text.slice(0, 200)}`);
      }
    },
  };
}
