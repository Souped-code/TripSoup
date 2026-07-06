# TripSoup — design.md (the law)

_Root-level design contract. Every session writing UI code MUST read this file first and
load the `taste-skill:taste-skill` (or `redesign-skill` for restyles) + `ui-ux-pro-max:design`
skills before writing a line of markup. Where this file and either skill disagree, **this
file wins.** Part of the approved production plan
(`~/.claude/plans/i-want-you-to-starry-wave.md` — outside the repo, in the machine's
Claude config — phase D1)._

**Status note (2026-07-04, updated same day):** the D1.1 reference boards exist
(`design/refs/`) and Chris locked the palette and type pair from them — §3 and §4 are now
law, not proposals. The Gracie style pick and sprite pipeline (D1.3) are in progress;
anywhere this doc depends on an asset that does not exist yet, it says so and names the
fallback.

---

## 1. Identity

**Product:** TripSoup — paste a messy group itinerary, get an optimized day plan you can
share and run a trip from.

**Mascot: Gracie** (identity refined by Chris 2026-07-04) — a friendly **girl-next-door**
teen who genuinely enjoys planning itineraries, and is an **amateur home cook as a
hobby** — NOT a uniformed chef. Casual everyday clothes; cooking props (pot, spoon, apron)
appear only in cooking scenes as hobby gear, not as a costume. She takes the chaos of
pasted links and cooks it into a route. She is not a corporate assistant character; she's
a capable friend having a good time doing something she's genuinely good at.

**Art style (LOCKED by Chris 2026-07-04): thin-line journal doodle** — a single
consistent thin, slightly wobbly fineliner ink line (`--ink`), airy white space inside
shapes, loose spot-color fills only, natural cute proportions (~4.5 heads). Her spot
colors follow the brand palette: warm `--soup` orange as her signature accent, cream,
warm hair tones, occasional washi-yellow touches — green is the UI's functional accent,
not her wardrobe. Ground truth: `design/gracie/reference.png`; the animatable proof is
`design/gracie/stir-drafts/stir-C-thinline-doodle.mp4`.

**Voice:** warm, playful, competent. Talks like a friend who is good at planning, not a
SaaS product or a customer-support bot. Never exclamation-mark-spammy, never cutesy at the
expense of clarity, never corporate ("Let's get started!", "Oops! Something went wrong!").

- Good: "Two of your links didn't resolve — here's why." / "Your route's ready. Sidebar's
  on the right."
- Bad: "Oops! We couldn't process that! 😅" / "Great choice! Let's optimize your amazing trip!"

**Why paper-and-ink, not an app:** the product's whole premise is turning chaos (a pasted
wall of links) into order (a clean plan) — a journal/notebook is the natural physical
metaphor, and it's about as far from "generic AI SaaS dashboard" as a travel tool can get.

---

## 2. Anti-generic law (violations = rejected PR, no exceptions)

This list exists because AI-assisted frontend work reaches for the same dozen tells by
default. Enforcement is mechanical — if a PR does one of these, it does not ship, full stop.

1. **No purple/violet/indigo gradients.** No gradient hero text. No `bg-gradient-to-r`
   anywhere. TripSoup has exactly one functional accent (`--action` green) and one brand
   color (`--soup` orange, illustration/identity only) — both applied as flat fills,
   never gradients.
2. **No glassmorphism, no neumorphism, no floating 3D blobs, no sparkle emoji ✨** in UI
   copy or decoration.
3. **No dark-mode-first slabs with neon accents.** TripSoup is a daylight paper product.
   (A genuine dark-mode pass may come later as an explicit, separately-designed mode — not
   as the default aesthetic.)
4. **No Inter, no Geist, no system-ui default type anywhere.** No `text-transparent
   bg-clip-text`. See §4 for the actual type stack.
5. **No centered-hero + three-feature-cards + testimonial-carousel landing formula.** The
   landing page IS the product — the greeting and the paste box, full stop. No marketing
   theater bolted in front of it.
6. **No stock Heroicons/Lucide used raw.** Icons are hand-drawn-style: a consistent
   1.5px, slightly wobbly stroke, sourced from a hand-drawn icon set or authored as SVG in
   the journal style. (No icon set is committed yet — see §7 status. Nothing in D1 needs
   one; the first real icon need arrives in D2's UI work, and it must follow this rule,
   not fall back to a stock set out of convenience.)
7. **No uniform 8px-grid sterile spacing.** Spacing is generous and slightly asymmetric,
   editorial rather than app-grid.
8. **No default Tailwind `blue-500`-style buttons.** Buttons read as ink-stamped or
   pencil-outlined paper elements; the pressed state visibly "stamps" (see §5).
