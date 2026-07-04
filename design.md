# TripSoup — design.md (the law)

_Root-level design contract. Every session writing UI code MUST read this file first and
load the `taste-skill:taste-skill` (or `redesign-skill` for restyles) + `ui-ux-pro-max:design`
skills before writing a line of markup. Where this file and either skill disagree, **this
file wins.** Part of the approved production plan
(`~/.claude/plans/i-want-you-to-starry-wave.md` — outside the repo, in the machine's
Claude config — phase D1)._

**Status note (2026-07-04):** written before the D1.1 reference-board exploration and the
D1.3 Gracie asset pipeline, both of which are paused pending the Higgsfield image-gen tool
reconnecting (Chris's explicit call — do not substitute stock photography or a different
gen pipeline in the meantime). Every value below is complete and usable now; the plan
explicitly allows palette hex values to tune **±10%** once real reference art exists — that
is refinement, not a rewrite. Anywhere this doc depends on an asset that does not exist yet,
it says so and names the fallback.

---

## 1. Identity

**Product:** TripSoup — paste a messy group itinerary, get an optimized day plan you can
share and run a trip from.

**Mascot: Gracie** — a teen chef girl, apron + bandana, who takes the chaos of pasted
links and cooks it into a route. She is not a corporate assistant character; she's a
capable friend having a good time doing something she's genuinely skilled at.

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
   anywhere. TripSoup has exactly one hot accent color (`--soup`) and it is applied as a
   flat fill, never a gradient.
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

## 3. Palette

Paper and ink, not white and gray. Every color below is a CSS custom property in
`app/globals.css`; nothing is a hard-coded hex in component code.

| Token | Value | Role |
|---|---|---|
| `--paper` | `#F6F1E7` | Page background — warm cream, never pure white |
| `--paper-shade` | `#EAE2D3` | Recessed surfaces, card backgrounds, input fills |
| `--ink` | `#2B2620` | Primary text — warm near-black, **never** `#000` |
| `--ink-soft` | `#6B6155` | Secondary text, captions, muted labels |
| `--soup` | `#E0662E` | **The** brand accent — warm tomato-soup orange. One hot accent, used consistently everywhere it appears (primary CTAs, the Gracie brand mark, active states) |
| `--route-blue` | `#3E6C8E` | Secondary accent — fountain-pen blue, reserved for the map's route line and anything that needs to read as "drawn," not "actioned" |
| `--herb` | `#5F7D4F` | Success / confirmation states |
| `--washi` | `#F4C95D` | Anchor/booked-stop marker — reads as a strip of washi tape |
| `--danger` | `#C0392B` | Infeasibility / error states (warm red, not a cold system red) |

**Relationships are law, exact values are tunable ±10%:** warm paper background, warm ink
text, exactly one hot accent, one "pen" accent for drawn/map elements. If D1.1 reference
exploration suggests `--soup` should be `#DB5F2A` instead of `#E0662E`, that's a fine
adjustment — introducing a second hot accent, or a cool gray background, is not.

**Contrast (WCAG AA, independently verified in the D1 audit 2026-07-04):** `--ink` on
`--paper` computes to ~13.3:1 (comfortably AAA). `--soup` on `--paper` computes to
**~3.05:1** — barely above the 3:1 large-text/non-text minimum and **below the 4.5:1
body-text minimum**. The margin over 3:1 is thin; if D1.1 reference exploration tunes
`--soup`, prefer tuning darker (raising contrast) within the allowed ±10%. Accordingly,
`--soup` is used only for large text (≥18px / bold ≥14px, which only needs 3:1), fills with
`--paper`-colored text on top (inverted, not text-on-paper), icons, and borders — never as
small body text color on the paper background. This is enforced in the component layer
(§5), not left to callers to remember.

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
readability at 14–16px. **Provisional:** the plan gates this pick behind the D1.1
reference-board exploration, which hadn't run when this pick was made — D1.1 must confirm
(or swap within the same three candidates) before the pair moves to §9's locked list for good.

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
  `--soup` fill, `--paper`-colored text (satisfies the contrast rule in §3), a hand-drawn
  irregular border. Pressed state: `translateY(1px)` + the paper-lift shadow collapses to
  nothing — a physical "stamp down" motion, not a generic `:active { opacity: 0.8 }`.

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

### Map style (MapLibre)
Style JSON tuned to the same paper tones: land fill = `--paper`, water = a desaturated
`#C9D6D2` (deliberately not `--route-blue` — water and routes must read as visually
distinct), roads as thin ink-colored lines, POI labels kept minimal (this is a route map,
not a full street atlas). The route itself draws on as a hand-sketched pen line in
`--route-blue` — a draw-on animation (dasharray interpolation) or a slight jitter shader,
not a static straight polyline.

---

## 9. What is LOCKED vs what design taste can still adjust

**Locked (do not relitigate without asking Chris):** the paper/ink/one-hot-accent palette
relationship; Gochi Hand + Nunito Sans as the type pair (provisional until D1.1 confirms —
see §4); "the landing IS the product" (no
marketing-page formula); Gracie's identity, name, and role; the anti-generic law in §2 in
its entirety; sound behind an opt-out toggle.

**Open to taste-level refinement:** exact hex values (±10%, per §3); the precise spring
timing curve; the exact cloud-transition choreography; icon sourcing once a real icon need
exists in D2.

---

## 10. For implementers

Before writing any component: read this file, then load `taste-skill:taste-skill` (or
`redesign-skill` if restyling an existing surface) and `ui-ux-pro-max:design`. Where either
skill's defaults conflict with this file — this file wins. In particular: this file already
picks a palette, so ignore the skills' generic palette-selection guidance; already picks a
type pair, so ignore Inter/Geist suggestions; already bans gradients/glassmorphism per §2,
which is stricter than either skill's general guidance, not looser.
