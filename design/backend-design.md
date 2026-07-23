# backend-design.md — TripSoup payments/auth binding design contract

- **Status:** §0 skeleton landed at **M0.1** (2026-07-14). §1+ (full DDL, RLS SQL, transactional
  function semantics, failure-mode table, allowlist matrix) are authored and audited at **M3.1**
  (Fable advisor + independent Opus·xhigh security audit) — do NOT build payments against this doc
  until §1+ is complete and Chris has done the layman walkthrough.
- **Ground truth this doc must not contradict:** `PLAN-V1.md` (LOCKED facts), the payments contract
  `docs/briefs/d3-payments-auth-brief.md` (verbatim brief + orchestrator amendments), `design.md`
  (voice/anti-generic law). Where this doc and the brief disagree, the brief's **amendments header**
  wins (synchronous webhook, email OTP, `stripe_events` replay guard, atomic grant+spend).

---

## §0 — PAYWALL_MODE, tester allowlist, soft-mode UX copy skeleton

### §0.1 PAYWALL_MODE — the three-state server flag

`PAYWALL_MODE` is a **server-only** env var read by the entitlements resolver (`resolver.ts`, ships
M3.5, wired to prod at the M3.11 soft deploy). It is never sent to the client and never read outside
the resolver. Three values:

| Value | Meaning | Who sets it, when |
|-------|---------|-------------------|
| `off` | Everything enabled for everyone, no paywall UI. Today's pre-M3 behavior (no resolver exists yet). **Explicit only** — a dev/legacy escape hatch. No task in this plan ever sets `off` in prod. | Local dev only |
| `soft` | **Free tier enforced for everyone.** Paywall modal live. Stripe runs **TEST** mode. Only allowlisted tester emails (`TESTER_EMAILS`) can complete a purchase (test card). Public CTA shows "Trip Passes launching soon" + email capture. | Set at **M3.11** deploy; stays until M7 |
| `live` | Real Stripe. Everyone can buy. | Flipped by **Chris's hand only at M7.4** |