9. **Motion moves like paper and pen** — slide/settle/wobble spring motion, 250–400ms.
   Never the generic AI default of fade+scale-from-95% on every single element. One
   signature transition per surface, not motion sprayed everywhere.
10. **Sound is opt-out, never forced.** Pencil-scribble sfx on reorder, a soft pot-bubble
    on optimize-complete. Always behind a mute toggle, default ON, persisted in
    `localStorage`, and never played before the user's first interaction (browser autoplay
    policy blocks this anyway, so this is also just correct engineering).

---

## 3. Palette (LOCKED by Chris, 2026-07-04, after D1.1 board comparison)

Paper and ink, not white and gray — the weathered, map-like warm paper world from the
accepted reveal board, with **green as the single functional accent** (Chris: soothing
green buttons + weathered orange-variant map + vibrant fun washi tape + yellow booked
highlight). Every color below is a CSS custom property in `app/globals.css`; nothing is a
hard-coded hex in component code.

**The system (60-30-10 + semantic separation):**
- **60% — canvas:** `--paper` everywhere, including the map's land tone. Warm, restful,
  weathered — the whole product sits on this.
- **30% — structure:** `--paper-shade` surfaces, `--ink`/`--ink-soft` text and hairlines,
  the torn-journal sidebar, ruled lines, map roads in thinned ink tones.
- **10% — functional accent:** `--action` green, reserved EXCLUSIVELY for "take action
  here": primary CTAs, active/selected/focus states, progress fill, success confirmation.
  If everything is green, nothing is — scarcity is what makes it work.
- **Brand ≠ functional (micro-accents, outside the 10% budget):** `--soup` orange is the
  BRAND color — logo, Gracie, illustration, the soup itself, large display flourishes —
  and is **never** a button, link, or state color. `--route-blue` belongs to the map pen.
  Washi tapes are decorative identity. `--danger` is the one red and means only errors.

| Token | Value | Role |
|---|---|---|
| `--paper` | `#F6F1E7` | 60% canvas — warm cream, never pure white; also map land |
| `--paper-shade` | `#EAE2D3` | 30% structure — recessed surfaces, cards, input fills |
| `--ink` | `#2B2620` | Primary text — warm near-black, **never** `#000` |
| `--ink-soft` | `#6B6155` | Secondary text, captions, muted labels |
| `--action` | `#3F6B4C` | **The** functional accent — soothing pine green. CTAs, active/focus/selected, progress, success. The accessible version of the board's green, darkened per the shadow rule below |
| `--soup` | `#E0662E` | Brand orange — logo, Gracie, illustration, large display accents ONLY. Never actions |
| `--route-blue` | `#3E6C8E` | Fountain-pen blue — UI "drawn" elements. **Map-pen split (Chris, 2026-07-06 M0.5 lock):** the render engine's route pen is the vivid `#2e79ea` (`COLORS.routeLine` in `src/lib/map/map-style-defaults.mjs`); this UI token is unchanged (the vivid fails 4.5:1 for text) |
| `--washi` | `#F4C95D` | Booked/anchor highlight — the yellow tape from the accepted board. The map's booked tag renders the brightened variant `#ffdf6b` (Chris, 2026-07-06 — §3 lighter-shade derivation; booked stays yellow on every surface) |
| `--washi-coral` | `#F0907A` | Fun tape (decorative: drag handles, itinerary row tabs) |
| `--washi-sky` | `#7FB8D8` | Fun tape (decorative) |
| `--washi-pink` | `#E88BA5` | Fun tape (decorative) |
| `--washi-leaf` | `#A3C48B` | Fun tape (decorative) |
| `--danger` | `#C0392B` | Infeasibility / error states (warm red, not a cold system red) |

**Harmony:** the canvas is a warm analogous family (cream → tan → orange → yellow); the
green accent sits near-complementary to the brand orange, which is exactly why CTAs pop
without shouting. Water/route blues stay desaturated and recessive.

**Deriving new shades (do not invent new hues):** darker variant = lower brightness AND
raise saturation; lighter variant = raise brightness AND lower saturation (shadows in the
real world are darker *and* richer — this is how `--action` was derived from the board's
`#4A7C59`). Hover/pressed states come from this rule applied to an existing token, never
from a new color.

**Contrast (WCAG AA, every pair computed, 2026-07-04):**
- `--ink` on `--paper` **13.3:1** (AAA), on `--paper-shade` 12.1:1 — body text safe everywhere.
- `--ink-soft` on `--paper` 5.38:1, on `--paper-shade` 4.71:1 — passes 4.5:1 on both.
- `--action` on `--paper` **5.46:1**, on `--paper-shade` **4.77:1**, `--paper` text on
  `--action` fill **5.46:1** — the green passes body-text AA at any size on every surface;
  no large-text workaround needed (the board's original `#4A7C59` failed on cards at
  4.31:1, which is why the token is the darkened version).
