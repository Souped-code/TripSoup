// Server-side ONLY. Requires process.env.GOOGLE_MAPS_API_KEY.
// Turns messy Google Maps share links / place names into canonical Stops.

export type Stop = {
  id: string; // Google place_id — canonical
  name: string;
  location: { lat: number; lng: number };
  address: string;
  openingHours?: unknown; // raw Places (New) regularOpeningHours
  source: string; // original input string
};

export type Failure = { source: string; reason: string };

export type ResolveResult = { stops: Stop[]; failures: Failure[] };

type Parsed = {
  query: string | null; // extracted name or search text
  coords: { lat: number; lng: number } | null;
};

const PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location,places.regularOpeningHours";

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

function isShortLink(u: string): boolean {
  return /(?:^|\.)goo\.gl$|maps\.app\.goo\.gl/i.test(new URL(u).hostname);
}

// Follow redirects server-side and return the final full Maps URL.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function resolveRedirect(shortUrl: string): Promise<string> {
  const res = await fetch(shortUrl, {
    redirect: "follow",
    headers: { "User-Agent": BROWSER_UA },
  });
  const finalUrl = res.url;
  if (!res.ok) {
    throw new Error(`short link fetch failed: HTTP ${res.status} (dead/invalid link?)`);
  }
  if (/consent\.google\.com|\/sorry\//i.test(finalUrl)) {
    throw new Error(`redirect landed on consent/captcha wall: ${finalUrl}`);
  }
  if (finalUrl === shortUrl || /maps\.app\.goo\.gl/i.test(finalUrl)) {
    throw new Error(`short link did not redirect to a full Maps URL (final: ${finalUrl})`);
  }
  return finalUrl;
}

// Extract a query string (place name / search text) and coords from a full Maps URL.
export function parseMapsUrl(fullUrl: string): Parsed {
  const url = new URL(fullUrl);
  const path = decodeURIComponent(url.pathname);

  // name from /maps/place/<NAME>/ ...
  let query: string | null = null;
  const placeMatch = path.match(/\/maps\/place\/([^/@]+)/);
  if (placeMatch) {
    query = placeMatch[1].replace(/\+/g, " ").trim();
    // A raw hex place ref (0x...:0x...) is not a usable name.
    if (/^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(query)) query = null;
  }
  // fallback: /maps/search/<QUERY> or ?q=
  if (!query) {
    const searchMatch = path.match(/\/maps\/search\/([^/@]+)/);
    if (searchMatch) query = searchMatch[1].replace(/\+/g, " ").trim();
  }
  if (!query) {
    const q = url.searchParams.get("q") || url.searchParams.get("query");
    if (q && !/^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(q)) query = q.trim();
  }

  // coords: @lat,lng  ->  !3dLAT!4dLNG  ->  q=lat,lng
  let coords: { lat: number; lng: number } | null = null;
  const at = fullUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) coords = { lat: parseFloat(at[1]), lng: parseFloat(at[2]) };
  if (!coords) {
    const data = fullUrl.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (data) coords = { lat: parseFloat(data[1]), lng: parseFloat(data[2]) };
  }
  if (!coords) {
    const q = url.searchParams.get("q") || "";
    const ll = q.match(/^(-?\d+\.\d+),\s*(-?\d+\.\d+)$/);
    if (ll) coords = { lat: parseFloat(ll[1]), lng: parseFloat(ll[2]) };
  }

  return { query, coords };
}

async function textSearch(
  query: string,
  coords: { lat: number; lng: number } | null,
  apiKey: string
): Promise<Stop | null> {
  const body: Record<string, unknown> = { textQuery: query };
  if (coords) {
    body.locationBias = {
      circle: {
        center: { latitude: coords.lat, longitude: coords.lng },
        radius: 500.0,
      },
    };
  }

  const res = await fetch(PLACES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Places API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    places?: Array<{
      id: string;
      displayName?: { text: string };
      formattedAddress?: string;
      location?: { latitude: number; longitude: number };
      regularOpeningHours?: unknown;
    }>;
  };

  const p = data.places?.[0];
  if (!p || !p.id || !p.location) return null;

  return {
    id: p.id,
    name: p.displayName?.text ?? query,
    location: { lat: p.location.latitude, lng: p.location.longitude },
    address: p.formattedAddress ?? "",
    openingHours: p.regularOpeningHours,
    source: "", // filled by caller
  };
}

async function resolveOne(input: string, apiKey: string): Promise<Stop> {
  let query: string | null;
  let coords: { lat: number; lng: number } | null = null;

  if (isUrl(input)) {
    let fullUrl = input;
    if (isShortLink(input)) {
      fullUrl = await resolveRedirect(input);
    }
    const parsed = parseMapsUrl(fullUrl);
    query = parsed.query;
    coords = parsed.coords;
    if (!query) {
      throw new Error(
        `could not extract a place name from URL (final: ${fullUrl.slice(0, 120)})`
      );
    }
  } else {
    query = input.trim();
  }

  const stop = await textSearch(query, coords, apiKey);
  if (!stop) throw new Error(`Places returned no match for "${query}"`);
  stop.source = input;
  return stop;
}

export async function resolvePlaces(inputs: string[]): Promise<ResolveResult> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_MAPS_API_KEY is not set");

  const stops: Stop[] = [];
  const failures: Failure[] = [];

  for (const input of inputs) {
    try {
      const stop = await resolveOne(input, apiKey);
      stops.push(stop);
      // eslint-disable-next-line no-console
      console.log(`  OK  ${input}\n      -> ${stop.id}  (${stop.name})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ source: input, reason });
      // eslint-disable-next-line no-console
      console.log(`  FAIL ${input}\n      -> ${reason}`);
    }
  }

  return { stops, failures };
}