**Fail-closed default (LOCKED, edge case #27):** if `PAYWALL_MODE` is **unset or a typo**, the
resolver treats it as **`soft`**. Rationale: an unset flag must never accidentally become
free-for-all (`off`) or charge real money (`live`). `off` therefore requires the exact literal
string `off`; anything else → `soft`.

```
PAYWALL_MODE resolution (resolver.ts, pseudocode):
  const raw = process.env.PAYWALL_MODE
  const mode = raw === "off" ? "off" : raw === "live" ? "live" : "soft"   // fail-closed
```

### §0.2 Tester allowlist — `TESTER_EMAILS`

- `TESTER_EMAILS` = comma-separated, lowercased, server-only env var (e.g. `chrisyou2012@gmail.com`).
- Meaning in `soft` mode: an allowlisted, signed-in email **may complete a Stripe TEST-mode
  purchase**. It does **NOT** grant entitlement by itself — entitlement is still ONLY conferred by a
  real `trip_entitlements` row written by the webhook's `fulfil_purchase()`. This is deliberate: the
  allowlist exists so Chris exercises the **full buy path** (checkout → webhook → grant → spend)
  before real customers do, not so testers get a free bypass.
- In `off` mode the allowlist is ignored (everyone is all-on). In `live` mode the allowlist is
  ignored (everyone can buy).
- Parsing must be forgiving: trim whitespace, lowercase both sides, ignore empty entries.

```
isTester(email): TESTER_EMAILS split on "," → map(trim→lowercase) → includes(email.toLowerCase())
```

### §0.3 Entitlement resolution matrix (skeleton — full cell table binds at M3.5/M3.1)

| PAYWALL_MODE | anon user | signed-in, no entitlement | signed-in, has `trip_entitlements` row | allowlisted tester (soft) |
|--------------|-----------|---------------------------|----------------------------------------|---------------------------|
| `off` | pass (all-on) | pass (all-on) | pass | pass |
| `soft` | free tier | free tier | **pass** (entitled) | free tier **+ may purchase** (test mode) |
| `live` | free tier | free tier | **pass** (entitled) | (n/a — everyone may purchase) |

**Grandfather rule (LOCKED, edge case #7):** a TripDoc created in `off` mode (pre-soft) **displays
fully** (no watermark, all stops) when later viewed under `soft`/`live`. But any **new pipeline run**
gates per the matrix above. Resolver distinguishes "render an existing doc" from "run the pipeline".

### §0.4 Soft-mode UX copy skeleton (SKELETON — final journal-voice copy set with Fable advisor at M3.8)

All copy honors `design.md` voice: warm, first-person journal voice, Gracie's world, never
corporate-SaaS. Pine `--action` is the only functional accent; `--soup` orange never on buttons.
These are **placeholders to be finalized at M3.8** (PaywallModal) — recorded here so the intent is
locked even if wording changes.

- **Public CTA (non-tester, soft mode) — "launching soon" + email capture:**
  - Heading: *"Trip Passes are almost here."*
  - Body: *"I'm putting the finishing touches on the paid bits — bigger trips, plain-text pastes,
    clean exports. Want a nudge when they open up?"*
  - Field: email input, journal-underline style. Button label: *"Keep me posted"* (pine action).
  - On submit → row into a `soft_mode_signups` capture (email + created_at); confirmation:
    *"Lovely — I'll write when it's ready."* Exported at M7.4 for the launch announcement.

- **Paywall modal (the three triggers — >8 stops / text-only paste / export click):**
  - Trigger copy leads with what the traveller was *trying* to do, then the gentle wall. e.g.
    >8 stops: *"That's a big adventure — free trips hold 8 stops. A Trip Pass opens it up to 40."*
  - Free-tier framing is never punitive: *"Your first 8 are on me."*
  - Primary CTA (allowlisted tester, soft): *"Get a Trip Pass — SGD 6.90"* (pine). Bundles shown as
    a quiet secondary row (×3 SGD 15.90 / ×5 SGD 24.90).
  - Gracie present per design.md (style C), holding a little paper ticket. Anti-generic law applies.

- **Overflow panel (free user, >8 resolvable stops):** the 8 placed, the rest listed under
  *"Waiting in the wings"* with the pass nudge — never silently dropped.

- **Soft-mode banner slot (`app/page.tsx`):** unobtrusive top strip, dismissable:
  *"TripSoup is in open beta — everything you see is free while I finish the paid features."*

---

## §1+ — RESERVED FOR M3.1 (do not fill at M0)

The following bind at **M3.1** under the Fable advisor + independent Opus·xhigh security audit, per
PLAN-V1.md M3.1. Listed here as the required table of contents so M3.1 has a target shape:

- **§1 Full DDL** — brief's 3 tables (`trip_credits`, `purchases`, `trip_entitlements`) **+
  `stripe_events(id text primary key)` replay-guard** **+ `redemption_codes` stub table** (gift
  phase-2 concept stubbed, no logic) **+ `soft_mode_signups`** (email capture).
- **§2 RLS SQL** — deny-by-default; `select own row only`; all INSERT/UPDATE server-role only.
- **§3 Transactional functions** — `fulfil_purchase()` (grant N credits AND atomically spend 1 on
  the originating trip: `trip_entitlements` insert + `trip_credits` decrement in one txn) and
  `spend_credit()`. Refund path decrements credits floor-0 but **never un-entitles an already-spent
  trip** (documented policy, edge case #3).
- **§4 Failure-mode table** — replay (dup `checkout.session.completed`), junk signature, pay-then-
  close-tab, RLS bypass attempt, OTP rate-limit, `unique(user_id,trip_id)` double-spend no-op.
- **§5 Allowlist × mode matrix** — the full cell expansion of §0.3, every mode×user state.
