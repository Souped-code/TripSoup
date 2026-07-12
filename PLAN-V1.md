# PLAN-V1.md — TripSoup: live beta → public v1

- **Date:** 2026-07-12 · **Author:** Fable 5 (docket session) · **Approver:** Chris
- **Executes:** Opus orchestrating Sonnet (features) and Haiku (mechanical), with a **Fable
  advisor** (pre-build design/safety counsel, no code) and an **independent fresh-context Fable
  auditor** before every milestone-complete claim (Opus fresh-context stands in when Fable is
  rate-limited — proven pattern).
- **Supersedes** the master plan (`~/.claude/plans/i-want-you-to-starry-wave.md`) for everything
  from here forward. That plan's D0–D2 history, design law, and orchestration mechanics remain
  ground truth; its D3 (pay-to-share) is retired per `docs/briefs/d3-payments-auth-brief.md`.
- **Companion documents (read before any milestone):** repo `STATE.md` (evidence log — append
  every session), `design.md` (design law), `docs/briefs/d3-payments-auth-brief.md` (payments
  contract + amendments), `docs/superpowers/specs/2026-07-09-itinerary-interpretation-design.md`
  (M1 spec), `LIVE-CHECKLIST.md` (Chris's live verification ledger).

## GOAL

TripSoup turns a messy pasted itinerary — Maps links, plain place names, day headers, timing
notes, even social-video links — into a hand-drawn journal map with an optimised, editable,
shareable plan. v1 makes the full interpretation feature set public with freemium payments
**built in but held in a test-only "soft" mode** until Chris has personally verified every paid
feature functions as promised, then flips to live Stripe. The product is already deployed at
trip-soup.vercel.app; this plan is the firm path from today's beta to charging customers.

**NON-GOALS for v1:** the D4 live layer (presence/location/readiness — planned below as v1.1,
NOT in the v1 launch gate); gift-code redemption (schema stubbed only); Google OAuth; native
apps; multi-currency; subscriptions; trip collaboration/editing by non-owners; date editing
in-UI; swapping the Google matrix provider (post-launch cost lever).

---

## ORCHESTRATION PROTOCOL (how every milestone runs)

1. **Session model = Opus** (or Fable). HARD GATE: if the session model is Sonnet/Haiku/anything
   else, STOP and flag to Chris before any work. One milestone (or sub-block for M3) per session.
2. Orchestrator reads PLAN-V1.md + STATE.md + the milestone's spec, creates TaskCreate entries,
   and dispatches implementation to `Agent(model: sonnet|haiku)` with: the task text, exact file
   paths, the acceptance check, and design.md's anti-generic law verbatim for any UI task.
   Independent tasks run in parallel **only when their file paths don't overlap**.
3. The orchestrator OWNS verification and git: it corroborates every subagent diff line-by-line,
   runs the gates itself (`npx tsc --noEmit` · `npx jest` · `npx playwright test` · `next build`),
   and commits. Subagents never commit.
4. **Fable advisor** `[fable · high]` opens every design-heavy milestone (M2.1, M3.1, M4.2, M5.1)
   before code. **Independent fresh-context audit** `[fable · high]` (no prior conversation,
   given spec + diff + claims) before ANY milestone-complete claim. Findings fixed before close.
5. Chris gates: every milestone exit has a CHRIS-VERIFY (his own eyes, usually on his phone
   against prod) and merges to `main` (auto-deploys) happen only on his GO. Note: direct pushes
   to main may be blocked by the permission classifier — Chris releases with `! git push origin
   main` or a settings allowlist rule.
6. Remote-control rule: essential explanations go INSIDE AskUserQuestion text, and every
   clarifying question ships with a recommendation.
7. **§0 STANDING SKILL INVOKE-ORDER (re-invoke, don't rely on memory of them):**
   `unattended-run-protocol` at run start; **`model-effort-routing` at EVERY phase boundary —
   before the phase's first delegation AND before its gate adjudication**;
   `superpowers:brainstorming` before M5.1; `done-means-verified` +
   `verification-before-completion` at every exit; `land-the-change` for anything applied
   outside the working tree (Supabase dashboard, Stripe dashboard, Vercel env).
8. **Model/effort enforcement (per `model-effort-routing`):** every gate adjudication
   transcript MUST contain the statement "I am currently running as [model · effort]" — a gate
   without it is not closed, and auditors flag it. If the session is on the wrong
   model/effort for a gate: HALT, write sentinel file `HALT-MODEL-MISMATCH` in the repo root,
   and instruct Chris to switch — never adjudicate a gate on the wrong configuration. Effort
   precedence if a setting seems ignored: `CLAUDE_CODE_EFFORT_LEVEL` env > `--effort` flag >
   subagent/skill frontmatter > `/effort` in chat; unset everywhere defaults to xhigh.

**EFFORT ROUTING (companion to the [Tier · effort] tags in every task table):**
- **Defaults:** Haiku = low (never above — promote to Sonnet instead). Sonnet = medium.
  Orchestrator (Opus session) = **medium on coordination turns** (delegating written tasks,
  corroborating diffs against acceptance criteria, sequencing, summaries), **xhigh on
  gate/audit turns**. Fresh-context audit agents = Fable · high (Chris's standing
  configuration) with **Opus · xhigh** as the substitute when Fable is rate-limited — audits
  run at this depth regardless of what effort built the phase.
- **Named exceptions (all justified inline at the task):** Sonnet · high on M1.4 (the single
  money-spend checkpoint), M2.2 (geometry/threshold judgment), M3.5 (the gate matrix IS the
  money logic), M3.7 (payment path), M4.1/M4.3 (adversarial external APIs), M5.3–M5.5
  (constraint orchestration + choreography-adjacent UI).
- **Never skip, regardless of token budget:** the M3 gates (auth/RLS/money) and M7.4–M7.5
  (charging real people) run at full audit depth — cut coordination cost, never these.
- **Chris-directive exception to the framework:** `model-effort-routing` advises against a
  standing premium advisor; Chris explicitly mandates the Fable advisor + independent Fable
  auditor constellation (proven on this project). User directive wins — recorded here so no
  session "optimises" the advisor away. Orchestrator model floor stays Fable/Opus per the
  standing HARD GATE (never Sonnet/Haiku).

---

## FIXED FACTS / LOCKED — do not re-litigate

- **Engine LOCKED:** `src/lib/solver/solver.ts`, `src/lib/map/map-render-core.js`,
  `src/lib/map/map-style-defaults.mjs`, `resolvePlaces.ts`. Watermark/forked-routes/export are
  overlays or callers, never engine edits. Existing test fixtures untouched.
- **Design law:** design.md §1–§8. Palette/type locked (pine `--action` = only functional accent;
  `--soup` orange never on buttons; Gochi Hand + Nunito Sans). Gracie style C. Anti-generic law
  on every new surface. `prefers-reduced-motion` honored on every animation. Axe 0 violations.
- **Pricing:** SGD 6.90 single / 15.90 ×3 / 24.90 ×5, one-time, credit balance. **Share stays
  free.** Free tier: 8 stops, links-only, watermarked map, no export. Pass (per-trip spend of one
  credit): 40 stops, `interpret.names`, `suggest.crossDate`, `interpret.social`, hi-res PNG
  export, no watermark.
- **Auth = email OTP** (6-digit, same-tab). Not magic link (mobile browser-hop strands checkout).
- **PAYWALL_MODE (new, this plan): `off | soft | live`**, a server env flag read by the
  entitlements resolver. The resolver ships in M3 and is wired to prod only at the M3.11 soft
  deploy; **unset/typo defaults to `soft` (fail-closed)**, so `off` must be set explicitly
  (legacy/dev escape hatch only — no task ever sets it in prod). `PAYWALL_MODE` +
  `TESTER_EMAILS` are on the M3.2 env list.
  - `off` (explicit only): everything enabled for everyone, no paywall UI — today's behavior,
    which pre-M3 prod has without any flag (no resolver exists yet).
  - `soft` (M3 deploy → M7 flip): **free tier enforced for everyone**; paywall modal live;
    Stripe runs TEST mode; only allowlisted tester emails (Chris) can purchase; the public CTA
    shows "Trip Passes launching soon" + email capture. No take-away at flip: free users never
    had pass features.
  - `live`: real Stripe. Flip = M7, Chris's hand only.
- **Cost safety:** only `item.url` or LLM-flagged `item.placeQuery` (or M4's derived social
  queries) ever reach Places; `label`/`raw` never. 40-lookup combined cap per paste, links
  first, deduped. LLM parse gated so free tier never triggers a paid Anthropic call. Paste cap
  20KB. Per-IP pipeline rate limit. Tests spend $0 (fixture mode) — live behavior verified once
  by Chris per LIVE-CHECKLIST.
- **Dates are never invented:** explicit dates → real ISO; "Day 2"/"Saturday"/absent → `dayLabel`
  placeholder. Cross-date moves only ever *proposed*, never auto-applied.
- **Don't re-break (each regressed before):** `app/globals.css` `main{max-width:880px}` override
  on the reveal main; reveal grid `width:100%` + `min-width:0`; map texture files are
  immutable-cached — **new filenames on any texture change, never overwrite**; motion v12
  `controls.finished` never rejects — choreography supersede = `choreoGen` guards only; **never
  enable Supabase captcha before the frontend sends the token** (kills all auth).
- **Sequence locked (Chris 2026-07-11/12):** M1 B1a → M2 B1b → M3 D3-soft → M4 B1c → M5 B2 →
  M6 D5 → M7 flip. D4 = v1.1 after launch. Free tier enforced from M3 deploy with tester
  allowlist.

---

## MILESTONE MAP

| M | Name | Demoable exit (CHRIS-VERIFY) | Depends on |
|---|------|------------------------------|------------|
| M0 | Preflight: flags design, CI, Sentry | CI red/green on a test PR; Sentry catches a thrown error; CHRIS-STEP checklist issued | — |
| M1 | B1a — whole-paste interpretation | Text-only 2-day paste on prod → dated days, named pins, anchor + order honored | M0 |
| M2 | B1b — cross-date move proposals | Misplaced-stop fixture shows one journal-voice proposal; accept re-plans both days; decline sticks | M1 |
| M3 | D3 — payments + auth, deployed in `soft` | Prod enforces free tier; Chris (allowlisted) buys with 4242 test card → credits granted once, watermark off, 40 stops, export | M1, M2 (sequential — M2.3 and M3.8 both edit `RevealClient.tsx`) |
| M4 | B1c — social-link extraction | Paste a YouTube travel vlog (+TikTok/IG per spike gate) → real stops on the map; failures degrade politely | M1, M3 (gating) |
| M5 | B2 — split groups (braided timeline) | 2-group fixture day renders forked coloured routes + A/B sidebar lanes; branch reorder re-plans only that branch | M1 (design), M3 (gating) |
| M6 | D5 — multi-day page-flip | Day-tab switch plays a page-turn; reduced-motion = crossfade; axe 0 | M1 |
| M7 | Hardening + paid verification + FLIP to live | Chris completes the paid-feature verification script; real SGD 6.90 purchase + refund round-trip live; v1 public | ALL above |
| M8 | v1.1 — D4 live layer (post-launch) | Two phones on one trip: presence, dots, ready/gather round-trip | M7 |

---

## FILE TREE (finished v1; NEW = created by this plan, CHG = modified, LOCKED = untouchable)

```
app/
  api/
    auth/otp/route.ts                 NEW  M3 — send + verify email OTP (Supabase)
    checkout/route.ts                 NEW  M3 — Stripe Checkout session (metadata: user, product, trip)
    webhooks/stripe/route.ts          NEW  M3 — sig verify → replay guard → synchronous fulfil/refund
    pipeline/route.ts                 CHG  M1/M3 — SSE pipeline; rate limit + paste cap; entitlements injected
    route-geometry/route.ts                — AWS road-polyline proxy (as-is)
    social/extract/route.ts           NEW  M4 — social URL → caption/frames → place queries (server-only)
    trips/route.ts                        — create trip (KV)
    trips/[id]/route.ts               CHG  M2 — GET/PUT; PUT accepts proposal-applied docs
    trips/[id]/plan/route.ts              — re-plan (as-is)
    trips/[id]/resolve/route.ts           — re-resolve (as-is)
  trip/[id]/page.tsx                  CHG  M3 — resolve entitlements server-side, pass to client
  share/[id]/page.tsx                 CHG  M1 — dayLabel headings (share stays free)
  legal/terms/page.tsx                NEW  M3 — ToS (journal-styled, human-readable)
  legal/privacy/page.tsx              NEW  M3 — privacy + PDPA note (pastes scrubbed, location v1.1 note)
  legal/refunds/page.tsx              NEW  M3 — 7-day one-click-by-email refund policy
  page.tsx                            CHG  M3 — AuthButton in header; soft-mode banner slot
  layout.tsx                          CHG  M3 — auth/session provider wrap
  globals.css                         CHG  M3 — auth/paywall tokens only (main max-width override stays)
  debug/…                                 — debug surfaces (as-is, behind DEBUG_BOARD)
src/lib/
  entitlements/entitlements.ts        NEW  M1 — Capability enum + Entitlements iface + stub (all-on)
  entitlements/resolver.ts            NEW  M3 — real resolver: PAYWALL_MODE + allowlist + trip_entitlements
  entitlements/__tests__/…            NEW  M1/M3 — gate on/off, mode matrix, allowlist
  supabase/server.ts                  NEW  M3 — @supabase/ssr cookie client (identify)
  supabase/client.ts                  NEW  M3 — browser client (auth only)
  supabase/admin.ts                   NEW  M3 — service-role client, `import "server-only"`
  payments/products.ts                NEW  M3 — product_type → price env + credits map (single source)
  payments/fulfil.ts                  NEW  M3 — grant-credits + spend-on-trip transaction caller
  proposals/crossDay.ts               NEW  M2 — pure heuristic: outlier stop + day-load imbalance → proposals
  proposals/__tests__/crossDay.test.ts NEW M2 — fixture-graded proposal cases
  social/detect.ts                    NEW  M4 — URL → platform classifier (yt/tiktok/ig)
  social/captions.ts                  NEW  M4 — per-platform caption/description fetchers (per spike)
  social/frames.ts                    NEW  M4 — optional MP4 → frames → vision extraction (per spike gate)
  social/__tests__/…                  NEW  M4 — fixture captions → queries; no live fetch in tests
  parse/types.ts                      CHG  M1 — + placeQuery (zod, optional)
  parse/llmAdapter.ts                 CHG  M1 — prompt: emit disambiguated placeQuery; order intent
  parse/heuristicAdapter.ts               — unchanged (cannot emit placeQuery, by design)
  parse/fixtureParseAdapter.ts        NEW  M1 — test-only: fixture-city names → placeQuery, $0
  parse/parseItinerary.ts             CHG  M1 — adapter choice consults interpret.names (no paid parse for free tier)
  pipeline/pipeline.ts                CHG  M1/M3 — single resolve checkpoint (links+names+social, cap 40,
                                            dedupe, links-first), resolveDayDate, entitlements param, maxStops
  store/types.ts                      CHG  M1/M5 — TripDay.dayLabel?; M5 additive split-segment schema
  store/kvStore.ts                        — trips in KV (as-is; trips do NOT move to Supabase)
  maps/…                              LOCKED/— resolvePlaces path as-is; fixtureAdapter CHG M1 (name lookup)
  solver/solver.ts                    LOCKED — branching happens ABOVE it (planService), never inside
  planService.ts                      CHG  M5 — per-branch solve + shared segments + convergence anchors
  schedule/…                          CHG  M5 — branch-aware schedule assembly (additive)
  map/map-render-core.js              LOCKED
  map/map-style-defaults.mjs          LOCKED
  rateLimit.ts                        CHG  M1 — pipeline limiter wired (Upstash on existing KV)
src/ui/
  auth/AuthButton.tsx                 NEW  M3 — "Sign in" ⇄ "N trips remaining" header widget
  auth/OtpSheet.tsx                   NEW  M3 — same-tab email → 6-digit code sheet, journal voice
  reveal/PaywallModal.tsx             NEW  M3 — 3 triggers; Gracie + ticket; soft-mode CTA + email capture
  reveal/WatermarkOverlay.tsx         NEW  M3 — canvas overlay stamp (display + export paths; engine untouched)
  reveal/ExportButton.tsx             NEW  M3 — offscreen 2× render → PNG download (pass-gated)
  reveal/ProposalCard.tsx             NEW  M2 — "move Fort Canning to Day 2?" journal card, accept/dismiss
  reveal/RevealClient.tsx             CHG  M2/M3/M5 — proposals, paywall triggers, A/B lanes host
  reveal/JournalSidebar.tsx           CHG  M1/M5 — dayLabel headings; split-lane rendering
  reveal/RevealMap.tsx                CHG  M3/M5 — watermark hook; forked-route overlay painting
  reveal/ShareTimeline.tsx            CHG  M1 — dayLabel headings
  pipeline/LoadingView.tsx            CHG  M1 — "links and places" copy
  pipeline/usePipeline.ts             CHG  M3 — post-purchase re-run without reload
supabase/migrations/001_payments.sql  NEW  M3 — trip_credits, purchases, trip_entitlements, stripe_events,
                                            RLS, fulfil_purchase() + spend_credit() transactional fns
e2e/
  trip.spec.ts, fullflow.spec.ts, reveal.spec.ts, sidebar.spec.ts, multiday.spec.ts,
  pipeline.spec.ts, greeting.spec.ts, share.spec.ts, debug-design.spec.ts
                                          — the existing 9 specs / 26 tests stay green throughout
  interpretation.spec.ts              NEW  M1 — text-only fixture paste end-to-end
  proposals.spec.ts                   NEW  M2 — propose/accept/decline
  paywall.spec.ts                     NEW  M3 — free caps, 3 triggers, FREE-mode matrix (fixture, $0)
  split.spec.ts                       NEW  M5 — braided day
design/backend-design.md              NEW  M0/M3 — binding payments/auth design contract
scripts/rls-smoke.mjs                 NEW  M3 — anon-key denial sweep vs the real project
scripts/spike-social/                 NEW  M4 — throwaway spike scripts (gitignored)
.github/workflows/ci.yml              NEW  M0 — tsc · jest · playwright · client-bundle secret grep · build
sentry.*.config.ts                    NEW  M0 — error observability, paste-text scrubbed
docs/briefs/d3-payments-auth-brief.md      — payments contract (verbatim + amendments)
docs/superpowers/specs/…                   — M1 spec (exists); M2/M4/M5 specs land at their milestones
PLAN-V1.md                                 — this plan
STATE.md / LIVE-CHECKLIST.md / design.md   — living ground truth
```

(Existing files not listed — Gracie/journal components, solver internals, debug pages — are
untouched by v1. No task may say "various files".)

---

## M0 — PREFLIGHT (one short session)

| id | Task | Files | Model·Effort | Acceptance (<2 min) |
|----|------|-------|--------------|---------------------|
| M0.1 | Design note: PAYWALL_MODE semantics + tester allowlist (env `TESTER_EMAILS`) + soft-mode UX copy skeleton; issue CHRIS-STEP checklist (Supabase project slot — Critter Collect pause freed one, verify; Stripe SG account standing; Vercel env list) | `design/backend-design.md` (skeleton §0) | Opus·high | Doc exists; checklist delivered to Chris in chat |
| M0.2 | GitHub Actions CI: tsc, jest, Playwright (fixture), `next build`, grep `.next` client chunks for `SUPABASE_SERVICE_ROLE\|STRIPE_SECRET\|ANTHROPIC_API_KEY` | `.github/workflows/ci.yml` | Haiku·low | Push a whitespace PR → all jobs green; add a fake secret to a client file locally → grep job fails |
| M0.3 | Sentry via `@sentry/nextjs`, beforeSend scrubs any event field containing pasted text; DSN in env | `sentry.client.config.ts`, `sentry.server.config.ts`, `next.config.mjs` | Sonnet·medium (judgment: PII scrub) | Throw in a debug route → event visible in Sentry with paste field redacted |

**Exit:** CI gating PRs; Sentry live; Chris has the CHRIS-STEP checklist. *(M0.2 ∥ M0.3 parallel-safe.)*

## M1 — B1a: WHOLE-PASTE INTERPRETATION (spec: docs/superpowers/specs/2026-07-09)

| id | Task | Files | Model·Effort | Acceptance |
|----|------|-------|--------------|------------|
| M1.1 | Entitlements module — **the LOCKED shape, reconciling spec §4.1 (capabilities) with the brief (tier fields), decided here once:** `interface Entitlements { tier: "free"\|"pass"; has(cap: Capability): boolean; maxStops: number; watermark: boolean }` (export = `has("export.hires")`; caps incl. reserved `interpret.social`/`suggest.crossDate`). Stub returns all-on/40/no-watermark. Pipeline signature fixed now: `runPipeline(text, { entitlements })`. M3.5 swaps the stub's *source*, never the shape | `src/lib/entitlements/entitlements.ts` + `__tests__/entitlements.test.ts` | Sonnet·medium | `npx jest entitlements` green; callers use only `.has()`/`maxStops`/`watermark` |
| M1.2 | Parse contract: `placeQuery` zod field + LLM prompt rules (disambiguated place string w/ city context; omit for notes; keep order-intent emphasis) | `src/lib/parse/types.ts`, `src/lib/parse/llmAdapter.ts` | Sonnet·medium | `npx jest parse` green incl. new schema case |
| M1.3 | Fixture parse adapter: fixture-city names → placeQuery + dateHint/timeHint/orderConstraint; selected in no-key mode | `src/lib/parse/fixtureParseAdapter.ts`, `src/lib/parse/parseItinerary.ts` | Sonnet·medium | Unit: fixture paste yields placeQuery items with $0 spend |
| M1.4 | **The cost-safety core:** resolve checkpoint — links always, names iff `interpret.names`; combined cap 40 links-first; query dedupe + fan-back; copy "links"→"links and places"; rewrite LOCKED-rule comments | `src/lib/pipeline/pipeline.ts` + `__tests__` | Sonnet·**high** (single money-spend checkpoint; deviation justified) | Unit: gate off → 0 name queries; 41 items → 40+1 overflow; dupes billed once; adapter-guard spy shows label/raw never queried |
| M1.5 | `resolveDayDate` + `TripDay.dayLabel` + heading renders (never invent dates; implicit day = "Day 1") | `src/lib/pipeline/pipeline.ts`, `src/lib/store/types.ts`, `src/ui/reveal/JournalSidebar.tsx`, `src/ui/reveal/ShareTimeline.tsx` | Sonnet·medium | Unit: "12 Jul"→ISO w/ year rule; "Day 2"→label; UI shows labels |
| M1.6 | Double-gate the LLM parse (adapter choice consults `interpret.names` — free tier must never trigger a paid Anthropic parse) | `src/lib/parse/parseItinerary.ts` + test | Sonnet·medium | Unit: entitlements-off + llm env → heuristic adapter chosen |
| M1.7 | Pipeline rate limit 10/hr/IP (Upstash on existing KV) + 20KB paste cap, journal-voice errors | `src/lib/rateLimit.ts`, `app/api/pipeline/route.ts` | Sonnet·medium | 11th call in an hour → friendly 429 (curl loop); 21KB paste → soft error |
| M1.8 | e2e: text-only 2-day fixture paste → both days, pins, labels, anchor, order constraint | `e2e/interpretation.spec.ts`, `src/lib/maps/fixtureAdapter.ts` (name lookup) | Sonnet·medium | `npx playwright test interpretation` green, $0 |
| M1.9 | Fresh-context audit vs spec + all gates + STATE.md entry | — | Fable·high | Verdict MERGE-READY, 0 blocking |

**Exit (CHRIS-VERIFY):** on prod, paste a real text-only 2-day itinerary → correct days/pins/
anchors. Rate limit visible in KV metrics. *(Parallel: M1.1∥M1.2; M1.5∥M1.7; rest sequential —
M1.3/M1.4/M1.6 share parseItinerary/pipeline.)*

## M2 — B1b: CROSS-DATE MOVE PROPOSALS

| id | Task | Files | Model·Effort | Acceptance |
|----|------|-------|--------------|------------|
| M2.1 | Spec: proposal heuristic (stop is a geographic outlier on its day AND fits another day's cluster; day-load imbalance threshold; max 2 proposals/trip; never anchored stops), proposal payload shape, UX (journal card, Gracie, accept/dismiss, dismissed = persisted, never re-nag), accept path = client applies move → existing PUT + re-plan both days. **Chris approves spec before build.** | `docs/superpowers/specs/<date>-cross-date-proposals.md` | Fable·high (advisor) | Spec exists; Chris GO recorded |
| M2.2 | Pure heuristic lib per spec, deterministic, fixture-graded | `src/lib/proposals/crossDay.ts` + `__tests__` | Sonnet·**high** (geometry/threshold judgment) | Unit: planted-outlier fixture → exactly the expected proposal; balanced trip → none |
| M2.3 | ProposalCard UI + wiring (compute after plan, render in sidebar, accept→move+re-plan, dismiss persisted in doc) | `src/ui/reveal/ProposalCard.tsx`, `src/ui/reveal/RevealClient.tsx`, `app/api/trips/[id]/route.ts` (dismissals field) | Sonnet·medium | Fixture trip: card appears, accept moves stop + re-plans, dismiss survives reload |
| M2.4 | e2e + fresh-context audit + gates | `e2e/proposals.spec.ts` | Sonnet·medium / Fable·high | Playwright green; audit 0 blocking |

**Exit (CHRIS-VERIFY):** prod trip with a deliberately misplaced stop → one sensible proposal in
journal voice; accept visibly re-plans; decline never returns. Capability `suggest.crossDate`
consulted (all-on until M3).

## M3 — D3: PAYMENTS + AUTH, DEPLOYED SOFT (contract: docs/briefs/d3-payments-auth-brief.md)

| id | Task | Files | Model·Effort | Acceptance |
|----|------|-------|--------------|------------|
| M3.1 | Binding backend design: full DDL (brief's 3 tables **+ `stripe_events` replay guard + a `redemption_codes` stub table** — gift phase-2 concept stubbed per brief, no logic), RLS SQL, `fulfil_purchase()` + `spend_credit()` transactional semantics (buy-from-paywall grants N credits AND atomically spends 1 on that trip; refund decrements floor-0 but never un-entitles already-spent trips — document), PAYWALL_MODE/allowlist matrix, failure-mode table (replay, junk sig, pay-close-tab, RLS bypass, OTP rate-limit). **Independent design audit before any build.** | `design/backend-design.md` | Fable·high (advisor) + Opus·xhigh (audit — security boundary, never-skip class) | Doc complete; audit 0 blocking; Chris layman walkthrough done |
| M3.2 | CHRIS-STEP: Supabase project (enable Email OTP; **no captcha until frontend sends tokens**), Stripe test products/prices, all env → Vercel + `.env.local` | — | Chris | Keys present; `supabase status` reachable |
| M3.3 | Supabase clients + migration 001 (tables, RLS, functions) applied via CLI to the project | `src/lib/supabase/{server,client,admin}.ts`, `supabase/migrations/001_payments.sql` | Sonnet·medium | Migration applies clean; RLS smoke: anon key SELECT on others' rows → 0 |
| M3.4 | OTP auth: same-tab email→code sheet + AuthButton ("Sign in" ⇄ "N trips remaining") | `src/ui/auth/OtpSheet.tsx`, `src/ui/auth/AuthButton.tsx`, `app/api/auth/otp/route.ts`, `app/layout.tsx`, `app/page.tsx` | Sonnet·medium | Sign in on prod-preview with a real email; session survives refresh |
| M3.5 | Real entitlements resolver behind the M1.1 LOCKED shape: PAYWALL_MODE matrix (`off`=all-on / `soft`=free tier, allowlisted testers *may purchase* (test mode) — entitlement still ONLY via a `trip_entitlements` row, so the buy path is exercised / `live`=paid). Grandfather rule: trip docs created pre-soft display fully (no watermark); any NEW pipeline run gates. Free tier = links-only + 8 stops | `src/lib/entitlements/entitlements.ts` (CHG), `src/lib/entitlements/resolver.ts`, `src/lib/pipeline/pipeline.ts`, `app/trip/[id]/page.tsx` | Sonnet·**high** (the gate matrix is the product's money logic) | Unit matrix all mode×user cells incl. grandfather; e2e: free paste of 12 links → 8 stops + overflow message |
| M3.6 | Watermark overlay + PNG export (offscreen 2× `renderToDisplay` → download; watermark stamped on free exports AND free display; engine untouched) | `src/ui/reveal/WatermarkOverlay.tsx`, `src/ui/reveal/ExportButton.tsx`, `src/ui/reveal/RevealMap.tsx` | Sonnet·medium | Free trip shows stamp; pass trip exports clean 2× PNG in <5s |
| M3.7 | Checkout + webhook: session w/ metadata + idempotency key; webhook = raw-body sig verify → `stripe_events` insert-or-skip → **synchronous** `fulfil_purchase()`; `charge.refunded` → status+decrement | `app/api/checkout/route.ts`, `app/api/webhooks/stripe/route.ts`, `src/lib/payments/{products,fulfil}.ts` | Sonnet·**high** (money path; brief's async-after-200 corrected) | `stripe trigger checkout.session.completed` ×2 → exactly 1 grant; junk sig → 400, nothing written |
| M3.8 | PaywallModal (3 triggers: >8 resolvable stops / text-only paste / export click) + soft-mode public CTA ("launching soon" + email capture row in Supabase) + post-purchase re-render without reload (`?payment=success` → poll entitlement → re-run pipeline) | `src/ui/reveal/PaywallModal.tsx`, `src/ui/reveal/RevealClient.tsx`, `src/ui/pipeline/usePipeline.ts` | Sonnet·medium (copy per design.md voice; Fable advisor spot-checks copy) | Each trigger fires on fixture; success poll flips watermark off without reload |
| M3.9 | Acceptance suite = the brief's checklist as tests + RLS bypass script | `e2e/paywall.spec.ts`, `scripts/rls-smoke.mjs` | Sonnet·medium + Haiku·low (script) | Playwright green (fixture, $0); script vs real project: all denials |
| M3.10 | Legal floor: ToS, privacy+PDPA, refunds — journal-styled, human-readable | `app/legal/{terms,privacy,refunds}/page.tsx` | Haiku·low draft, Chris reviews | Pages render; footer links; Chris sign-off |
| M3.11 | Fresh-context audit (spec = brief + design doc) → deploy `soft` → Chris test-mode purchase script into LIVE-CHECKLIST | — | Fable·high | Audit 0 blocking; prod in soft mode |

**Exit (CHRIS-VERIFY, on prod):** anonymous user = 8-stop watermarked free tier with working
paywall modal; Chris signs in (allowlisted), buys single pass with 4242 → credits 1→0, this trip
entitled, watermark gone, export works; duplicate webhook grants once; refund in Stripe dashboard
→ credits floor-0. **All future paid features are hereafter built gated.**
*(Parallel: M3.4∥M3.6 after M3.3; M3.7∥M3.8 different files; M3.10 anytime.)*

## M4 — B1c: SOCIAL-LINK EXTRACTION (research done 2026-07-12 — see
`docs/research/social-extraction-2026-07.md`; spike VERIFIES it live, then a gate)

Research verdict: captions are FREE on all three platforms right now (TikTok public oEmbed; IG
tokenless oEmbed since Meta's June-2026 reversal; YouTube Data API v3 within free quota). Paid
unified scraper (ScrapeCreators ~$10/5k or EnsembleData) only for comments + MP4 URLs. Frame
analysis = MP4 → ffmpeg frames → Claude vision, run on the **soupai VPS worker** (Vercel can't
host ffmpeg/yt-dlp). Three-tier design: caption (free) → scraper comments (cheap) → frames
(expensive, metered).

| id | Task | Files | Model·Effort | Acceptance |
|----|------|-------|--------------|------------|
| M4.1 | **Spike — verify the research live** (throwaway scripts): TikTok oEmbed caption, IG tokenless oEmbed caption, YT Data API description+comments, ONE scraper trial (ScrapeCreators or Apify free credit) for comments+MP4, one MP4→3-frames→Claude-vision run on the VPS. Against 10 real links per platform from Chris. Report: success %, fields, $/link, latency per tier. **GATE: Chris picks platforms + tiers (captions-only vs +comments vs +frames) for v1.** | `scripts/spike-social/` (gitignored) | Sonnet·**high** (adversarial: platforms fight this; endpoints flip-flop) | Report table in chat + STATE.md; Chris decision recorded |
| M4.2 | Spec: `interpret.social` flow — detect URL → tiered fetch per gate (captions server-side; comments via scraper key env-gated; frames via VPS worker endpoint) → LLM derives placeQueries (reuses M1 checkpoint, same 40 cap) → resolve; per-link budget cap + per-paste social-link cap (5) + per-user frame-tier meter; fixture strategy (canned caption fixtures, $0 tests) | `docs/superpowers/specs/<date>-social-extraction.md` | Fable·high (advisor) | Spec exists; Chris GO |
| M4.3 | Build per spec behind `interpret.social` | `src/lib/social/{detect,captions,frames}.ts` + `__tests__`, `app/api/social/extract/route.ts`, `src/lib/pipeline/pipeline.ts` | Sonnet·**high** (external-API fragility, spend caps) | Unit: fixture captions → expected queries; cap honored; free tier → paywall trigger not a spend |
| M4.4 | e2e (fixture captions) + fresh-context audit + gates | `e2e/` addition | Sonnet·medium / Fable·high | Green, $0; audit 0 blocking |

**Exit (CHRIS-VERIFY):** paste a real YouTube travel vlog link as a pass user → its places appear
as stops; TikTok/IG per gate decision; a dead/private link degrades to a friendly failure-panel
entry. Free user pasting a social link → paywall trigger, zero external spend.

## M5 — B2: SPLIT GROUPS (design-first — brainstorm is the entry gate)

| id | Task | Files | Model·Effort | Acceptance |
|----|------|-------|--------------|------------|
| M5.1 | Brainstorm with Chris (`superpowers:brainstorming`) → spec: braided per-day timeline (shared segment → {A,B} branches → convergence anchor → shared…), TripDoc additive schema (segments with groupId), parser `splitGroups` mapping, solver approach = each branch solved independently ABOVE the locked solver + shared stops planned once + convergence anchors as hard constraints; map = forked coloured overlay routes (palette-locked pen colours); sidebar A/B lanes; ambiguity rules (item with no group hint = shared). **Chris approves spec.** | `docs/superpowers/specs/<date>-split-groups.md` | Fable·high (advisor); Opus·high (schema design) | Spec + schema doc; Chris GO |
| M5.2 | Schema + assembly: `assembleTripDoc` keeps `splitGroups` → segments; additive types | `src/lib/store/types.ts`, `src/lib/pipeline/pipeline.ts` + tests | Sonnet·medium | Unit: "Group A/B" fixture paste → segmented TripDoc |
| M5.3 | Branch planning: per-branch solve + shared segments + convergence anchors. NOTE for the M5 auditor: `planService.ts`/`schedule.ts` were never on Chris's engine-lock list (that list = solver, map core/defaults, resolvePlaces — see the brief's "What NOT to Touch"); older spec wording that calls them LOCKED refers to their §2 behavior contract, which stays intact — changes here are additive branch orchestration ABOVE `solver.optimize` | `src/lib/planService.ts`, `src/lib/schedule/schedule.ts` + tests (solver.ts LOCKED — untouched) | Sonnet·**high** (constraint orchestration) | Golden test: braided fixture day → both branch plans respect the shared dinner anchor |
| M5.4 | Map forked routes: overlay paints per-branch route lines (distinct pens), diverge/merge at shared stops; engine core untouched | `src/ui/reveal/RevealMap.tsx` (overlay layer), possibly `src/lib/map/` NEW overlay helper (not core) | Sonnet·**high** (choreography-adjacent — re-read the choreoGen rules in STATE.md first) | Fixture braided day renders 2 coloured routes; reorder in one branch redraws only it |
| M5.5 | Sidebar A/B lanes + interactions (reorder within a branch; move stop between branches; day tabs unchanged) | `src/ui/reveal/JournalSidebar.tsx`, `src/ui/reveal/RevealClient.tsx` | Sonnet·**high** (dnd within lanes) | Keyboard + pointer reorder inside a lane works; axe 0 |
| M5.6 | e2e + fresh-context audit + gates | `e2e/split.spec.ts` | Sonnet·medium / Fable·high | Green; audit 0 blocking |

**Exit (CHRIS-VERIFY):** his real group-trip paste with "Group A/B" lines → braided day on prod:
forked coloured routes, A/B lanes, dinner reconvergence honored. Pass-gated (`maxStops`/tier per
M3 matrix; split itself ships pass-included per locked pricing).

## M6 — D5: MULTI-DAY PAGE-FLIP (small)

| id | Task | Files | Model·Effort | Acceptance |
|----|------|-------|--------------|------------|
| M6.1 | Page-turn transition between day tabs (one signature moment; reduced-motion = crossfade; sfx behind existing mute) | `src/ui/reveal/RevealClient.tsx`, `src/ui/reveal/reveal.css` | Sonnet·medium | Day switch animates; `prefers-reduced-motion` static; axe 0 |
| M6.2 | Swap placeholder ffmpeg-synthesized sfx for real CC0 foley (page-turn, scribble, pot-bubble) — carried over from D1 | `public/sfx/*` (new filenames — immutable cache) | Haiku·low | Sounds play; mute toggle still silences all |
| M6.3 | Gates + mini-audit (Opus fresh-context suffices — low-risk milestone) | — | Opus·xhigh (audit turn — depth is per-audit, not per-milestone-risk) | 0 blocking |

**Exit (CHRIS-VERIFY):** flipping days on his phone feels like a journal page turn.

## M7 — HARDENING + PAID VERIFICATION + FLIP (the launch gate)

| id | Task | Files | Model·Effort | Acceptance |
|----|------|-------|--------------|------------|
| M7.1 | Full sweep: entire e2e suite, Lighthouse ≥90 perf/a11y on landing+share, bundle-secret grep, `next build`, Sentry noise review | — | Sonnet·medium + Haiku·low (Lighthouse run) | All green; scores recorded in STATE.md |
| M7.2 | **Paid-feature verification script for Chris** — every pass promise exercised as a paying customer in soft mode: >8 stops, text-only paste, cross-date proposal, social link, split, export, watermark-off, credits math across single+bundle, refund. PLUS carried-over open items: LIVE-CHECKLIST §3 (real group-trip day sanity) + §4 (dropped-pin/coords-only share edge), the Phase-D draw-pace device verify if still unticked, mobile-landing composition review ("revisit post-MVP" — v1 IS the MVP) | `LIVE-CHECKLIST.md` §9 | Sonnet·medium (writes script), Chris (runs it) | Every line ticked by Chris personally |
| M7.3 | CHRIS-STEP: Stripe live keys + live webhook endpoint, custom SMTP for OTP (default quota is LOW — required before live), domain decision (tripsoup.com vs subdomain), statement descriptor "TRIPSOUP", Google+Anthropic+Supabase spend caps confirmed | — | Chris | Env live-ready; caps screenshot in STATE.md |
| M7.4 | FLIP `PAYWALL_MODE=live` → live smoke: ONE real SGD 6.90 purchase (Chris's card) → fulfil → refund via dashboard → revoke verified | — | Opus·xhigh orchestrates (irreversible money gate, never-skip class), Chris executes | Real money round-trip clean |
| M7.5 | Final whole-product fresh-context audit + STATE.md v1 declaration. Gate includes Chris's standing art call: Gracie scene art is still PROVISIONAL (his own polish item via Higgsfield web) — at M7 he either ships it or swaps sprites (drop-in format is FINAL, `<GracieScene>` unchanged) | — | Fable·high (Opus·xhigh substitute; never-skip class) | Verdict: v1 SHIP; Chris announces |

**Exit:** v1 public, payments live. *(M7 has no parallelism — it's a checklist, in order.)*

## M8 — v1.1: D4 LIVE LAYER (planned now, built after launch)

Scope per master-plan D4 with one redesign: share slugs were retired, so the live channel key
becomes a **per-trip random live-token minted for pass holders** (capability model, same spirit).
Mobile-first mandate (390px design-first). Sketch (full spec session at v1.1 kickoff):
- M8.1 `[fable·high]` spec: channel auth (`signInAnonymously()` for friend sockets), presence
  meta, broadcast shapes (`location_update` throttled 5s/25m, `readiness_*`, `gather_ping`,
  `itinerary_updated` rev-poke), revocation, reconnect/refetch, battery/privacy rules
  (foreground-only, ephemeral, never persisted).
- M8.2 `[sonnet·high]` realtime protocol + policies (Supabase private channels; CHRIS-STEP:
  enable anonymous sign-ins). M8.3 `[sonnet·medium]` live page UI (thumb-reach action bar, dots,
  READY stamp, gather banner). M8.4 `[sonnet·medium]` host adhoc edits broadcast.
- M8.5 two-context Playwright + `[fable·high]` audit incl. battery/privacy sign-off.

---

## EDGE CASES (each mapped to the task that owns it + the test that proves it)

| # | Edge case | Task | Proof |
|---|-----------|------|-------|
| 1 | Duplicate `checkout.session.completed` (Stripe retries) | M3.7 | stripe_events pk test: 2 events → 1 grant |
| 2 | Pay then close tab before redirect | M3.7/M3.8 | Webhook is sole truth; success page polls — e2e |
| 3 | Refund after credit already spent on a trip | M3.1/M3.7 | Decrement floor-0; entitlement stays (documented policy) — unit |
| 4 | Same user buys twice on one trip (`unique(user_id,trip_id)`) | M3.7 | Second spend on same trip = no-op, credit NOT burned — unit |
| 5 | Anonymous user's trip, then signs in at paywall | M3.5/M3.8 | Entitlement keyed user+trip at purchase; trip stays KV — e2e |
| 6 | Free user pastes 12 links (>8 but all links) | M3.5 | 8 stops + paywall trigger, 4 in overflow panel — e2e |
| 7 | Pre-M3 trips (created in `off` mode) viewed under `soft` | M3.5 | Grandfather rule in resolver spec: existing docs render fully but re-runs gate — unit matrix |
| 8 | OTP email in spam / rate-limited | M3.4 | Friendly retry copy; Supabase limits documented; CHRIS-STEP SMTP before live |
| 9 | Supabase captcha | M3.2 | NEVER enable before frontend token (memory gotcha) — checklist line |
| 10 | LLM marks a note ("wear comfy shoes") as a place | M1.4/M1.2 | placeQuery omitted for notes (prompt rule); unmatched → failure panel, never a pin — unit+e2e |
| 11 | 41+ placeable items | M1.4 | Links-first slice, overflow failures — unit |
| 12 | Same cafe on Day 1 and Day 2 | M1.4 | Query deduped (billed once), then per-day duplicate flagging as today — unit |
| 13 | "12 Jul" pasted in December (year boundary) | M1.5 | today-or-future rule → next year — unit |
| 14 | Paste with zero links AND zero recognisable places | M1.4 | "Nothing to place" journal-voice empty state, $0 spent — e2e |
| 15 | Big paste truncation (the 2026-07-10 prod bug) | M1.2 | llmAdapter streaming + 32k cap + fail-fast stays test-guarded — existing test must stay green |
| 16 | Proposal wants to move an anchored (timed) stop | M2.2 | Heuristic excludes anchored stops — unit |
| 17 | Accept proposal on a stale doc (edited elsewhere) | M2.3 | PUT rev check → friendly reload prompt — e2e |
| 18 | Private/deleted/geo-blocked social link | M4.3 | Failure-panel entry, no retry storm, spend cap intact — unit |
| 19 | Social caption in non-English | M4.2/M4.3 | LLM handles; placeQuery still disambiguated w/ region — fixture case |
| 20 | Free user pastes a social link | M4.3 | Paywall trigger fires BEFORE any external fetch ($0) — unit |
| 21 | Split item with no group hint | M5.1/M5.2 | Defaults to shared segment — unit |
| 22 | Group A has 1 stop, Group B has 9 | M5.3 | Branch solves independent; convergence still met — golden |
| 23 | Reorder inside branch A | M5.4/M5.5 | Only A's route re-sketches (choreoGen rules!) — e2e |
| 24 | Export on a map mid-choreography | M3.6 | Export renders from scene state, not mid-frame canvas — manual check in acceptance |
| 25 | Texture/asset changes | any UI task | New filenames only (immutable cache) — reviewer checklist line |
| 26 | Webhook arrives before user returns from Stripe | M3.8 | Success poll handles both orders — e2e |
| 27 | `PAYWALL_MODE` env typo/unset | M3.5 | Resolver defaults to `soft` (fail-closed, never accidentally free-for-all or live) — unit |

## RISK REGISTER

| Risk | L×I | Mitigation |
|------|-----|------------|
| Stripe SG live verification delays | M×M | Soft mode decouples build from go-live; M7.3 is the only blocked step; start Stripe onboarding at M3.2 |
| TikTok/IG caption endpoints flip-flop (Meta reversed once already) | M×M | Research verified free caption paths (2026-07); M4.1 re-verifies live before build; scraper tier is the standing fallback; per-link caps |
| Scraper ToS/legal exposure (M4) | M×M | Third-party API (their exposure), captions-only default, frames optional, Chris gates; revisit at scale |
| LLM cost blowout on interpretation | M×H | Double-gate (free tier never hits LLM), 20KB cap, rate limit, 40-lookup cap, Anthropic spend cap (CHRIS-STEP) |
| Map/choreography regression in M5.4 | M×H | Overlay-only changes; choreoGen rules re-read mandatory; real-motion temp checks; Fable/Opus review every diff touching RevealMap |
| Fable rate limits mid-run | H×L | Opus fresh-context is the standing substitute; advisor calls front-loaded |
| Free-tier backlash at flip | L×M | Eliminated by design: free tier enforced from M3 deploy (Chris's call) |
| Supabase free-tier limits at launch | L×M | Spend cap ON; usage review in M7.1; upgrade is a dial |
| Solo-channel email capture list unused | L×L | Soft-mode CTA emails exported at M7.4 → launch announcement |

## SAFETY INVARIANTS

- **Money:** webhook idempotent (replay-guard table); fulfilment transactional; no card data ever
  touches our servers (Stripe hosted); refunds only via Stripe dashboard by Chris (no API
  auto-refund path); `purchases` = immutable audit trail; live mode reachable only by explicit
  env flip.
- **Spend:** no code path sends arbitrary user text to a billed API — only extracted URLs,
  LLM-flagged placeQueries, and (M4) platform captions within per-link caps; free tier spends $0
  on LLM parse and $0 on social fetches.
- **PII:** pasted itineraries scrubbed from Sentry; OTP emails only in Supabase auth; PDPA page;
  (v1.1) location broadcasts ephemeral, never persisted.
- **Data:** trips never deleted by code; entitlements never revoked by code except refund path
  defined in M3.1; migrations additive.
- **Process:** engine-LOCKED files untouchable without Chris's written unlock; gates + fresh
  audit before every merge; main deploys only on Chris GO.

---

PLAN QUALITY BAR (non-negotiable — the PLAN.md is rejected if any are missing):
1. GOAL: restate the product goal in 3 sentences at the top, plus explicit
   NON-GOALS for v1.
2. FILE TREE: the complete repository file tree for the finished v1, every
   file annotated with one line of purpose. Every task in the DAG lists the
   EXACT paths it creates or modifies; no task may say "various files".
3. ORDER: tasks numbered in strict execution order within each milestone,
   dependencies stated by task id; parallelizable tasks explicitly marked
   (no overlapping file paths between parallel tasks).
4. EDGE CASES: a dedicated section listing every edge case and pitfall from
   this prompt PLUS any found during Phase 0/codebase exploration, each
   mapped to the task id that handles it and the test that proves it.
5. ACCEPTANCE: every task ends with a concrete acceptance check runnable by
   a human in under 2 minutes (exact command to run or exact click-path,
   plus the expected observable result). Every milestone ends with a
   scripted end-to-end verification the user performs personally before the
   next milestone starts.
6. MODEL + EFFORT: every task in the DAG carries a model tier
   (Opus/Sonnet/Haiku) AND an effort level. Defaults: Haiku=low,
   Sonnet=medium, Opus design/review=high. Never Haiku above low — promote
   the task to Sonnet instead. Justify deviations inline.