- `--soup` on `--paper` **3.05:1** — legal ONLY for large text (≥18px / bold ≥14px) and
  non-text (icons, borders, illustration); never small body text. Since orange is now
  brand-only, this constraint is easy to keep.
- `--route-blue` on `--paper` 4.99:1; `--danger` on `--paper` 4.83:1 — both pass 4.5:1.
- `--ink` text on tapes: `--washi` 9.54:1, `--washi-coral` 6.41:1, `--washi-sky` 6.96:1,
  `--washi-pink` 6.19:1, `--washi-leaf` 7.73:1 — labels on tape always pass. Tapes
  against paper sit at 1.4–2.2:1, so tape is **decorative** — never the only indicator of
  state (booked = tape + checkmark + text, drag handle = tape + position affordance).

---

## 4. Typography

- **Display (headings only):** a handwriting-adjacent face — **Gochi Hand**, self-hosted
  via `next/font/google`. Used for h1/h2 and Gracie's speech-bubble copy only; never for
  body text or anything that needs to be read quickly and precisely (times, addresses,
  form labels).
- **Body:** **Nunito Sans**, self-hosted via `next/font/google`. Warm humanist sans for
  everything else — paragraphs, labels, times, buttons, the whole trip board.
- **Never:** Inter, Geist, system-ui/-apple-system stacks as the primary faces. (System
  fonts may appear transiently as a loading fallback only, per `next/font`'s default
  behavior, and are swapped the instant the real font loads.)

Font choice from the plan's candidate list (Gochi Hand / Caveat / Patrick Hand) —
Gochi Hand picked for legibility at small sizes in the sidebar's handwritten-style itinerary
list, where Caveat's connected script and Patrick Hand's heavier stroke both hurt
readability at 14–16px. **Confirmed by Chris 2026-07-04** after seeing the D1.1 reference
boards ("the choice of font is good, keep it") — the pair is fully locked in §9.

---

## 5. Shape, shadow, texture

- **Radii:** 2–6px, with a slightly irregular border rather than a mathematically uniform
  rounded rect — achieved with a subtle SVG rough-edge filter or a border-image, not a
  bigger `border-radius` number. Nothing in the product uses the generic "everything is
  `rounded-xl`" look.
- **Shadows:** paper-lift only — `0 1px 2px rgba(43,38,32,.12), 0 4px 12px rgba(43,38,32,.06)`.
  No glow, no colored shadows, no shadow tinted to `--soup`.
- **Texture:** a subtle paper-grain SVG noise overlay on backgrounds, opacity ≤ 0.04 —
  applied as a fixed, `pointer-events-none` pseudo-element (never on a scrolling
  container — repainting noise on scroll kills mobile framerate). The sidebar additionally
  gets a faint ruled/dotted journal-page texture.
- **Buttons:** read as ink-stamped or pencil-outlined paper elements. Primary buttons:
  `--action` green fill, `--paper`-colored text (5.46:1 — passes AA at any size), a
  hand-drawn irregular border. Pressed state: `translateY(1px)` + the paper-lift shadow
  collapses to nothing — a physical "stamp down" motion, not a generic
  `:active { opacity: 0.8 }`.

---

## 6. Motion and sound

- Springs, 250–400ms, honest physical settling — not linear eases, not the generic AI
  fade+scale-95%-on-everything default.
- One signature transition per surface (defined per-surface in §8), not motion sprinkled
  onto every element that moves.
- `prefers-reduced-motion` is honored everywhere: every animation degrades to an instant
  state change or a plain crossfade. This includes Gracie's sprite cycling (falls back to
  a single static pose) and the cloud transition (falls back to an instant crossfade).
- Sound effects (pencil scribble on reorder, soft pot-bubble on optimize-complete): opt-out
  toggle, default ON, persisted in `localStorage`, never autoplayed before a user gesture.

---

## 7. Gracie asset pipeline — status

**Not yet produced.** D1.3 (reference sheet + four sprite scenes: pin-throw, route-scribble,
"this is fine," soup-pot) is blocked on the Higgsfield image-gen MCP tool, which
disconnected mid-session and has not reconnected. Chris's explicit call (2026-07-04): wait
for reconnection rather than substitute a different pipeline or ship placeholder art.

