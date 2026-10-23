// Singapore public-transport journey planner — MRT first, by construction.
//
// Chris's rules (2026-10-23), each implemented here, not hoped for:
//  - MRT is the backbone: the search runs over the rail network and minimises
//    a generalised cost = ride time + waits + walks weighted up (so walks stay
//    a short last mile) + a penalty per line change (so changes are kept to a
//    minimum without paying lots of extra travel time for it).
//  - Changing lines costs that interchange's REAL platform-to-platform walk
//    (Dhoby Ghaut NS↔NE is long, City Hall NS↔EW is cross-platform) — see
//    INTERCHANGE_WALK_MIN in ./network.
//  - A bus is used only (a) as ONE direct bus, no transfer, or (b) as ONE
//    feeder to/from the MRT when the nearest station is too far to walk.
//    Never bus→bus, never a bus between two train rides.
//  - Every step names what a rider needs: station exit, line and direction,
//    stops to ride; bus stop name + code + road, service number, its
//    terminus ("towards"), stops to ride, where to get off.
// Walk minutes use the app's own estimator (straight line × detour), which
// cuts through blocks the way locals walk rather than tracing street edges.

import { walkMinutes } from "../../maps/walkEstimator";
import { DEFAULT_SETTINGS, type LatLng, type Settings } from "../../maps/types";
import {
  BUS_KMH,
  BUS_WAIT_MIN,
  LINES,
  MRT_WAIT_MIN,
  inSingapore,
  interchangeWalkMin,
  sgNetwork,
  type LineId,
  type Network,
} from "./network";

export type StopRef = { code: string; name: string; road: string };

export type JourneyStep =
  | { kind: "walk"; minutes: number; to: string }
  | {
      kind: "mrt";
      line: LineId;
      /** What the signs say ("CC" for both Circle Line services). */
      badge: string;
      lineName: string;
      color: string;
      from: string;
      to: string;
      /** The line's terminus in the direction of travel; absent on the Circle
       * Line loop, where `nextStop` is what tells the rider the direction. */
      towards?: string;
      nextStop: string;
      stops: number;
      waitMin: number;
      minutes: number;
    }
  | { kind: "change"; at: string; toLine: LineId; toLineName: string; walkMin: number }
  | {
      kind: "bus";
      service: string;
      towards: string;
      /** Set on loop services, where `towards` is just the start again. */
      loopVia?: string;
      board: StopRef;
      alight: StopRef;
      stops: number;
      waitMin: number;
      minutes: number;
    };

export type Journey = { minutes: number; steps: JourneyStep[] };

// Generalised-cost knobs (minutes of "pain").
const WALK_WEIGHT = 1.5;
const CHANGE_PENALTY = 4;
const BUS_PENALTY = 5;
/** A FEEDER bus's riding weighs more than train riding, so it takes the
 * short hop to the nearest line instead of a 30-min detour around the MRT.
 * A direct bus competes on plain time (plus BUS_PENALTY). */
const FEEDER_RIDE_WEIGHT = 1.5;
const MAX_STATION_WALK_MIN = 15;
const MRT_TOO_FAR_MIN = 10;
const MAX_BUS_STOP_WALK_MIN = 7;
const FEEDER_STOP_TO_EXIT_MIN = 4;

const LINE_IDS = Object.keys(LINES) as LineId[];
const L = LINE_IDS.length;

type Access = { station: number; exit: string; walkMin: number };
type BusLeg = { pattern: number; from: number; to: number; minutes: number };

const memo = new Map<string, { stations: Access[]; stops: Array<{ stop: number; walkMin: number }> }>();
/** Degrees of latitude/longitude comfortably beyond `maxMin` of walking —
 * a cheap reject before the haversine (1° ≈ 111 km at the equator). */
const reach = (maxMin: number, s: Settings) => (maxMin * s.walkSpeedMPerMin) / 111_000 + 0.001;
const far = (a: LatLng, b: LatLng, deg: number) => Math.abs(a.lat - b.lat) > deg || Math.abs(a.lng - b.lng) > deg;

