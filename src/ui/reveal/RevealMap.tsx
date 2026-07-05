"use client";

// D2.3 M1 — the real reveal map: the custom journal render engine
// (src/lib/map/map-render-core.js, proven in the design bench) wired into
// /trip/[id]. Fixed-view v1 per design/map-engine-plan.md:
//   * base layer (geography + labels) painted ONCE per view via buildScene;
//   * the trip overlay (pen route / numbered pins / washi tag) redraws via
//     paintOverlay whenever the visit order changes — the basemap never
//     re-renders on reorder (plan constraint);
//   * pbf/@mapbox/vector-tile/roughjs are npm deps lazy-imported HERE, on the
//     reveal route only, and injected with provideLibs — the engine's CDN
//     fallback never runs in the product, and the landing bundle is untouched.
//
// Art values come from MAP_STYLE_DEFAULTS (src/lib/map/map-style-defaults.mjs
// — the M0.5 lock target). The hand font is resolved from next/font's
// --font-display variable so canvas lettering uses the REAL loaded family
// (next/font renames it), falling back to plain 'Gochi Hand'.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as MapRenderCore from "@/lib/map/map-render-core";
import { MAP_STYLE_DEFAULTS } from "@/lib/map/map-style-defaults.mjs";

export type RevealStop = {
  id: string;
  name: string;
  lat: number;
  lng: number;
};

type Phase = "sketching" | "ready" | "error";

const TEXTURE_NAMES = ["land", "water", "park", "weathering"] as const;

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Unit-world Mercator y (0..1) — the canvas crop is Mercator-projected, so
// the placeholder aspect must be too (raw Δlat/Δlon drifts at high latitudes
// and causes a sketching→canvas layout shift).
function mercY(lat: number) {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}

// Fixed-view derivation: pad the stop bbox, then pick the zoom whose crop
// lands near the reference width (~1150px at REF_TILEPX 1024 = the resolution
// the art was tuned at, so K≈1 and proportions match the studio exactly).
function computeView(stops: RevealStop[]) {
  let W = Infinity, E = -Infinity, S = Infinity, N = -Infinity;
  for (const s of stops) {
    W = Math.min(W, s.lng); E = Math.max(E, s.lng);
    S = Math.min(S, s.lat); N = Math.max(N, s.lat);
  }
  const MIN_SPAN = 0.02; // single-stop / tight trips still get a real map view
  if (E - W < MIN_SPAN) { const c = (E + W) / 2; W = c - MIN_SPAN / 2; E = c + MIN_SPAN / 2; }
  if (N - S < MIN_SPAN) { const c = (N + S) / 2; S = c - MIN_SPAN / 2; N = c + MIN_SPAN / 2; }
  const padX = (E - W) * 0.18;
  const padY = (N - S) * 0.22; // extra vertical room: the washi tag hangs below its pin
  const VIEW_BBOX = { W: W - padX, E: E + padX, N: N + padY, S: S - padY };

  const lonSpan = VIEW_BBOX.E - VIEW_BBOX.W;
  // cropWpx = lonSpan/360 * 2^Z * TILEPX → solve for Z near the 1150px target
  const Z = clamp(Math.round(Math.log2((1150 * 360) / (lonSpan * 1024))), 9, 14);

  // fetch footprint: wider than the crop so geometry bleeds past the frame
  // (snaps outward to whole tiles inside the engine anyway)
  const fx = lonSpan * 0.3, fy = (VIEW_BBOX.N - VIEW_BBOX.S) * 0.3;
  const BBOX = { W: VIEW_BBOX.W - fx, E: VIEW_BBOX.E + fx, N: VIEW_BBOX.N + fy, S: VIEW_BBOX.S - fy };

  // height/width of the crop in projected space — matches the painted canvas
  const aspect = (mercY(VIEW_BBOX.S) - mercY(VIEW_BBOX.N)) / (lonSpan / 360);

  return { Z, SCALE: 4, BBOX, VIEW_BBOX, aspect };
}

function resolveHandFamily(): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-display")
    .trim();
  return v || "'Gochi Hand'";
}

