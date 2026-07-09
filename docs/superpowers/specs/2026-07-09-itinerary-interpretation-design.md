# Design — Interpret the whole pasted itinerary (core)

- **Date:** 2026-07-09
- **Status:** Approved design (Chris), pending spec review → implementation plan
- **Scope:** CORE only. Cross-date "propose a smoother move", social-link (TikTok/IG) location
  extraction, and paywall *enforcement* are explicitly out of scope (see §10).

## 1. Goal

The user pastes a whole itinerary — **with or without Maps links** — and gets back a correctly
**dated**, **ordered**, **anchored**, multi-**day** itinerary. Place *names* (no link) are
geocoded best-effort and are user-fixable. Days are kept separate and **never shuffled across
dates**. Every new capability is built so it can be flipped free/paid from one place.

Concretely, these pastes should all work:

```
Day 1
9am breakfast at Tiong Bahru Bakery
National Gallery Singapore
lunch at Maxwell Food Centre (get the chicken rice)
https://maps.app.goo.gl/xyz   <- Gardens by the Bay

Day 2
Sentosa — cable car first, then the beach
```

Today only the `maps.app.goo.gl` link would survive; every text line is dropped. After this change
the text lines resolve too (gated), Day 1 and Day 2 separate correctly, "9am" anchors breakfast,
and "cable car first" becomes an order constraint.

## 2. Decisions (locked with Chris, 2026-07-08)

1. **Core first**, but designed so capabilities can be segmented as free/paid features.
2. **Interpretation = best-effort + user fixes.** Pin what resolves; the user corrects/removes wrong
   matches in the sidebar; unplaceable items are flagged, never guessed into a wrong pin.
3. **Dates = real when the paste gives them, else "Day 1 / Day 2…"** (never invent a calendar
   date, never prompt for a trip start).

## 3. Key finding that shapes the design

`resolvePlaces` (repo-root `resolvePlaces.ts`) **already resolves plain place names**, not just
URLs: `resolveOne(input)` runs `if (isUrl(input)) { parse the URL → query } else { query = input }`,
then a Places `searchText` on the query. So the LOCKED rule *"only URLs reach Places; label text is
never a query"* was a **policy** in the pipeline, not a capability gap. This feature **relaxes that
policy in a controlled way** — it does NOT add new geocoding code.

## 4. Architecture

Four small, independently-understandable units. Each has one purpose and a defined interface.

### 4.1 `entitlements` — the gate-ability boundary (NEW)

`src/lib/entitlements/entitlements.ts`

```ts
export type Capability =
  | "resolve.links"      // resolve Maps URLs → places (free; always on)
  | "interpret.names"    // geocode place NAMES from text (gate-able → paid)
  | "interpret.social"   // extract places from TikTok/IG/YouTube links (FUTURE slot, unused)
  | "suggest.crossDate"; // cross-date "propose a smoother move" (FUTURE slot, unused)

export interface Entitlements {
  has(cap: Capability): boolean;
}

// Pre-D3 stub: everything enabled. D3 (Supabase auth + Stripe Trip Pass) replaces the body
// with real per-user tier logic; NOTHING else in the codebase changes when it does — callers
// only ever ask `.has(cap)`.
export function getEntitlements(/* user?: User */): Entitlements { ... }
```

- The only source of "who can do what". One checkpoint (§4.3) reads it.
- Reserved capabilities (`interpret.social`, `suggest.crossDate`) exist as names now so future
  work slots in without touching this boundary.
- **Testability:** `runPipeline` accepts an optional injected `Entitlements` (defaults to
  `getEntitlements()`), so a unit test can prove names are skipped when `interpret.names` is off.
