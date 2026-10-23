// Realism probe: a plausible 3-day Singapore paste (real coordinates, Google-like
// hours, MBS as home base) through the PRODUCTION solve path, with a synthetic
// drive matrix (no Maps key needed). Scenario B = the same places pasted
// without day headers. Usage: ENGINE_IN_WORKER=0 npx tsx bench/sg-probe.ts
import { solveWithPreparedMatrices, type PreparedDayMatrices } from "../src/lib/planEngine";
import { buildEffectiveMatrix } from "../src/lib/solver/effectiveMatrix";
import { sgTransitFor } from "../src/lib/transit/sg/router";
import { haversineMeters } from "../src/lib/maps/walkEstimator";
import { DEFAULT_SETTINGS, homeBaseMatrixId } from "../src/lib/maps/types";
import type { TripDoc, TripDay, TripStop } from "../src/lib/store/types";

const P: Record<string, [string, number, number]> = {
  merlion: ["Merlion Park", 1.2868, 103.8545],
  gbtb: ["Gardens by the Bay", 1.2816, 103.8636],
  maxwell: ["Maxwell Food Centre", 1.2803, 103.8448],
  btrt: ["Buddha Tooth Relic Temple", 1.2815, 103.8443],
  gallery: ["National Gallery Singapore", 1.2905, 103.8515],
  clarke: ["Clarke Quay", 1.2906, 103.8465],
  laupasat: ["Lau Pa Sat", 1.2807, 103.8504],
  zoo: ["Singapore Zoo", 1.4043, 103.793],
  safari: ["Night Safari", 1.4022, 103.7881],
  botanic: ["Singapore Botanic Gardens", 1.3138, 103.8159],
  orchard: ["ION Orchard", 1.304, 103.8318],
  tiongbahru: ["Tiong Bahru Market", 1.2851, 103.8326],
  uss: ["Universal Studios Singapore", 1.254, 103.8238],
  sea: ["S.E.A. Aquarium", 1.2584, 103.8207],
  tekka: ["Tekka Centre", 1.3064, 103.8505],
  mosque: ["Sultan Mosque", 1.3022, 103.859],
  haji: ["Haji Lane", 1.3007, 103.8588],
  jewel: ["Jewel Changi Airport", 1.3602, 103.9894],
};
const row = (a: number, b: number) => Array(7).fill([{ startMin: a * 60, endMin: b * 60 }]);
const HOURS: Record<string, any> = {
  gbtb: { byWeekday: row(5, 26 > 24 ? 23.99 : 2) }, maxwell: { byWeekday: row(8, 22) }, btrt: { byWeekday: row(7, 17) },
  gallery: { byWeekday: row(10, 19) }, clarke: { byWeekday: row(0, 23.99) }, laupasat: { byWeekday: row(0, 23.99) },
  zoo: { byWeekday: row(8.5, 18) }, safari: { byWeekday: row(19.25, 24 - 0.01) }, botanic: { byWeekday: row(5, 24 - 0.01) },
  orchard: { byWeekday: row(10, 22) }, tiongbahru: { byWeekday: row(6, 14) }, uss: { byWeekday: row(10, 19) },
  sea: { byWeekday: row(10, 17) }, tekka: { byWeekday: row(6.5, 21) }, mosque: { byWeekday: row(10, 16) },
  haji: { byWeekday: row(11, 21) }, jewel: { byWeekday: row(0, 23.99) },
};
const stop = (k: string, anchorHHMM?: string): TripStop => {
  const [name, lat, lng] = P[k];
  const s: TripStop = { id: k, name, location: { lat, lng }, durationMin: 60, hours: HOURS[k] ?? { byWeekday: Array(7).fill([{ startMin: 0, endMin: 1439 }]) } };
  if (anchorHHMM) { const [h, m] = anchorHHMM.split(":").map(Number); s.anchor = { startMin: h * 60 + m }; }
  return s;
};
const day = (date: string, stops: TripStop[]): TripDay => ({ date, dayStartMin: 540, dayEndMin: 1320, stops });
const base = { id: "mbs", name: "Marina Bay Sands", location: { lat: 1.2834, lng: 103.8607 }, source: "paste" as const };

// Synthetic drive model: road factor 1.4, 28 km/h urban average, +3 min.
const driveMin = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  (haversineMeters(a, b) * 1.4) / 1000 / 28 * 60 + 3;