function near(net: Network, p: LatLng, s: Settings) {
  const key = `${p.lat},${p.lng},${s.detourFactor},${s.walkSpeedMPerMin}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const stations: Access[] = [];
  const stationDeg = reach(MAX_STATION_WALK_MIN, s);
  const stopDeg = reach(MAX_BUS_STOP_WALK_MIN, s);
  net.stations.forEach((st, i) => {
    let best: Access | null = null;
    for (const e of st.exits.length ? st.exits : [{ name: "", point: st.point }]) {
      if (far(p, e.point, stationDeg)) continue;
      const w = walkMinutes(p, e.point, s);
      if (!best || w < best.walkMin) best = { station: i, exit: e.name, walkMin: w };
    }
    if (best && best.walkMin <= MAX_STATION_WALK_MIN) stations.push(best);
  });
  const stops: Array<{ stop: number; walkMin: number }> = [];
  net.busStops.forEach((b, i) => {
    if (far(p, b.point, stopDeg)) return;
    const w = walkMinutes(p, b.point, s);
    if (w <= MAX_BUS_STOP_WALK_MIN) stops.push({ stop: i, walkMin: w });
  });
  if (memo.size > 2000) memo.clear();
  const out = { stations, stops };
  memo.set(key, out);
  return out;
}

let stopStationCache: Array<Access | null> | null = null;
/** Bus stop -> the station exit it feeds (≤ FEEDER_STOP_TO_EXIT_MIN walk). */
function stopToStation(net: Network): Array<Access | null> {
  if (stopStationCache) return stopStationCache;
  const deg = reach(FEEDER_STOP_TO_EXIT_MIN, DEFAULT_SETTINGS);
  stopStationCache = net.busStops.map((b) => {
    let best: Access | null = null;
    net.stations.forEach((st, i) => {
      for (const e of st.exits) {
        if (far(b.point, e.point, deg)) continue;
        const w = walkMinutes(b.point, e.point, DEFAULT_SETTINGS);
        if (w <= FEEDER_STOP_TO_EXIT_MIN && (!best || w < best.walkMin)) best = { station: i, exit: e.name, walkMin: w };
      }
    });
    return best;
  });
  return stopStationCache;
}

const busMinutes = (net: Network, pattern: number, from: number, to: number) =>
  ((net.busPatterns[pattern].km[to] - net.busPatterns[pattern].km[from]) / BUS_KMH) * 60;

/** Single-bus legs from stops near `p` to stops that feed a station (or the
 * reverse when `towardsP`). Only used when no station is walkable. */
function feeders(net: Network, p: LatLng, s: Settings, towardsP: boolean) {
  const feed = stopToStation(net);
  const out: Array<{ walkMin: number; bus: BusLeg; station: Access }> = [];
  for (const { stop, walkMin } of near(net, p, s).stops) {
    for (const [pi, pos] of net.patternsAtStop[stop]) {
      const stops = net.busPatterns[pi].stops;
      const range = towardsP ? [0, pos] : [pos + 1, stops.length];
      for (let k = range[0]; k < range[1]; k++) {
        const st = feed[stops[k]];
        if (!st) continue;
        const bus = towardsP ? { pattern: pi, from: k, to: pos, minutes: 0 } : { pattern: pi, from: pos, to: k, minutes: 0 };
        bus.minutes = busMinutes(net, pi, bus.from, bus.to);
        if (bus.minutes > 0) out.push({ walkMin, bus, station: st });
      }
    }
  }
  return out;
}

type Option = { gen: number; minutes: number; steps: JourneyStep[] };

function stopRef(net: Network, i: number): StopRef {
  const b = net.busStops[i];
  return { code: b.code, name: b.name, road: b.road };
}

function busStep(net: Network, leg: BusLeg): JourneyStep {
  const p = net.busPatterns[leg.pattern];
  return {
    kind: "bus",
    service: p.service,
    towards: p.towards,
    ...(p.loopVia && leg.from < p.loopViaPos! ? { loopVia: p.loopVia } : {}),
    board: stopRef(net, p.stops[leg.from]),
    alight: stopRef(net, p.stops[leg.to]),
    stops: leg.to - leg.from,
    waitMin: BUS_WAIT_MIN,
    minutes: leg.minutes,
  };
}

const stationLabel = (net: Network, a: Access) =>
  `${net.stations[a.station].name} station${a.exit ? ` (Exit ${a.exit})` : ""}`;
const stopLabel = (net: Network, stop: number) => {
  const b = net.busStops[stop];
  return `bus stop ${b.name} (${b.code})`;
};

function directBus(net: Network, a: LatLng, b: LatLng, s: Settings): Option | null {
  const toB = new Map(near(net, b, s).stops.map((x) => [x.stop, x.walkMin]));
  let best: Option | null = null;
  for (const { stop, walkMin: wa } of near(net, a, s).stops) {
    for (const [pi, pos] of net.patternsAtStop[stop]) {
      const stops = net.busPatterns[pi].stops;
      for (let k = pos + 1; k < stops.length; k++) {
        const wb = toB.get(stops[k]);
        if (wb === undefined) continue;
        const ride = busMinutes(net, pi, pos, k);
        if (ride <= 0) continue;
        const gen = (wa + wb) * WALK_WEIGHT + BUS_WAIT_MIN + ride + BUS_PENALTY;
        if (best && gen >= best.gen) continue;
        best = {
          gen,
          minutes: wa + BUS_WAIT_MIN + ride + wb,
          steps: [
            { kind: "walk", minutes: wa, to: stopLabel(net, stop) },
            busStep(net, { pattern: pi, from: pos, to: k, minutes: ride }),
            { kind: "walk", minutes: wb, to: "your destination" },
          ],
        };
      }
    }
  }
  return best;
}

type Source = { gen: number; minutes: number; steps: JourneyStep[] };

/** Binary min-heap of (key, node) with lazy deletion — Dijkstra's frontier. */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, val: number): void {
    let i = this.keys.length;
    this.keys.push(key);
    this.vals.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }
  pop(): number {
    const top = this.vals[0];
    const key = this.keys.pop()!;
    const val = this.vals.pop()!;
    if (this.keys.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= this.keys.length) break;
        const c = l + 1 < this.keys.length && this.keys[l + 1] < this.keys[l] ? l + 1 : l;
        if (this.keys[c] >= key) break;
        this.keys[i] = this.keys[c];
        this.vals[i] = this.vals[c];
        i = c;
      }
      this.keys[i] = key;
      this.vals[i] = val;
    }
    return top;
  }
}

function viaMrt(net: Network, a: LatLng, b: LatLng, s: Settings): Option | null {
  const nearA = near(net, a, s).stations;
  const nearB = near(net, b, s).stations;

  // ---- sources: walk to a station, or (no station walkable) one feeder bus
  const sources = new Map<number, Source>(); // station -> best entry
  const offer = (station: number, src: Source) => {
    const cur = sources.get(station);
    if (!cur || src.gen < cur.gen) sources.set(station, src);
  };
  for (const acc of nearA) {
    offer(acc.station, {
      gen: acc.walkMin * WALK_WEIGHT,
      minutes: acc.walkMin,
      steps: [{ kind: "walk", minutes: acc.walkMin, to: stationLabel(net, acc) }],
    });
  }
  if (!nearA.some((x) => x.walkMin <= MRT_TOO_FAR_MIN)) {
    for (const f of feeders(net, a, s, false)) {
      const stopIdx = net.busPatterns[f.bus.pattern].stops[f.bus.from];
      offer(f.station.station, {
        gen: (f.walkMin + f.station.walkMin) * WALK_WEIGHT + BUS_WAIT_MIN + f.bus.minutes * FEEDER_RIDE_WEIGHT + BUS_PENALTY,
        minutes: f.walkMin + BUS_WAIT_MIN + f.bus.minutes + f.station.walkMin,
        steps: [
          { kind: "walk", minutes: f.walkMin, to: stopLabel(net, stopIdx) },
          busStep(net, f.bus),
          { kind: "walk", minutes: f.station.walkMin, to: stationLabel(net, f.station) },
        ],
      });
    }
  }

  // ---- sinks: walk out of a station, or (none walkable) one feeder bus
  const sinks = new Map<number, Source>();
  const sink = (station: number, src: Source) => {
    const cur = sinks.get(station);
    if (!cur || src.gen < cur.gen) sinks.set(station, src);
  };
  for (const acc of nearB) {
    sink(acc.station, {
      gen: acc.walkMin * WALK_WEIGHT,
      minutes: acc.walkMin,
      steps: [{ kind: "walk", minutes: acc.walkMin, to: `your destination${acc.exit ? ` (leave by Exit ${acc.exit})` : ""}` }],
    });
  }
  if (!nearB.some((x) => x.walkMin <= MRT_TOO_FAR_MIN)) {
    for (const f of feeders(net, b, s, true)) {
      const stopIdx = net.busPatterns[f.bus.pattern].stops[f.bus.from];
      sink(f.station.station, {
        gen: (f.walkMin + f.station.walkMin) * WALK_WEIGHT + BUS_WAIT_MIN + f.bus.minutes * FEEDER_RIDE_WEIGHT + BUS_PENALTY,
        minutes: f.station.walkMin + BUS_WAIT_MIN + f.bus.minutes + f.walkMin,
        steps: [
          { kind: "walk", minutes: f.station.walkMin, to: `${stopLabel(net, stopIdx)}${f.station.exit ? ` (leave by Exit ${f.station.exit})` : ""}` },
          busStep(net, f.bus),
          { kind: "walk", minutes: f.walkMin, to: "your destination" },
        ],
      });
    }
  }
  if (sources.size === 0 || sinks.size === 0) return null;

  // ---- Dijkstra over (station, line) on generalised cost
  const N = net.stations.length * L;
  const gen = new Float64Array(N).fill(Infinity);
  const time = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const rode = new Uint8Array(N);
  const done = new Uint8Array(N);
  const node = (st: number, li: number) => st * L + li;

  const heap = new MinHeap();
  for (const [st, src] of sources) {
    for (const line of net.stations[st].lines) {
      const n = node(st, LINE_IDS.indexOf(line));
      const g = src.gen + MRT_WAIT_MIN;
      if (g < gen[n]) {
        gen[n] = g;
        time[n] = src.minutes + MRT_WAIT_MIN;
        heap.push(g, n);
      }
    }
  }
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    const st = Math.floor(u / L);
    const line = LINE_IDS[u % L];
    for (const e of net.rail[line].get(st) ?? []) {
      const v = node(e.to, u % L);
      if (gen[u] + e.minutes < gen[v]) {
        gen[v] = gen[u] + e.minutes;
        time[v] = time[u] + e.minutes;
        prev[v] = u;
        rode[v] = 1;
        heap.push(gen[v], v);
      }
    }
    for (const other of net.stations[st].lines) {
      if (other === line) continue;
      const walk = interchangeWalkMin(net.stations[st].name, line, other);
      const v = node(st, LINE_IDS.indexOf(other));
      const g = gen[u] + walk * WALK_WEIGHT + MRT_WAIT_MIN + CHANGE_PENALTY;
      if (g < gen[v]) {
        gen[v] = g;
        time[v] = time[u] + walk + MRT_WAIT_MIN;
        prev[v] = u;
        rode[v] = rode[u];
        heap.push(g, v);
      }
    }
  }

  // ---- best exit
  let bestNode = -1;
  let bestGen = Infinity;
  for (const [st, out] of sinks) {
    for (const line of net.stations[st].lines) {
      const n = node(st, LINE_IDS.indexOf(line));
      if (!rode[n] || gen[n] === Infinity) continue;
      if (gen[n] + out.gen < bestGen) {
        bestGen = gen[n] + out.gen;
        bestNode = n;
      }
    }
  }
  if (bestNode < 0) return null;

  // ---- reconstruct
  const path: number[] = [];
  for (let n = bestNode; n >= 0; n = prev[n]) path.unshift(n);
  const firstSt = Math.floor(path[0] / L);
  const lastSt = Math.floor(bestNode / L);
  const steps: JourneyStep[] = [...sources.get(firstSt)!.steps];
  let i = 0;
  while (i < path.length) {
    const li = path[i] % L;
    let j = i;
    while (j + 1 < path.length && path[j + 1] % L === li) j++;
    if (j > i) {
      const line = LINE_IDS[li];
      const a = Math.floor(path[i] / L);
      const next = Math.floor(path[i + 1] / L);
      const z = Math.floor(path[j] / L);
      const order = net.lineOrder[line];
      const towards =
        line === "CR" ? undefined : net.stations[order[order.indexOf(next) > order.indexOf(a) ? order.length - 1 : 0]].name;
      steps.push({
        kind: "mrt",
        line,
        badge: LINES[line].badge,
        lineName: LINES[line].name,
        color: LINES[line].color,
        from: net.stations[a].name,
        to: net.stations[z].name,
        ...(towards ? { towards } : {}),
        nextStop: net.stations[next].name,
        stops: j - i,
        waitMin: MRT_WAIT_MIN,
        minutes: time[path[j]] - time[path[i]],
      });
    }
    if (j + 1 < path.length) {
      const at = Math.floor(path[j] / L);
      const toLine = LINE_IDS[path[j + 1] % L];
      steps.push({
        kind: "change",
        at: net.stations[at].name,
        toLine,
        toLineName: LINES[toLine].name,
        walkMin: interchangeWalkMin(net.stations[at].name, LINE_IDS[li], toLine),
      });
    }
    i = j + 1;
  }
  steps.push(...sinks.get(lastSt)!.steps);
  return { gen: bestGen, minutes: time[bestNode] + sinks.get(lastSt)!.minutes, steps };
}

/** `transitFor` for buildEffectiveMatrix: a journey only when both ends are
 * in Singapore. */
export function sgTransitFor(settings: Settings) {
  return (a: LatLng, b: LatLng): Journey | null =>
    inSingapore(a) && inSingapore(b) ? planSgJourney(a, b, settings) : null;
}

/** The best public-transport journey from `a` to `b`, or null when neither
 * end is in Singapore's network reach. Walk-only is NOT considered here —
 * that comparison belongs to the caller's walk/transit/drive decision. */
export function planSgJourney(a: LatLng, b: LatLng, settings: Settings = DEFAULT_SETTINGS): Journey | null {
  const net = sgNetwork();
  const options = [viaMrt(net, a, b, settings), directBus(net, a, b, settings)].filter((o): o is Option => o !== null);
  if (options.length === 0) return null;
  const best = options.reduce((x, y) => (y.gen < x.gen ? y : x));
  // A sub-minute walk (destination at the exit) is not a step worth reading.
  return { minutes: best.minutes, steps: best.steps.filter((st) => st.kind !== "walk" || st.minutes >= 0.5) };
}
