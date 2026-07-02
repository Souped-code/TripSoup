// Vercel KV tripStore — §4: written but UNVERIFIED until the live checklist
// (provisioning KV is a Chris step; no KV credentials exist in this run).
// Vercel KV speaks the Upstash Redis REST protocol, so plain fetch suffices —
// no extra dependency.

import type { TripDoc, TripStore } from "./types";

export function createKvStore(): TripStore {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error("KV store constructed without KV_REST_API_URL / KV_REST_API_TOKEN");
  }
  const headers = { Authorization: `Bearer ${token}` };
  return {
    async get(tripId) {
      const res = await fetch(`${url}/get/trip:${tripId}`, { headers });
      if (!res.ok) throw new Error(`KV get failed: ${res.status}`);
      const { result } = (await res.json()) as { result: string | null };
      return result ? (JSON.parse(result) as TripDoc) : null;
    },
    async put(doc) {
      const res = await fetch(`${url}/set/trip:${doc.tripId}`, {
        method: "POST",
        headers,
        body: JSON.stringify(doc),
      });
      if (!res.ok) throw new Error(`KV set failed: ${res.status}`);
    },
  };
}