async function run(label: string, doc: TripDoc) {
  const settings = { ...DEFAULT_SETTINGS, ...doc.settings };
  const matrices = doc.days.map((d) => {
    const pts = d.stops.map((s) => ({ id: s.id, location: s.location }));
    if (doc.homeBase) pts.push({ id: homeBaseMatrixId(doc.homeBase.id), location: doc.homeBase.location });
    const drive: Record<string, Record<string, number>> = {};
    for (const a of pts) { drive[a.id] = {}; for (const b of pts) drive[a.id][b.id] = a.id === b.id ? 0 : driveMin(a.location, b.location); }
    return buildEffectiveMatrix(drive, Object.fromEntries(pts.map((p) => [p.id, p.location])), settings, sgTransitFor(settings));
  });
  const prepared: PreparedDayMatrices = { matrices, rejectedMessages: new Map(), manualOrders: new Map() };
  const t0 = Date.now();
  const res = await solveWithPreparedMatrices(doc, prepared);
  console.log(`\n===== ${label}  (solve ${Date.now() - t0} ms) =====`);
  const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
  res.days.forEach((d: any, i) => {
    console.log(`-- Day ${i + 1} ${doc.days[i].date} status=${d.status}${d.quality ? " quality=" + d.quality : ""}`);
    if (d.status !== "ok") { console.log("   ", d.message ?? JSON.stringify(d).slice(0, 300)); return; }
    const names = Object.fromEntries(doc.days[i].stops.map((s) => [s.id, s.name]));
    d.entries.forEach((e: any, j: number) => {
      const leg = d.legs?.[j - 1];
      const legTxt = leg ? `  <- ${leg.mode} ${Math.round(leg.effectiveMin)}m${leg.mode === "transit" ? " [" + leg.transit.steps.filter((s: any) => s.kind !== "walk").map((s: any) => s.kind === "mrt" ? s.line : s.kind === "bus" ? "bus " + s.service : "chg").join(" > ") + "]" : ""}` : "";
      console.log(`   ${hm(e.arriveMin ?? e.arrive)}→${hm(e.departMin ?? e.depart)}  ${names[e.stopId ?? e.id] ?? JSON.stringify(e).slice(0, 80)}${legTxt}`);
    });
    if (d.baseLegs) console.log(`    leave base ${hm(d.baseLegs.lead?.departMin ?? -1)}, back ${hm(d.baseLegs.ret?.arriveMin ?? d.baseLegs.return?.arriveMin ?? -1)}`);
    if (d.marginNotes?.length) console.log("    notes:", d.marginNotes.map((n: any) => (typeof n === "string" ? n : n.text ?? JSON.stringify(n))).join(" | ").slice(0, 600));
    console.log(`    totalTravel=${Math.round(d.totalTravelMin)}m slack=${Math.round(d.daySlackMin ?? 0)}m`);
  });
  console.log(`conflicts=${res.conflicts.length} proposals=${res.proposals.length}`);
  res.proposals.forEach((p: any) => console.log("   P:", p.kind ?? p.patch?.op ?? "", "-", (p.message ?? p.title ?? JSON.stringify(p.patch)).slice(0, 140)));
  res.conflicts.slice(0, 6).forEach((c: any) => console.log("   C:", c.code ?? c.kind, "-", (c.detail ?? c.message ?? "").slice(0, 160)));
}

(async () => {
  const s = { walkMax: 10, driveOverheadMin: 10 };
  await run("A+hours: same trip, realistic opening hours (ALNS path)", {
    tripId: "probeA", legOverrides: [], settings: s, homeBase: base,
    days: [
      day("2026-11-02", [stop("merlion"), stop("gbtb"), stop("maxwell"), stop("btrt"), stop("gallery"), stop("clarke"), stop("laupasat", "19:00")]),
      day("2026-11-03", [stop("zoo", "09:00"), stop("botanic"), stop("orchard"), stop("tiongbahru"), stop("safari", "19:30")]),
      day("2026-11-04", [stop("uss", "10:00"), stop("sea"), stop("tekka"), stop("mosque"), stop("haji"), stop("jewel")]),
    ],
  });
  const all = Object.keys(P).map((k) => stop(k));
  await run("B: same 18 places, no day markers (pipeline -> ONE day)", {
    tripId: "probeB", legOverrides: [], settings: s, homeBase: base,
    days: [day("2026-11-02", all)],
  });
})();
