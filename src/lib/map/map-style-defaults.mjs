// map-style-defaults.mjs — THE single source of the journal map's ART values.
// This is the M0.5 lock target: Chris tunes in Map Studio (design/map-engine/
// map-studio.mjs), clicks Copy CONFIG, and the STYLE fields of that export
// land here (view fields — Z/SCALE/BBOX/VIEW_BBOX/ROUTE_POINTS/WASHI_INDEX —
// stay with each caller: the bench keeps its JB sample view; the app computes
// a view per trip). Old-shape exports migrate via upgradeConfig() in
// map-render-core.js, so a paste from an earlier studio build is fine.
//
// Consumed by: src/ui/reveal/RevealMap.tsx (the product reveal),
// design/map-engine/render-engine.mjs (screenshot harness),
// design/map-engine/map-studio.mjs (live tuning tool).
//
// Pure data, ESM, no imports — safe for Next bundling AND raw node/browser.
// Every px value is authored at REF_TILEPX (the engine scales by
// K = TILEPX/REF_TILEPX at paint, so proportions are resolution-invariant).
//
// LOCK HISTORY:
//   * 2026-07-06 pass 1 — Chris's pre-fidelity Copy-CONFIG: slider-backed
//     deltas adopted; stale old-build internals rejected.
//   * 2026-07-06 pass 2 — Chris's NEW-shape studio export after tuning the
//     fidelity-pass dials (Pins / Washi pattern / Crowding). Applied verbatim
//     with two token divergences flagged (salmon tape, vivid pen).
//   * 2026-07-06 pass 3 (LOCKED — M0.5 art gate) — Chris resolved both flags
//     in the studio: booked tape back to YELLOW as brightened #ffdf6b (§3
//     lighter-shade derivation of --washi), pattern plain; vivid MAP pen
//     #2e79ea confirmed (UI token --route-blue unchanged — design.md §3
//     notes the split). Weathering + vignette at 0 are his deliberate zeros.

