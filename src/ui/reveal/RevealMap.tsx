"use client";

// D2.3 M1+M2 — the real reveal map: the custom journal render engine
// (src/lib/map/map-render-core.js) wired into /trip/[id].
//
// M1 (fixed-view v1 per design/map-engine-plan.md):
//   * base layer (geography + labels) painted ONCE per view via buildScene;
//   * the trip overlay (pen route / numbered pins / washi tag) redraws via
//     paintOverlay whenever the visit order changes — the basemap never
//     re-renders on reorder (plan constraint);
//   * pbf/@mapbox/vector-tile/roughjs are npm deps imported HERE, on the
//     reveal route only, and injected with provideLibs.
//
// M2 (road-following pen + motion, Chris-directed 2026-07-06):
//   * progressive geometry: paint the hand-sketch immediately, POST the
//     consecutive stop pairs to /api/route-geometry (AWS Location/GrabMaps
//     behind a server proxy), and when road polylines come back, rebuild the
//     scene once (labels avoid the REAL pen path) and repaint. Every failure
//     (no key, out of coverage, API error) falls back to the sketch — the
//     map never blocks on geometry. data-geometry: pending → roads | sketch.
//   * choreography (design.md §6/§8, Motion driving canvas values): clouds
//     billow and part (~1.1s) → the pen draws the route on (draw-on clip) →
//     each pin pops with a small overshoot as the tip passes it → the washi
//     tape settles last. Reorder replays a short re-sketch. All of it
//     collapses to an instant final frame under prefers-reduced-motion.
//   * pencil-scribble sfx on re-sketch — behind the §2.10 mute toggle
//     (default ON, persisted, never before the user's first gesture).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { animate } from "motion";
import * as MapRenderCore from "@/lib/map/map-render-core";
import { MAP_STYLE_DEFAULTS } from "@/lib/map/map-style-defaults.mjs";

export type RevealStop = {
  id: string;
  name: string;
  lat: number;
  lng: number;
};

type Phase = "sketching" | "ready" | "error";
type LegLine = Array<[number, number]> | null;