**Documented fallback if generation still can't happen when this is revisited:** per the
plan, ship Gracie as 4 static hand-authored poses with CSS motion (bob, arm-swing via
`transform-origin` layering) rather than stalling the whole phase — "charming beats janky."
That decision, if taken, gets logged in `STATE.md`, not silently substituted here.

**What this means for D1 right now:** everything in this document that does NOT depend on
Gracie's actual artwork (palette, type, shape/shadow/texture rules, the anti-generic law,
the token implementation, the five base components in `src/ui/journal/`) is real and
buildable today. The per-surface direction below describes where Gracie appears
compositionally; it does not require her final art to exist to build the surrounding UI.

---

## 8. Per-surface direction

### Greeting (`/`)
A paper desk scene. Gracie waves. One big journal-page textarea: "Paste your trip — links,
notes, chaos welcome." A time-of-day greeting ("Good evening!") above it. Nothing else
above the fold except a small pencil-note "how it works" — no feature grid, no trust
strip, no secondary CTA competing with the paste box. The paste box **is** the hero.

**Signature transition:** the textarea has a soft focus-in wobble (border settles into
place) — nothing else animates on load.

### Loading (during D2's pipeline)
Progress reads as a soup pot filling or a route line being drawn — never a generic
percentage bar or spinner. Gracie's sprite cycles through her four scenes in step with
real backend progress (parse → resolve → matrix → solve, per D2.4's stage weights) — never
a fake/looping animation disconnected from actual work. On failure: Gracie freezes in her
"this is fine" pose next to a legible error and a retry button. The progress bar never
lies about what's happening.

### Reveal (map + sidebar)
A cloud layer billows in over the loading view, then parts — like looking down from above
the clouds at the finished route (~1.6s choreography: scale + blur + opacity). Under
`prefers-reduced-motion`, this collapses to an instant crossfade. Underneath: a paper-toned
map (see below) and a sidebar styled as a torn journal page, the itinerary rendered as a
handwritten-style list with times. Drag handles look like strips of washi tape; dragging
plays the pencil-scribble sfx and re-paths the map line.

### Map style (custom render engine — supersedes the MapLibre plan, Chris-directed 2026-07-05)
The map is painted by our own journal render engine (`src/lib/map/map-render-core.js`:
AI-watercolor textures + Rough.js hand-inked strokes + the hand-font label subsystem over
real OpenFreeMap geometry — no per-trip AI, basemap painted once, trip overlay redraws on
reorder). **Every art value lives in `src/lib/map/map-style-defaults.mjs` (M0.5-LOCKED by
Chris 2026-07-06 via Map Studio Copy-CONFIG)** — tune there via the studio
(`design/map-engine/map-studio.mjs`), never inline. That lock file is the sanctioned home
of the map's supporting hues (coastline, water lettering, road tans) beyond the §3 tokens —
they follow §3's descriptive intent (desaturated recessive water, ink-family roads) and
were locked by Chris's own Copy-CONFIG passes; §3's "no hard-coded hex" rule governs
COMPONENT code, not this delegated art file. Principles preserved from the original
direction: land = warm paper, water desaturated and distinct from the pen, thin ink roads,
POI labels minimal (route map, not a street atlas). The pen line is the vivid map-pen blue
(see `--route-blue` note above) and will draw on with M2's motion pass, never a static
straight polyline.

---

## 9. What is LOCKED vs what design taste can still adjust

**Locked (do not relitigate without asking Chris):** the §3 palette in full — weathered
warm paper canvas, `--action` green as the exclusive functional accent, `--soup` orange as
brand/illustration only, vibrant washi tape set, yellow booked highlight (Chris's explicit
call 2026-07-04 after board comparison); Gochi Hand + Nunito Sans as the type pair
(Chris-confirmed 2026-07-04); "the landing IS the product" (no
marketing-page formula); Gracie's identity, name, and role; the anti-generic law in §2 in
its entirety; sound behind an opt-out toggle.

**Open to taste-level refinement:** hover/pressed shade derivation (via §3's
darker-richer rule, never new hues); the precise spring timing curve; the exact
cloud-transition choreography; icon sourcing once a real icon need exists in D2. Base hex
values are no longer freely tunable — they were locked with Chris's palette decision; a
change now is a Chris-level decision, not taste refinement.

---

## 10. For implementers

Before writing any component: read this file, then load `taste-skill:taste-skill` (or
`redesign-skill` if restyling an existing surface) and `ui-ux-pro-max:design`. Where either
skill's defaults conflict with this file — this file wins. In particular: this file already
picks a palette, so ignore the skills' generic palette-selection guidance; already picks a
type pair, so ignore Inter/Geist suggestions; already bans gradients/glassmorphism per §2,
which is stricter than either skill's general guidance, not looser.
