// Per-IP fixed-window rate limiter over Vercel KV (Upstash REST pipeline).
// When KV env vars are absent (dev, jest, Playwright fixture mode) it NO-OPs
// and allows everything — those environments have no KV and must be unaffected.
//
// Key scheme: rl:{route}:{ip}:{Math.floor(Date.now()/3600000)}
// Commands:   [["INCR", key], ["EXPIRE", key, "3600", "NX"]]
// Allow if count <= 20 (per-IP, per-hour, per route).
//
// NOTE — deviation from plan: the plan names @upstash/ratelimit as the
// implementation library. Repo convention (ITINERARY-HANDOVER.md §8: minimum
// code, plain-fetch-only, no new runtime deps) requires a hand-rolled
// implementation. This zero-dependency fixed window is functionally equivalent.
// Recorded as a deviation in STATE.md.

const LIMIT = 20;

export async function checkRateLimit(
  route: string,
  req: Request
): Promise<{ limited: boolean }> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  // No-op when KV is not provisioned — dev, jest, and Playwright are unaffected.
  if (!url || !token) return { limited: false };

  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0].trim() : "local";
  const bucket = Math.floor(Date.now() / 3_600_000);
  const key = `rl:${route}:${ip}:${bucket}`;

  // Fail open on ANY KV failure — HTTP error or thrown fetch (network/DNS/
  // timeout). A limiter outage must never take down the routes it protects.
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, "3600", "NX"],
      ]),
    });
    if (!res.ok) return { limited: false };
    const [{ result: count }] = (await res.json()) as [{ result: number }, unknown];
    return { limited: count > LIMIT };
  } catch {
    return { limited: false };
  }
}