const TEXTURE_NAMES = ["land", "water", "park", "weathering"] as const;
const SFX_MUTE_KEY = "tripsoup-sfx-muted";

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function easeInOutCubic(x: number) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
// small overshoot for the pin drop (peaks ~1.1, settles to 1)
function easeOutBack(x: number) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
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
function computeView(stops: RevealStop[], narrow: boolean) {
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

  // Aspect floor (2026-07-07): a compact trip crops letterbox-short, which
  // reads as a tiny map beside a tall sidebar. Grow the N/S window until the
  // crop is at least this tall relative to its width, so the map fills the
  // board column (Chris's "scale not harmonious" note). Near the equator the
  // lat/lon ratio ≈ the projected aspect, so we expand in plain degrees.
  // Portrait-taller on phones (a 0.72 wide-short crop reads as a tiny strip in
  // the stacked mobile column); board-wide on desktop (Phase A responsive).
  const TARGET_ASPECT = narrow ? 1.1 : 0.72; // height / width
  const lonW = VIEW_BBOX.E - VIEW_BBOX.W;
  const latH = VIEW_BBOX.N - VIEW_BBOX.S;
  if (latH / lonW < TARGET_ASPECT) {
    const grow = (TARGET_ASPECT * lonW - latH) / 2;
    VIEW_BBOX.N += grow;
    VIEW_BBOX.S -= grow;
  }

  const lonSpan = VIEW_BBOX.E - VIEW_BBOX.W;
  // cropWpx = lonSpan/360 * 2^Z * TILEPX → solve for Z near the 1150px target
  const Z = Math.max(9, Math.min(14, Math.round(Math.log2((1150 * 360) / (lonSpan * 1024)))));

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
  const cloudsRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<unknown>(null);
  const assetsRef = useRef<{ decoded: unknown; textures: unknown; config: Record<string, unknown> } | null>(null);
  const geomRef = useRef<{ sig: string; legs: LegLine[] } | null>(null);
  const animRef = useRef<{ stop: () => void } | null>(null);
  const cloudAnimRef = useRef<{ stop: () => void } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const gestureRef = useRef(false);
  const firstChoreoDoneRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("sketching");
  const [errMsg, setErrMsg] = useState("");
  const [paints, setPaints] = useState(0);
  const [washiOn, setWashiOn] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [geometryState, setGeometryState] = useState<"pending" | "roads" | "sketch">("pending");
  const [animState, setAnimState] = useState<"idle" | "running" | "done">("idle");
  const [cloudsGone, setCloudsGone] = useState(false);
  const [muted, setMuted] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [cookMs, setCookMs] = useState<number | null>(null); // testing timer: full paste→map total
  const [narrow, setNarrow] = useState(false); // phone-width → taller map crop

  const view = useMemo(() => computeView(stops, narrow), [stops, narrow]);
  const aspect = view.aspect;
  const orderSig = orderedIds.join("|");

  // Bound the module-level decode cache to this reveal's lifetime (review
  // finding: it otherwise accumulates per-view geometry across navigations).
  useEffect(() => () => MapRenderCore.clearDecodeCache(), []);

  // Testing timer: on first ready, report the full paste→map total that
  // usePipeline stamped at submit. Only shows when this reveal came from a
  // fresh cook (a direct /trip/[id] load has no stamp → no badge).
  useEffect(() => {
    if (phase !== "ready" || cookMs !== null) return;
    try {
      const s = Number(sessionStorage.getItem("ts-cook-t0"));
      if (s) {
        const total = (Date.now() - s) / 1000;
        setCookMs(total);
        // eslint-disable-next-line no-console
        console.log(`[tripsoup] paste → map ready in ${total.toFixed(2)}s`);
        sessionStorage.removeItem("ts-cook-t0"); // a reload shouldn't reshow a stale number
      }
    } catch { /* storage off */ }
  }, [phase, cookMs]);

  // §2.10 sound rules: default ON, persisted, never before the first gesture.
  useEffect(() => {
    setMuted(localStorage.getItem(SFX_MUTE_KEY) === "1");
    setReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const nq = window.matchMedia("(max-width: 700px)");
    setNarrow(nq.matches);
    const onNarrow = (e: MediaQueryListEvent) => setNarrow(e.matches);
    nq.addEventListener("change", onNarrow);
    const mark = () => { gestureRef.current = true; };
    window.addEventListener("pointerdown", mark, { once: true, capture: true });
    window.addEventListener("keydown", mark, { once: true, capture: true });
    return () => {
      nq.removeEventListener("change", onNarrow);
      window.removeEventListener("pointerdown", mark, { capture: true } as EventListenerOptions);
      window.removeEventListener("keydown", mark, { capture: true } as EventListenerOptions);
    };
  }, []);

  const toggleMuted = useCallback(() => {
    setMuted((m) => {
      localStorage.setItem(SFX_MUTE_KEY, m ? "0" : "1");
      return !m;
    });
  }, []);

  const playScribble = useCallback(() => {
    if (muted || !gestureRef.current) return;
    if (!audioRef.current) audioRef.current = new Audio("/sfx/pencil-scribble.mp3");
    audioRef.current.currentTime = 0;
    audioRef.current.play().catch(() => { /* autoplay policy — stay silent */ });
  }, [muted]);

  const overlayFor = useCallback(
    (ids: string[]) => {
      const byId = new Map(stops.map((s) => [s.id, s]));
      const routePoints = ids
        .map((id) => byId.get(id))
        .filter((s): s is RevealStop => !!s)
        .map((s) => [s.lng, s.lat] as [number, number]);
      const washiIndex = bookedId ? ids.indexOf(bookedId) : -1; // -1 → engine skips the tape
      const legs = geomRef.current && geomRef.current.sig === ids.join("|") ? geomRef.current.legs : null;
      return { routePoints, washiIndex, legGeometries: legs };
    },
    [stops, bookedId]
  );

  // Paint one overlay frame; setState only when `finalize` (per-frame React
  // re-renders during the 60fps choreography would churn for nothing).
  const paintFrame = useCallback(
    (overlay: Record<string, unknown>, routeProgress: number, pinPop: number[] | null, washiSettle: number, finalize: boolean) => {
      const scene = sceneRef.current;
      const canvas = canvasRef.current;
      if (!scene || !canvas) return;
      const stats = MapRenderCore.paintOverlay(scene, { ...overlay, routeProgress, pinPop, washiSettle });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const maxW = Math.round((wrapRef.current?.clientWidth || 720) * dpr);
      MapRenderCore.renderToDisplay(scene, canvas, maxW);
      if (finalize) {
        setWashiOn(!!stats.washiPlaced);
        setPaints((n) => n + 1);
      }
    },
    []
  );

  // The reveal choreography (design.md §6: one signature transition per
  // surface). "initial": clouds part → pen draws on → pins pop as the tip
  // passes → tape settles. "resketch": a short redraw of the pen only.
  const runChoreo = useCallback(
    async (kind: "initial" | "resketch") => {
      const scene = sceneRef.current;
      if (!scene || !canvasRef.current) return;
      animRef.current?.stop();
      const overlay = overlayFor(orderedIds);

      if (reducedMotion) {
        if (!cloudsGone) setCloudsGone(true);
        paintFrame(overlay, 1, null, 1, true);
        setAnimState("done");
        return;
      }

      setAnimState("running");

      if (kind === "initial" && cloudsRef.current) {
        // clouds billow apart, revealing the paper — DOM-side, ~1.1s
        const el = cloudsRef.current;
        const puffs = Array.from(el.children) as HTMLElement[];
        const cloudAnim = animate(0, 1, {
          duration: 1.1,
          ease: "easeInOut",
          onUpdate: (t) => {
            el.style.opacity = String(1 - easeInOutCubic(clamp01((t - 0.55) / 0.45)));
            puffs.forEach((p, i) => {
              const dir = i === 0 ? -1 : i === 2 ? 1 : 0;
              const drift = easeInOutCubic(t);
              p.style.transform = `translateX(${dir * drift * 130}%) translateY(${(i === 1 ? -1 : 0) * drift * 120}%) scale(${1.15 - drift * 0.1})`;
            });
          },
        });
        cloudAnimRef.current = cloudAnim; // unmount cleanup can stop it (review O6)
        cloudAnim.finished.then(() => setCloudsGone(true)).catch(() => setCloudsGone(true));
      }

      if (kind === "resketch") playScribble();

      const fractions: number[] = kind === "initial"
        ? MapRenderCore.computePinArcFractions(scene, overlay)
        : [];
      const DUR = kind === "initial" ? 2.1 : 0.9;
      const DELAY = kind === "initial" ? 0.5 : 0; // let the clouds part first
      // Pin pops are TIME-driven from the moment the tip passes each pin.
      // Driving them off routeP froze the LAST pin at ~52% scale — routeP
      // saturates at t=0.72 while a fraction-1.0 pin's window could only ever
      // open 0.133 wide — and the finalize frame then snapped it to full
      // (review finding B1). A pop now runs on t for a fixed window from its
      // crossing moment, so the final pin (crossed exactly at t=0.72) still
      // gets 0.28 of t to complete its 0.12-wide pop before the animation ends.
      const POP_WINDOW = 0.12; // in t-space: 0.12 × 2.1s ≈ 0.25s per pop
      const popStarts: Array<number | null> = fractions.map(() => null);

      paintFrame(overlay, 0, kind === "initial" ? orderedIds.map(() => 0) : null, kind === "initial" ? 0 : 1, false);

      const controls = animate(0, 1, {
        duration: DUR,
        delay: DELAY,
        ease: "linear",
        onUpdate: (t) => {
          const routeP = easeInOutCubic(clamp01(kind === "initial" ? t / 0.72 : t));
          let pinPop: number[] | null = null;
          if (kind === "initial") {
            pinPop = fractions.map((f, i) => {
              if (popStarts[i] == null && routeP >= f) popStarts[i] = t;
              const start = popStarts[i];
              return start == null ? 0 : easeOutBack(clamp01((t - start) / POP_WINDOW));
            });
          }
          const settle = kind === "initial" ? easeInOutCubic(clamp01((t - 0.78) / 0.2)) : 1;
          paintFrame(overlay, routeP, pinPop, settle, false);
        },
      });
      animRef.current = controls;
      try {
        await controls.finished;
      } catch {
        return; // superseded by a newer animation — it owns the final frame
      }
      paintFrame(overlay, 1, null, 1, true);
      setAnimState("done");
    },
    [orderedIds, overlayFor, paintFrame, playScribble, reducedMotion, cloudsGone]
  );

  // Build the scene once per view (and on retry). Deliberately NOT re-run on
  // order changes — the choreography/overlay paths handle those.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setPhase("sketching");
        setGeometryState("pending");
        setAnimState("idle");
        setCloudsGone(false);
        firstChoreoDoneRef.current = false;
        geomRef.current = null;

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
        assetsRef.current = { decoded, textures, config };
        setPhase("ready");
      } catch (e) {
        if (!alive) return;
        setErrMsg(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
    return () => {
      alive = false;
      animRef.current?.stop();
      cloudAnimRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- overlayFor/orderedIds only seed the FIRST paint; reorders go through the choreography effect
  }, [view, stops, retryToken]);

  // Choreography driver: full reveal once the scene lands; short re-sketch on
  // order/booked changes afterwards.
  useEffect(() => {
    if (phase !== "ready") return;
    if (!firstChoreoDoneRef.current) {
      firstChoreoDoneRef.current = true;
      void runChoreo("initial");
    } else {
      void runChoreo("resketch");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the visit order + phase; runChoreo identity churn must not replay it
  }, [phase, orderSig, bookedId]);

  // M2 progressive geometry: ask the server proxy for road polylines; on
  // success rebuild the scene ONCE (labels avoid the real pen path) and
  // repaint. Any failure → sketch. Stale responses (order changed while
  // fetching) are discarded.
  useEffect(() => {
    if (phase !== "ready") return;
    const sig = orderSig;
    if (geomRef.current?.sig === sig) return;
    let alive = true;
    (async () => {
      try {
        const byId = new Map(stops.map((s) => [s.id, s]));
        const legs = [];
        for (let i = 0; i < orderedIds.length - 1; i++) {
          const a = byId.get(orderedIds[i]);
          const b = byId.get(orderedIds[i + 1]);
          // unknown id → no geometry to ask for; settle on sketch instead of
          // leaving data-geometry stuck at "pending" (review finding O8)
          if (!a || !b) { setGeometryState("sketch"); return; }
          legs.push({ from: { lat: a.lat, lng: a.lng }, to: { lat: b.lat, lng: b.lng } });
        }
        if (!legs.length) { setGeometryState("sketch"); return; }

        // Staleness is handled by `alive`: this effect re-runs (and its
        // cleanup flips alive=false) whenever orderSig changes, so a response
        // for an old order can never land here.
        const resp = await fetch("/api/route-geometry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ legs }),
        });
        if (!alive) return;
        if (!resp.ok) { setGeometryState("sketch"); return; }
        const data = (await resp.json()) as { legs?: LegLine[] };
        if (!alive) return;
        const lines = Array.isArray(data.legs) ? data.legs : [];
        const hasRoads = lines.some((l) => Array.isArray(l) && l.length >= 2);
        geomRef.current = { sig, legs: lines };
        setGeometryState(hasRoads ? "roads" : "sketch");
        if (!hasRoads) return;

        // rebuild the base once with geometry-aware label collision, then
        // swap in the road-following pen. This may interrupt a draw-on still
        // in flight — the superseded animation's finished-catch cedes the
        // final frame to us, so the swap is clean either way.
        const assets = assetsRef.current;
        if (!assets) return;
        const overlay = overlayFor(orderedIds);
        // assets.config still carries the INITIAL order's ROUTE_POINTS /
        // WASHI_INDEX; mixing those with current-order leg geometry garbles
        // the label-collision seed path (review finding M1) — rebuild with
        // the CURRENT order.
        const rebuildConfig = {
          ...assets.config,
          ROUTE_POINTS: overlay.routePoints,
          WASHI_INDEX: overlay.washiIndex,
        };
        const scene = await MapRenderCore.buildScene(
          rebuildConfig, assets.decoded, assets.textures,
          { legGeometries: lines }
        );
        if (!alive) return;
        animRef.current?.stop();
        sceneRef.current = scene;
        paintFrame(overlay, 1, null, 1, true);
        setAnimState("done");
      } catch {
        if (alive) setGeometryState("sketch");
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on order signature; helpers are stable enough and re-keying on them would refetch for nothing
  }, [phase, orderSig, stops]);

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

  const cloudPuff = (left: string, top: string, size: string): CSSProperties => ({
    position: "absolute",
    left,
    top,
    width: size,
    height: size,
    borderRadius: "50%",
    background: "var(--paper)",
    filter: "blur(18px)",
    opacity: 0.96,
  });

  return (
    <div
      ref={wrapRef}
      data-testid="reveal-map"
      data-phase={phase}
      data-paints={paints}
      data-order={orderedIds.join("|")}
      data-washi={washiOn ? "1" : "0"}
      data-geometry={geometryState}
      data-anim={animState}
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
              // Phase A seam fix (2026-07-08): no radius/shadow frame, and a soft
              // edge-feather so the painted map dissolves into var(--paper) with
              // no rectangular boundary — it reads as a hand-drawn map on the page,
              // not a framed tile (Chris's "background doesn't match art → jarring
              // outline" note). Two axis gradients intersected = a 22px feather on
              // all four edges; content stays clear of it (computeView pads the crop).
              maskImage:
                "linear-gradient(to right, transparent, #000 22px, #000 calc(100% - 22px), transparent), linear-gradient(to bottom, transparent, #000 22px, #000 calc(100% - 22px), transparent)",
              maskComposite: "intersect",
              WebkitMaskImage:
                "linear-gradient(to right, transparent, #000 22px, #000 calc(100% - 22px), transparent), linear-gradient(to bottom, transparent, #000 22px, #000 calc(100% - 22px), transparent)",
              WebkitMaskComposite: "source-in",
            }}
          />
          {phase === "ready" && !reducedMotion && !cloudsGone && (
            <div
              ref={cloudsRef}
              aria-hidden
              data-testid="reveal-clouds"
              style={{
                position: "absolute",
                inset: 0,
                overflow: "hidden",
                pointerEvents: "none",
              }}
            >
              <div style={cloudPuff("-12%", "8%", "68%")} />
              <div style={cloudPuff("28%", "-14%", "76%")} />
              <div style={cloudPuff("58%", "16%", "70%")} />
            </div>
          )}
          {phase === "ready" && cookMs != null && (
            <div
              data-testid="reveal-timer"
              style={{
                position: "absolute",
                top: 10,
                left: 10,
                fontFamily: "var(--font-display)",
                fontSize: 13,
                color: "var(--ink-soft)",
                background: "var(--paper)",
                border: "1px solid var(--ink-soft)",
                borderRadius: 4,
                padding: "2px 8px",
                opacity: 0.9,
              }}
            >
              ready in {cookMs.toFixed(1)}s
            </div>
          )}
          {phase === "ready" && (
            <button
              type="button"
              data-testid="reveal-sfx-toggle"
              onClick={toggleMuted}
              style={{
                position: "absolute",
                top: 10,
                right: 10,
                fontFamily: "var(--font-display)",
                fontSize: 14,
                color: "var(--ink)",
                background: "var(--paper)",
                border: "1px solid var(--ink-soft)",
                borderRadius: 4,
                padding: "2px 10px",
                cursor: "pointer",
                opacity: 0.9,
              }}
            >
              {muted ? "sound: off" : "sound: on"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
