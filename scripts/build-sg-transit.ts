// Builds src/lib/transit/sg/sgTransit.data.json — the static Singapore MRT +
// bus network the transit router reads. Run when LTA data changes:
//
//   npx tsx scripts/build-sg-transit.ts <sgraildata checkout> <sgbusdata checkout>
//
// Sources (see src/lib/transit/sg/DATA.md for licences):
//   sgraildata  data/v1/sg-rail.geojson         stations (codes, names, points) + entrances
//   sgbusdata   data/v1/raw/bus-stops.datamall.json, bus-routes.datamall.json  (LTA DataMall)
//               data/v1/raw/bus-services.json   service type (TRUNK vs city-direct/premium/shuttle)

import * as fs from "fs";
import * as path from "path";

const [railDir, busDir] = process.argv.slice(2);
if (!railDir || !busDir) throw new Error("usage: build-sg-transit.ts <sgraildata> <sgbusdata>");

const MRT_LINES = ["NS", "EW", "CG", "NE", "CC", "DT", "TE"];
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

type Feature = { geometry: { type: string; coordinates: number[] }; properties: Record<string, string> };
const rail = JSON.parse(fs.readFileSync(path.join(railDir, "data/v1/sg-rail.geojson"), "utf8")) as { features: Feature[] };

// ---- stations: MRT codes only (LRT-only stations dropped; LRT codes stripped) ----
const stations: Array<{ name: string; codes: string[]; lat: number; lng: number; exits: Array<[string, number, number]> }> = [];
const stationByCodes = new Map<string, number>();
for (const f of rail.features) {
  if (f.properties.stop_type !== "station" || f.geometry.type !== "Point") continue;
  const codes = f.properties.station_codes.split("-").filter((c) => MRT_LINES.some((l) => c.startsWith(l)));
  if (codes.length === 0) continue;
  const [lng, lat] = f.geometry.coordinates;
  stationByCodes.set(f.properties.station_codes, stations.length);
  stations.push({ name: f.properties.name, codes, lat: round6(lat), lng: round6(lng), exits: [] });
}
for (const f of rail.features) {
  if (f.properties.stop_type !== "entrance") continue;
  const i = stationByCodes.get(f.properties.station_codes);
  if (i === undefined) continue;
  const [lng, lat] = f.geometry.coordinates;
  stations[i].exits.push([f.properties.name, round6(lat), round6(lng)]);
}

// ---- bus ----
type DmStop = { BusStopCode: string; RoadName: string; Description: string; Latitude: number; Longitude: number };
type DmRoute = { ServiceNo: string; Direction: number; StopSequence: number; BusStopCode: string; Distance: number | null; WD_FirstBus: string; WD_LastBus: string };
const raw = (f: string) => JSON.parse(fs.readFileSync(path.join(busDir, "data/v1/raw", f), "utf8"));
const dmStops = raw("bus-stops.datamall.json") as DmStop[];
const dmRoutes = raw("bus-routes.datamall.json") as DmRoute[];
const trunk = new Set(
  (raw("bus-services.json") as Array<{ number: string | number; type: string }>)
    .filter((s) => s.type === "TRUNK")
    .map((s) => String(s.number))
);

const stopIndex = new Map<string, number>();
const busStops: Array<[string, string, string, number, number]> = [];
for (const s of dmStops) {
  if (!Number.isFinite(s.Latitude) || !Number.isFinite(s.Longitude) || s.Latitude === 0) continue;
  stopIndex.set(s.BusStopCode, busStops.length);
  busStops.push([s.BusStopCode, s.Description, s.RoadName, round6(s.Latitude), round6(s.Longitude)]);
}

// Daytime services only (running by 09:00 and still at 19:00): a peak-hour
// short-working, an express or a night service is not something a visitor
// can count on at an arbitrary time of day.
const hhmm = (t: string) => (t && /^\d{4}$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(2)) : NaN);
const allDay = (first: number, last: number) => first <= 9 * 60 && (last >= 19 * 60 || last < 4 * 60);

const groups = new Map<string, DmRoute[]>();
for (const r of dmRoutes) {
  const key = `${r.ServiceNo}|${r.Direction}`;
  (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
}
const busPatterns: Array<{ svc: string; dir: number; stops: number[]; km: number[] }> = [];
let skippedType = 0;
let skippedHours = 0;
for (const [key, rows] of groups) {
  const [svc, dir] = key.split("|");
  if (!trunk.has(svc)) { skippedType++; continue; }
  rows.sort((a, b) => a.StopSequence - b.StopSequence);
  if (!allDay(hhmm(rows[0].WD_FirstBus), hhmm(rows[0].WD_LastBus))) { skippedHours++; continue; }
  const stops: number[] = [];
  const km: number[] = [];
  for (const r of rows) {
    const i = stopIndex.get(r.BusStopCode);
    if (i === undefined || r.Distance == null) continue;
    stops.push(i);
    km.push(Math.round(r.Distance * 100) / 100);
  }
  if (stops.length >= 2) busPatterns.push({ svc, dir: Number(dir), stops, km });
}

const updated = fs.readFileSync(path.join(busDir, "data/v1/last-updated.txt"), "utf8").trim().replace(/"/g, "");
const out = { builtAt: new Date().toISOString().slice(0, 10), busDataUpdated: updated, stations, busStops, busPatterns };
const target = path.join(__dirname, "../src/lib/transit/sg/sgTransit.data.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(out));
console.log(
  `stations ${stations.length} (exits ${stations.reduce((n, s) => n + s.exits.length, 0)}), ` +
    `bus stops ${busStops.length}, patterns ${busPatterns.length} ` +
    `(skipped: ${skippedType} non-trunk, ${skippedHours} not all-day) -> ${(fs.statSync(target).size / 1024).toFixed(0)} KB`
);