- **Two consult points, not one (Fable advisor):** `interpret.names` gates BOTH (a) the parse-adapter
  choice — off → heuristic (NO paid LLM call), on → LLM — AND (b) the resolve checkpoint (§4.3).
  Gating only resolve would still bill the paid Anthropic parse for a free-tier user. So the
  effective LLM parse = `PARSE_PROVIDER=llm` AND key present AND `interpret.names` entitled; the
  resolve checkpoint is then belt-and-suspenders (a stray `placeQuery` can't leak through).

### 4.2 Parse contract — one new field (CHANGED)

`src/lib/parse/types.ts` — add to `ParsedItemSchema`:

```ts
placeQuery: z.string().optional(),  // a DISAMBIGUATED search string (name + city/area context),
                                    // present ONLY for items the model judges a real place.
```

- `placeQuery` is distinct from `label` (display/context text). We geocode `placeQuery`, **never**
  `label` or `raw`. This preserves the spirit of the LOCKED rule (arbitrary label/note text is
  never a Places query) while enabling names — only deliberate, model-disambiguated place queries
  are sent.
- The **heuristic adapter cannot** produce `placeQuery` (it can't identify a place in free text),
  so it leaves it absent. Therefore **text-only interpretation implies the LLM adapter** — which
  fits `interpret.names` being a paid capability. The free/no-key path stays links-only, unchanged.

### 4.3 Pipeline resolve stage — the single checkpoint (CHANGED)

`src/lib/pipeline/pipeline.ts`, resolve stage. Replace the "collect only `item.url`" loop with:

```ts
const ent = entitlements; // injected or getEntitlements()
type Q = { source: string; itemIdx: number };
const queries: Q[] = [];
for (const [idx, item] of parsed.items.entries()) {
  if (item.kind === "link" && item.url) {
    queries.push({ source: item.url, itemIdx: idx });          // resolve.links (always)
  } else if (ent.has("interpret.names") && item.placeQuery) {
    queries.push({ source: item.placeQuery, itemIdx: idx });   // interpret.names (gated)
  }
}
```

- **Spend cap stays 40**, now covering links+names combined. **Order links-first, then names**
  before slicing to 40 (links are the free, most-reliable capability — never let names crowd out a
  link). **De-duplicate identical query strings** before `resolvePlaces` ("same cafe on Day 1 and
  Day 2" must not bill two lookups or burn two cap slots) and fan the single result back to every
  item sharing that source. Overflow → the existing failure-panel entries.
- **Copy update (Fable advisor):** the progress + failure strings that say "links" ("Reading your
  links…", "No links to look up.", "Couldn't find a match for one of your links.", the over-cap
  "That's a lot of links…") now cover names too → reword to "links and places" / "places".
- `resolvePlaces(queries.map(q => q.source))` → `Stop`s keyed by `source`. Assembly maps each
  item to its stop by `source = item.url ?? item.placeQuery`.
- The LOCKED-rule comment at pipeline.ts and parseItinerary.ts is **rewritten** to state the new
  policy precisely: *only `item.url` or `item.placeQuery` are ever sent to `resolvePlaces`; `label`
  and `raw` are still never queries; `placeQuery` is gated behind `interpret.names`.*
- Duplicate `placeQuery` strings across items resolve independently; the existing per-day
  `markDuplicateStops` (same resolved place-id within a day → suffixed id + `duplicateOf`) already
  handles the downstream, so no new dedup is needed.

### 4.4 Date resolution (CHANGED)

`src/lib/pipeline/pipeline.ts`, day assembly. Today every day is stamped `today` — the bug.

- A new pure helper `resolveDayDate(dateHint?: string, refToday: string): { date: string; dayLabel?: string }`:
  - Explicit day+month (± year) in `dateHint` ("12 Jul", "15 March 2026") → real ISO `date`
    (year inferred: use the current year if that month/day is today-or-future, else next year),
    no `dayLabel`.
  - "Day N" or a bare weekday ("Saturday") or absent → set `date = refToday` as an inert
    placeholder (nothing schedules on `date`; day math uses `dayStartMin`/`dayEndMin`, and `date`
    is display-only) and set `dayLabel` to the human label ("Day 1", "Saturday").
- `refToday` is passed in (not read from a global clock) so the helper is deterministic + unit
  testable.
- `TripDay` gains **`dayLabel?: string`** (additive). Day headings (`JournalSidebar` +
  `ShareTimeline`) show `dayLabel ?? fmtDayDate(date)`.
- **The single implicit day** (when `parsed.days` is empty) ALSO gets `dayLabel: "Day 1"` +
  `date = refToday` — never today's real calendar date shown as if it were the trip date
  (Fable advisor).
- Multi-day ordering: days keep the parse order of `parsed.days`.

### 4.5 LLM prompt (CHANGED)

`src/lib/parse/llmAdapter.ts` `SYSTEM_PROMPT` — additive rules, existing rules unchanged:
- Emit `placeQuery` for any item that is a real, searchable place: a specific search string that
  **includes disambiguating city/region context** drawn from the paste (e.g. `"Maxwell Food
  Centre, Singapore"`), NOT the casual label. Omit `placeQuery` for pure notes/context lines.
- Keep URLs verbatim (unchanged rule 1). `label` stays display-only (unchanged rule 2).
- Continue extracting `dateHint`, `timeHint`/`anchorLikely`, `orderConstraint`, `groupHint`, `days`
  (already present). Emphasize honoring intended order in `orderConstraint`.

### 4.6 No-key parse for tests (NEW — Fable advisor)

The heuristic adapter can't emit `placeQuery`, and tests have no LLM key — so the text-only e2e
(§8) would have no way to produce a `placeQuery` end-to-end. Add a **fixture parse adapter** (or a
test-only heuristic mode) that emits `placeQuery` for lines matching a known fixture-city place
name (normalized exact match), plus the `dateHint`/`timeHint`/`orderConstraint` cues the heuristic
already reads. Selected in fixture mode (no key), so `npx playwright test` exercises the full
text-only pipeline with **zero spend**. Real users still get the LLM. This is a CORE task, not a
footnote — it's the only way to test the headline feature without a live key.

## 5. Data flow (end to end)

1. **Parse** (`parseItinerary`): text → `ParsedItinerary` (LLM adds `placeQuery` to placeable items).
2. **Resolve** (pipeline, §4.3): build the query list (links always; names iff `interpret.names`),
   cap 40, `resolvePlaces` → stops + failures.
3. **Assemble** (pipeline): item → `TripStop` by `source`; `label ?? stop.name` for display;
   anchors from `timeHint`; days from `parsed.days` with §4.4 dates; precedence from
   `orderConstraint` (unchanged, already never crosses days).
4. **Plan** (unchanged): `planTripDay` per day.

## 6. Error / uncertainty handling (best-effort + fixes)

- A `placeQuery` that Places can't match → a failure-panel entry ("Couldn't place *X* — add a
  link?"), never a fabricated pin.
- A wrong match (right name, wrong branch) → the user removes/replaces it via the existing sidebar
  controls; nothing new needed.
- Items with no `placeQuery` and no URL (pure notes) → not resolved, not shown as stops
  (they were context for the LLM).
- Over-cap → existing overflow failures.

## 7. Cost safety

- `interpret.names` gate + the 40-lookup combined cap are the two guards.
- Only LLM-flagged `placeQuery` items are geocoded — never arbitrary label/note text.
- Fixture/heuristic paths (no key) spend nothing and never geocode names (no `placeQuery`).

## 8. Testing

- **Unit — entitlement gate:** `runPipeline(text, { entitlements: none })` on a names-only paste →
  zero resolve queries; with `interpret.names` on → the names resolve. (Fixture provider, no spend.)
- **Unit — query routing guard** (mirrors the existing `adapterGuard`): assert only `url`/`placeQuery`
  reach the resolve call; `label`/`raw` never do (spy on the provider's `resolvePlaces` args).
- **Unit — `resolveDayDate`:** explicit date → ISO with correct year inference; "Day 2"/"Saturday"/
  absent → `dayLabel` + placeholder date. Deterministic via injected `refToday`.
- **Unit — cap:** 41 placeable items → 40 resolved + 1 overflow failure.
- **e2e (fixture, no key):** paste a **text-only** fixture-city itinerary (bare place names + "Day 1/
  Day 2") → both days render with pins, correct labels, an anchor, an order constraint honored.
  Requires extending the **fixture adapter** to resolve bare names (it already extracts names from
  URLs; add a name→fixture-place lookup so fixture mode exercises the text-only path end-to-end).
- **Live LLM** stays UNVERIFIED-by-design (no key exercised in tests, per the existing philosophy) →
  CHRIS-STEP eyeball with a real key: paste a real text-only trip and confirm interpretation.

## 9. Files touched

- **New:** `src/lib/entitlements/entitlements.ts` (+ test).
- **Changed:** `src/lib/parse/types.ts` (`placeQuery`), `src/lib/parse/llmAdapter.ts` (prompt),
  `src/lib/pipeline/pipeline.ts` (resolve checkpoint + `resolveDayDate` + inject entitlements),
  `src/lib/store/types.ts` (`TripDay.dayLabel?`), the day-heading render sites —
  `JournalSidebar.tsx` and `ShareTimeline.tsx` (both call `fmtDayDate(day.date)`; the RevealClient
  day-tabs already show "Day N" and need no change) — the fixture adapter (name resolution for
  tests), and the LOCKED-rule comments in pipeline.ts + parseItinerary.ts.
- **Untouched (LOCKED):** solver, schedule, matrixSource, planService, map render engine,
  map-style-defaults, realAdapter, resolvePlaces itself.

## 10. Out of scope (deferred, by "core first")

- **Cross-date "propose a smoother move"** — its own spec; needs a smoothing heuristic + a proposal
  UX (user has final say, never auto-applied). `suggest.crossDate` slot reserved.
- **Social-link extraction (TikTok/IG/YouTube → places in the video)** — future paid capability;
  `interpret.social` slot reserved.
- **Paywall enforcement** — D3 (Supabase auth + Stripe Trip Pass) fills the `getEntitlements` stub;
  until then all capabilities ship enabled.

## 11. Open questions / risks

- **Year inference for bare "12 Jul"** can be wrong across a year boundary; best-effort + the user
  can't currently edit the date in-UI (date editing is not in scope — flag if it becomes an issue).
- **Weekday-only hints ("Saturday")** can't become a real ISO date without a start reference → they
  fall back to a `dayLabel` string. Acceptable per the dates decision.
- **`placeQuery` quality depends on the LLM** adding good city/region context; verified at the
  CHRIS-STEP live eyeball.
