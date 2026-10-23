// Singapore MRT + bus network, built once per process from the static dataset
// (scripts/build-sg-transit.ts; sources and licences in ./DATA.md). PURE —
// no network, no clock. The router (./router.ts) is the only consumer.

import raw from "./sgTransit.data.json";
import { haversineMeters } from "../../maps/walkEstimator";
import type { LatLng } from "../../maps/types";

type RawData = {
  builtAt: string;
  busDataUpdated: string;
  stations: Array<{ name: string; codes: string[]; lat: number; lng: number; exits: Array<[string, number, number]> }>;
  busStops: Array<[string, string, string, number, number]>;
  busPatterns: Array<{ svc: string; dir: number; stops: number[]; km: number[] }>;
};

/** A train SERVICE, not just a coloured line: the Circle Line is two —
 * "CC" runs Dhoby Ghaut–HarbourFront, "CR" runs the loop (Promenade → … →
 * HarbourFront → Keppel → Marina Bay → Bayfront → Promenade). No train runs
 * Esplanade → Promenade → Bayfront (it would have to reverse), so that move
 * is a change at Promenade. ASSUMPTION about post-CCL6 operations — confirm. */
export type LineId = "NS" | "EW" | "CG" | "NE" | "CC" | "CR" | "DT" | "TE" | "SE";

export const LINES: Record<LineId, { name: string; color: string; badge: string }> = {
  NS: { name: "North South Line", color: "#d42e12", badge: "NS" },
  EW: { name: "East West Line", color: "#009645", badge: "EW" },
  CG: { name: "East West Line (Changi Airport branch)", color: "#009645", badge: "EW" },
  NE: { name: "North East Line", color: "#9900aa", badge: "NE" },
  CC: { name: "Circle Line", color: "#fa9e0d", badge: "CC" },
  CR: { name: "Circle Line (loop via Marina Bay)", color: "#fa9e0d", badge: "CC" },
  DT: { name: "Downtown Line", color: "#005ec4", badge: "DT" },
  TE: { name: "Thomson-East Coast Line", color: "#9d5b25", badge: "TE" },
  SE: { name: "Sentosa Express", color: "#e2007a", badge: "SE" },
};

// ---------------------------------------------------------------------------
// Tunables. ESTIMATES until LTA's GTFS rail timetable (DataMall key) replaces
// the run-time formula — every number here is a knob, not a fact.
// ---------------------------------------------------------------------------

/** Run time between adjacent stations: dwell + accel/brake, then ~60 km/h over
 * the straight-line distance stretched 15% for track curvature. Varies with
 * the real gap between stations (Expo–Changi Airport ≈ 5 min, City Hall–
 * Raffles Place ≈ 2 min) rather than a flat per-station cost. */
export function runMinutes(km: number): number {
  return 1.0 + km * 1.15;
}
/** Average wait for a train (half an off-peak headway). */
export const MRT_WAIT_MIN = 3;
/** Average wait for a bus (half a ~12 min headway). */
export const BUS_WAIT_MIN = 6;
/** Door-to-door bus speed incl. stops and lights. */
export const BUS_KMH = 18;

/** Platform-to-platform walk between two lines at an interchange, minutes.
 * Local-knowledge ESTIMATES (2026-10-23) — correct these from experience.
 * Cross-platform pairs are 1; the notorious long ones (Dhoby Ghaut NS↔NE/CC,
 * Newton, Tampines, Bugis, Orchard) are 6–7. Key = the two line ids sorted. */
export const INTERCHANGE_WALK_MIN: Record<string, Record<string, number>> = {
  "Jurong East": { "EW-NS": 1 },
  "City Hall": { "EW-NS": 1 },
  "Raffles Place": { "EW-NS": 1 },
  "Tanah Merah": { "CG-EW": 1 },
  "Dhoby Ghaut": { "NE-NS": 6, "CC-NS": 6, "CC-NE": 4 },
  "Bishan": { "CC-NS": 4 },
  "Newton": { "DT-NS": 7 },
  "Orchard": { "NS-TE": 6 },
  "Woodlands": { "NS-TE": 5 },
  "Marina Bay": { "NS-TE": 5, "CC-NS": 4, "CC-TE": 4 },
  "Outram Park": { "EW-NE": 4, "NE-TE": 5, "EW-TE": 6 },
  "HarbourFront": { "CC-NE": 5, "NE-SE": 6, "CC-SE": 6 },
  "Chinatown": { "DT-NE": 4 },
  "Little India": { "DT-NE": 3 },
  "Serangoon": { "CC-NE": 4 },
  "Promenade": { "CC-DT": 4 },
  "Bayfront": { "CC-DT": 2 },
  "Bugis": { "DT-EW": 6 },
  "Paya Lebar": { "CC-EW": 4 },
  "MacPherson": { "CC-DT": 3 },
  "Tampines": { "DT-EW": 7 },
  "Expo": { "CG-DT": 5 },
  "Buona Vista": { "CC-EW": 4 },
  "Botanic Gardens": { "CC-DT": 4 },
  "Caldecott": { "CC-TE": 4 },
  "Stevens": { "DT-TE": 4 },
};
const DEFAULT_INTERCHANGE_WALK_MIN = 4;