export const MAP_STYLE_DEFAULTS = {
  EXTENT_FALLBACK: 4096, // MVT extent fallback if layer.extent is missing
  TILE: 256, // base slippy-tile size (px)
  REF_TILEPX: 1024, // the resolution (TILE*SCALE) every px value below is authored at
  MAX_SCREENSHOT_W: 1600, // display cap; callers may pass a tighter cap to renderToDisplay
  FILL_RULE: "nonzero", // MVT spec winding -> nonzero is spec-correct for clip()
  STROKE_SEED: 7, // per-feature Rough.js seeds derive from this (deterministic repaints)

  TEXTURE_SCALE: 0.51,

  COLORS: {
    ink: "#2B2620",
    paperHalo: "#F6F1E7",
    coastStroke: "#6f8a86",
    waterNameText: "#5E7F86",
    roadMajor: "#967240",
    roadSecondary: "#b2a483",
    roadMinor: "#c9bda1", // 2026-07-07: the residential/minor grid — a lighter,
    // recessive tan so the dense street network reads as texture under the pen
    // (board-faithful density), never competing with the arterials or the route.
    routeLine: "#2e79ea", // LOCKED (Chris, pass 3, 2026-07-06): the MAP pen is this
    // vivid blue; the UI token --route-blue stays #3E6C8E (design.md §3 notes the split).
    pinFill: "#F6F1E7",
    pinStroke: "#2B2620",
    washiFill: "#ffdf6b", // LOCKED (Chris, pass 3): brightened yellow variant of
    // --washi #F4C95D (§3 lighter-shade derivation) — booked stays yellow everywhere.
    washiShade: "rgba(120,90,20,0.30)", // tear shading on the torn ENDS (never a full outline)
    washiSheen: "rgba(255,255,255,0.20)", // gated by WASHI.sheenAlpha (0 = matte, board-faithful)
    washiPatternTint: "#FFFFFF", // gingham/stripes bar tint over the tape fill
    vignetteEdge: "rgba(74,58,38,0)", // Chris pass 2 — vignette OFF (alpha 0)
  },
  WIDTHS: {
    coast: 0.9,
    waterway: 1.2,
    roadMajor: 2,
    roadSecondary: 1.6,
    roadMinor: 0.9, // thin residential ink
    washiStroke: 1.1, // width of the tear shading stroke on the tape's torn ends
  },
  ROUGHNESS: { coast: 1.4, road: 1.2, route: 1.6 },
  BOWING: { coast: 1, route: 2 },
  ALPHA: { park: 0.47, weathering: 0 }, // Chris pass 2 — weathering OFF (clean paper;
  // note: §3's "weathered warm-paper world" descriptor — flagged at the lock vet)

  ROUTE_WIDTH: 3.4,
  ROUTE_BLEED_EXTRA: 2.1, // Chris pass 2 (was 2.8)
  ROUTE_BLEED_ALPHA: 0.37,

  PIN: {
    // Phase C: pin marker style. 'ring' (fine ink ring) |
    // 'tack' (colour-coded push-pin, number on the head) |
    // 'washi' (small torn washi scrap, circled number).
    style: "tack", // LOCKED (Chris, Phase C): colour-coded push-pins
    diameter: 21, // Chris pass 2 (was 26) — even finer rings ('ring' style)
    strokeWidth: 1.2, // Chris pass 2 (was 1.7)
    numFontSize: 18, // Chris pass 2 (was 13) — bold digits in fine rings
    declutter: true, // overlapping pins push apart (ink leader + dot at the true spot)
    declutterGap: 4,
    leaderDot: 2.4,
    tackDiameter: 34, // head/scrap size for 'tack'/'washi' (Chris: the fine rings were too small to see)
    // colour-coded per stop, cycling the washi tones from design.md §3 (--washi-coral/sky/pink/leaf/--washi)
    palette: ["#F0907A", "#7FB8D8", "#E88BA5", "#A3C48B", "#F4C95D"],
  },

  WASHI: {
    h: 30,
    padX: 12, // tape width follows its lettering ("④ Booked") + this padding
    minW: 90,
    maxW: 240,
    fontSize: 15,
    alpha: 0.7,
    angleDeg: -4, // Chris pass 2 (was -3)
    tearSegs: 20, // Chris pass 2 (was 12) — fine serration…
    tearAmp: 1.7, // Chris pass 2 (was 3.2) — …subtle rip depth
    tearFine: 1.5, // Chris pass 2 (was 1.1)
    seed: 20260705,
    pattern: "plain", // LOCKED (Chris, pass 3): plain yellow tape, like the board
    patternAlpha: 0.39, // (pattern dial kept for the studio; inert while plain)
    sheenAlpha: 0, // matte
    offset: 0.72, // tape center distance from its pin, in tape-heights
  },

  WATER_LABEL: {
    fontStyle: "italic",
    // fontFamily deliberately omitted — upgradeConfig() inherits it from
    // FONT_FAMILY_HAND, which the app overrides with next/font's real family.
    fontBase: 24,
    fontMin: 11, // Chris pass 2 (was 15)
    fontMax: 16, // Chris pass 2 (was 20) — whisper-quiet channel lettering
    fillFrac: 0.45, // Chris pass 2 (was 0.62) — compact along the spine
    cloudRadiusFrac: 0.09, // local-water-body-only spine radius
    minCloud: 40,
    buckets: 12,
    trim: 0.1,
    smoothPasses: 2,
    letterSpacing: 2, // Chris pass 2 (was 3)
    haloWidth: 4,
    glyphSkipMargin: 4,
  },
  POINT_LABEL: {
    fontSize: 15,
    haloPad: 3,
    haloWidth: 2,
    nudges: [
      [0, 0], [0, -1], [0, 1], [-1, 0], [1, 0],
      [-1, -1], [1, -1], [-1, 1], [1, 1], [0, -2], [0, 2],
      [-2, 0], [2, 0], [-2, -1], [2, 1], [0, -3], [0, 3], [-3, 0], [3, 0], [-2, 1], [2, -1],
      // extended ladder: small fonts need longer jumps to clear the route
      // corridor (nudge distance scales with font size)
    ],
    nudgeStep: 0.9,
    pinPad: 4,
    maxLabels: 10, // Chris pass 2 (was 8)
    twoLineMaxW: 170, // longer names wrap to two lines (board's mosque label)
    shrinkFloor: 1, // Chris pass 2 (was 0.8) — labels never shrink; they drop instead
    edgeMargin: 15, // Chris pass 2 (was 10) — wider quiet zone at the frame
    routePad: 3, // labels keep clear of the route pen line
  },

  FONT_FAMILY_HAND: "'Gochi Hand'", // ALL map lettering — design.md §2.4 (app overrides with next/font's family)

  ROAD_CLASSES_MAJOR: ["motorway", "trunk", "primary"],
  ROAD_CLASSES_SECONDARY: ["secondary", "tertiary"],
  ROAD_CLASSES_MINOR: ["minor", "service"], // 2026-07-07: residential grid so the
  // road-following pen sits on a drawn street network (Chris's "denser roads" call)
  PARK_LANDCOVER_CLASSES: ["wood", "grass", "meadow"],
  PLACE_CLASSES: ["city", "town"],
};