export function RevealMap({
  stops,
  orderedIds,
  bookedId,
}: {
  stops: RevealStop[];
  orderedIds: string[];
  bookedId?: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<unknown>(null);
  const [phase, setPhase] = useState<Phase>("sketching");
  const [errMsg, setErrMsg] = useState("");
  const [paints, setPaints] = useState(0);
  const [washiOn, setWashiOn] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  const view = useMemo(() => computeView(stops), [stops]);
  const aspect = view.aspect;

  // Bound the module-level decode cache to this reveal's lifetime (review
  // finding: it otherwise accumulates per-view geometry across navigations).
  useEffect(() => () => MapRenderCore.clearDecodeCache(), []);

  const overlayFor = useCallback(
    (ids: string[]) => {
      const byId = new Map(stops.map((s) => [s.id, s]));
      const routePoints = ids
        .map((id) => byId.get(id))
        .filter((s): s is RevealStop => !!s)
        .map((s) => [s.lng, s.lat] as [number, number]);
      const washiIndex = bookedId ? ids.indexOf(bookedId) : -1; // -1 → engine skips the tape
      return { routePoints, washiIndex };
    },
    [stops, bookedId]
  );

  const paint = useCallback(() => {
    const scene = sceneRef.current;
    const canvas = canvasRef.current;
    if (!scene || !canvas) return;
    const overlay = overlayFor(orderedIds);
    const stats = MapRenderCore.paintOverlay(scene, overlay);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const maxW = Math.round((wrapRef.current?.clientWidth || 720) * dpr);
    MapRenderCore.renderToDisplay(scene, canvas, maxW);
    setWashiOn(!!stats.washiPlaced);
    setPaints((n) => n + 1);
  }, [orderedIds, overlayFor]);

  // Build the scene once per view (and on retry). Deliberately NOT re-run on
  // order changes — the overlay effect below handles those on the snapshot.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setPhase("sketching");
        const [pbfMod, vtMod, roughMod] = await Promise.all([
          import("pbf"),
          import("@mapbox/vector-tile"),
          import("roughjs"),
        ]);
        MapRenderCore.provideLibs({
          Pbf: (pbfMod as { default: unknown }).default ?? pbfMod,
          VectorTile: (vtMod as { VectorTile: unknown }).VectorTile,
          rough: (roughMod as { default: unknown }).default ?? roughMod,
        });

        const overlay = overlayFor(orderedIds);
        const config = {
          ...MAP_STYLE_DEFAULTS,
          FONT_FAMILY_HAND: resolveHandFamily(),
          ...view,
          // initial order seeds label collision; overlay redraws use paintOverlay
          ROUTE_POINTS: overlay.routePoints,
          WASHI_INDEX: overlay.washiIndex,
        };

        const [decoded, textures] = await Promise.all([
          MapRenderCore.fetchAndDecode(config),
          Promise.all(
            TEXTURE_NAMES.map((t) => MapRenderCore.loadImage(`/map/assets/tex/${t}.png`))
          ).then(([land, water, park, weathering]) => ({ land, water, park, weathering })),
        ]);
        if (!alive) return;

        const scene = await MapRenderCore.buildScene(config, decoded, textures);
        if (!alive) return;
        sceneRef.current = scene;
        setPhase("ready");
      } catch (e) {
        if (!alive) return;
        setErrMsg(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- overlayFor/orderedIds only seed the FIRST paint; reorders go through the overlay effect
  }, [view, stops, retryToken]);

  // Overlay redraw path: order/booked changes + first paint after the scene lands.
  useEffect(() => {
    if (phase === "ready") paint();
  }, [phase, paint]);

  // Re-blit on container resize (cheap: crop → display only).
  useEffect(() => {
    if (!wrapRef.current) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        const scene = sceneRef.current;
        const canvas = canvasRef.current;
        if (!scene || !canvas || phase !== "ready") return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const maxW = Math.round((wrapRef.current?.clientWidth || 720) * dpr);
        MapRenderCore.renderToDisplay(scene, canvas, maxW);
      }, 120);
    });
    ro.observe(wrapRef.current);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [phase]);

  return (
    <div
      ref={wrapRef}
      data-testid="reveal-map"
      data-phase={phase}
      data-paints={paints}
      data-order={orderedIds.join("|")}
      data-washi={washiOn ? "1" : "0"}
      style={{ width: "100%" }}
    >
      {phase === "error" ? (
        <div
          style={{
            background: "var(--paper-shade)",
            border: "1px solid var(--ink-soft)",
            borderRadius: 4,
            padding: "20px 24px",
          }}
        >
          <p style={{ fontFamily: "var(--font-body)", color: "var(--ink)", margin: 0 }}>
            The map didn&rsquo;t make it onto the page — {errMsg || "the tiles wouldn't load"}.
          </p>
          <button
            type="button"
            data-testid="reveal-map-retry"
            onClick={() => setRetryToken((n) => n + 1)}
            style={{
              marginTop: 12,
              fontFamily: "var(--font-body)",
              background: "var(--action)",
              color: "var(--paper)",
              border: "none",
              borderRadius: 4,
              padding: "8px 16px",
              cursor: "pointer",
            }}
          >
            Sketch it again
          </button>
        </div>
      ) : (
        <div style={{ position: "relative", width: "100%", aspectRatio: `${1 / aspect}` }}>
          {phase === "sketching" && (
            <p
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                margin: 0,
                fontFamily: "var(--font-display)",
                color: "var(--ink-soft)",
                background: "var(--paper-shade)",
                borderRadius: 4,
              }}
            >
              Sketching your map…
            </p>
          )}
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`Hand-drawn map of your route with ${stops.length} stops`}
            style={{
              display: phase === "ready" ? "block" : "none",
              width: "100%",
              height: "auto",
              borderRadius: 4,
              boxShadow: "0 1px 2px rgba(43,38,32,.12), 0 4px 12px rgba(43,38,32,.06)",
            }}
          />
        </div>
      )}
    </div>
  );
}