export function interchangeWalkMin(station: string, a: LineId, b: LineId): number {
  const key = [a, b].sort().join("-");
  if (key === "CC-CR") return 1; // the other Circle Line service, same platforms
  return INTERCHANGE_WALK_MIN[station]?.[key] ?? DEFAULT_INTERCHANGE_WALK_MIN;
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export type Station = {
  name: string;
  lines: LineId[];
  point: LatLng;
  exits: Array<{ name: string; point: LatLng }>;
};
export type RailEdge = { to: number; minutes: number };
export type BusStop = { code: string; name: string; road: string; point: LatLng };
export type BusPattern = { service: string; stops: number[]; km: number[]; towards: string };

export type Network = {
  stations: Station[];
  /** Per line: station indices in code order (the direction "towards" reads the ends). */
  lineOrder: Record<LineId, number[]>;
  /** Per line: station -> adjacent stations on that line, with run minutes. */
  rail: Record<LineId, Map<number, RailEdge[]>>;
  busStops: BusStop[];
  busPatterns: BusPattern[];
  /** bus stop -> [pattern, position] for every pattern serving it. */
  patternsAtStop: Array<Array<[number, number]>>;
  builtAt: string;
  busDataUpdated: string;
};

const numberOf = (code: string): number => Number(code.replace(/^[A-Z]+/, "") || 0);
/** The services stopping at a station code (see LineId on the Circle Line). */
const servicesOf = (code: string): LineId[] => {
  const prefix = code.match(/^[A-Z]+/)?.[0];
  if (prefix === "CC") {
    const n = numberOf(code);
    return [...(n <= 29 ? (["CC"] as const) : []), ...(n >= 4 ? (["CR"] as const) : [])];
  }
  return prefix && prefix in LINES ? [prefix as LineId] : [];
};

/** Track the topology can't infer from code order: the loop service closes
 * Marina Bay (CC33) – Bayfront (CC34) – Promenade (CC4). */
const EXTRA_EDGES: Array<[LineId, string, string]> = [["CR", "CC34", "CC4"]];

/** The Sentosa Express monorail isn't in LTA's rail data. Its VivoCity
 * terminal is modelled as part of HarbourFront (the walk is the interchange
 * time above). Coordinates are APPROXIMATE (hand-placed, 2026-10-23). */
const SENTOSA_EXPRESS: Array<{ name: string; lat: number; lng: number }> = [
  { name: "Resorts World", lat: 1.25697, lng: 103.82131 },
  { name: "Imbiah", lat: 1.2547, lng: 103.8172 },
  { name: "Beach", lat: 1.2494, lng: 103.8197 },
];

let cached: Network | null = null;

export function sgNetwork(): Network {
  if (cached) return cached;
  const data = raw as unknown as RawData;

  const stations: Station[] = data.stations.map((s) => ({
    name: s.name,
    lines: [...new Set(s.codes.flatMap(servicesOf))],
    point: { lat: s.lat, lng: s.lng },
    exits: s.exits.map(([name, lat, lng]) => ({ name, point: { lat, lng } })),
  }));

  const byCode = new Map<string, number>();
  data.stations.forEach((s, i) => s.codes.forEach((c) => byCode.set(c, i)));

  const lineOrder = {} as Record<LineId, number[]>;
  const rail = {} as Record<LineId, Map<number, RailEdge[]>>;
  const link = (line: LineId, a: number, b: number) => {
    const km = haversineMeters(stations[a].point, stations[b].point) / 1000;
    const minutes = runMinutes(km);
    const adj = rail[line];
    (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, minutes });
    (adj.get(b) ?? adj.set(b, []).get(b)!).push({ to: a, minutes });
  };
  for (const line of Object.keys(LINES) as LineId[]) {
    const codes = [...byCode.keys()].filter((c) => servicesOf(c).includes(line)).sort((a, b) => numberOf(a) - numberOf(b));
    lineOrder[line] = codes.map((c) => byCode.get(c)!);
    rail[line] = new Map();
    for (let i = 1; i < codes.length; i++) link(line, byCode.get(codes[i - 1])!, byCode.get(codes[i])!);
  }
  for (const [line, a, b] of EXTRA_EDGES) {
    if (byCode.has(a) && byCode.has(b)) link(line, byCode.get(a)!, byCode.get(b)!);
  }
  const harbourFront = stations.findIndex((st) => st.name === "HarbourFront");
  if (harbourFront >= 0) {
    stations[harbourFront].lines.push("SE");
    lineOrder.SE = [harbourFront];
    rail.SE = new Map();
    for (const se of SENTOSA_EXPRESS) {
      stations.push({ name: se.name, lines: ["SE"], point: { lat: se.lat, lng: se.lng }, exits: [] });
      link("SE", lineOrder.SE[lineOrder.SE.length - 1], stations.length - 1);
      lineOrder.SE.push(stations.length - 1);
    }
  }

  const busStops: BusStop[] = data.busStops.map(([code, name, road, lat, lng]) => ({ code, name, road, point: { lat, lng } }));
  const busPatterns: BusPattern[] = data.busPatterns.map((p) => ({
    service: p.svc,
    stops: p.stops,
    km: p.km,
    towards: busStops[p.stops[p.stops.length - 1]].name,
  }));
  const patternsAtStop: Array<Array<[number, number]>> = busStops.map(() => []);
  busPatterns.forEach((p, pi) => p.stops.forEach((s, pos) => patternsAtStop[s].push([pi, pos])));

  cached = { stations, lineOrder, rail, busStops, busPatterns, patternsAtStop, builtAt: data.builtAt, busDataUpdated: data.busDataUpdated };
  return cached;
}

export { inSingapore } from "./region";
