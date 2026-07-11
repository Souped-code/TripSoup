# D3 — Payments & Auth Implementation Brief (Chris, 2026-07-11)

> Chris's brief, saved verbatim below. **Chris-decided amendments (2026-07-11, AskUserQuestion):**
> 1. **This brief SUPERSEDES the master plan's D3** (pay-to-share single pass, trips-in-Supabase,
>    claim tokens, share slugs — all retired). Share stays free; monetization = capacity/features.
> 2. **Auth = email OTP (6-digit), NOT magic link** — the master plan's locked mobile rationale
>    stands (a magic link opens in the email app's browser and strands the session/purchase intent
>    mid-checkout). Passwordless intent of the brief preserved; `/api/auth/callback` becomes an
>    OTP verify flow instead.
> 3. **Sequencing: B1 (itinerary interpretation) ships BEFORE D3**, so the `interpretNames`
>    entitlement gates a feature that actually exists at launch.
>
> **Orchestrator corrections flagged at intake (to resolve in D3.0 design, not silently):**
> - Webhook "return 200 immediately, process async" is unsafe on Vercel serverless (post-response
>   work is not guaranteed to run). Process synchronously in the handler (Stripe tolerates it);
>   idempotency via a `stripe_events(id text pk)` replay-guard table (add to schema).
> - Credit SPEND semantics are unspecified: purchase from a trip's paywall should grant N credits
>   and atomically spend 1 on that trip (entitlement insert + decrement in one transaction).
> - `exportHighRes` presupposes an export feature that doesn't exist yet — D3 includes a minimal
>   PNG export (offscreen 2× render of the existing canvas + download) or the gate is inert.
> - Free maxStops=8 vs the existing global 40-link pipeline cap: both enforced; entitlements
>   checkpoint in the pipeline is the single gating point per the brief.

---

## Brief (verbatim)

**For:** Claude Code / Engineering agent
**Stack:** Next.js 15 App Router · Supabase · Stripe · TypeScript
**Status:** Not started. Entitlements stub exists in pipeline. Engine is LOCKED — no changes to solver, map, or parse adapters.

### Overview
Wire up one-time Trip Pass payments (SGD 6.90) using Supabase (auth + lightweight user record) and Stripe (one-time payment, no subscription). Fill the existing entitlements stub in the pipeline so gated features (full stop count, text input, export) activate on purchase.
No subscriptions. Per-trip model only.

### Pricing Structure to Implement

| Product | Price (SGD) | Stripe price type |
|---|---|---|
| Single Trip Pass | 6.90 | one_time |
| 3-Trip Bundle | 15.90 | one_time |
| 5-Trip Bundle | 24.90 | one_time |

Gift purchases: A buyer can purchase a bundle and receive a redeemable code to share. Implement as a simple redemption code tied to a credit balance on the recipient's account. (Phase 2 — stub the concept, don't block on it.)

### Supabase Setup

Tables:

```sql
-- Users (Supabase auth handles identity)
-- No custom users table needed initially — use auth.users directly
-- Trip passes / credits per user
create table trip_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  credits_remaining int not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
-- Purchase history (audit trail)
create table purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  stripe_session_id text unique not null,
  stripe_payment_intent text,
  product_type text not null, -- 'single' | 'bundle_3' | 'bundle_5'
  credits_granted int not null,
  amount_sgd numeric(6,2) not null,
  status text not null default 'pending', -- 'pending' | 'completed' | 'refunded'
  created_at timestamptz default now()
);
-- Trip-level entitlement record (which trips a user has "spent" a pass on)
create table trip_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  trip_id text not null, -- TripDoc.tripId
  granted_at timestamptz default now(),
  unique(user_id, trip_id)
);
```

RLS Policies:
- trip_credits: user can SELECT own row only; no direct INSERT/UPDATE from client (server-only via service role)
- purchases: user can SELECT own rows; INSERT server-only
- trip_entitlements: user can SELECT own rows; INSERT server-only

### Auth
- Magic link (passwordless email) only for v1 — no OAuth complexity *(amended: email OTP, see header)*
- Supabase @supabase/ssr for Next.js App Router cookie handling
- Session available server-side in API routes via createServerClient

### Stripe Setup

Products & Prices — create three one-time prices in Stripe dashboard (or via CLI):
- trip_pass_single — SGD 6.90
- trip_pass_bundle_3 — SGD 15.90
- trip_pass_bundle_5 — SGD 24.90

Store price IDs in env:

```
STRIPE_PRICE_SINGLE=price_xxx
STRIPE_PRICE_BUNDLE_3=price_xxx
STRIPE_PRICE_BUNDLE_5=price_xxx
STRIPE_SECRET_KEY=sk_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
```

Checkout Flow:
1. User hits paywall → clicks "Get Trip Pass"
2. POST /api/checkout → creates Stripe Checkout Session (hosted), passes user_id and product_type in metadata
3. Redirect to Stripe hosted checkout
4. On success → Stripe redirects to /trip/[id]?payment=success
5. Webhook confirms payment → grants credits

Webhook (/api/webhooks/stripe):
- Verify signature with STRIPE_WEBHOOK_SECRET
- Handle checkout.session.completed:
  - Look up user_id + product_type from session.metadata
  - Determine credits to grant: single=1, bundle_3=3, bundle_5=5
  - Upsert trip_credits, insert purchases (status=completed), insert trip_entitlements for the current trip
- Handle charge.refunded: set purchase status=refunded, decrement credits (floor 0)
- Return 200 immediately, process async *(amended: synchronous processing, see header)*
- Webhook must be idempotent — duplicate checkout.session.completed must not double-grant

### Entitlements Module

Create src/lib/entitlements.ts (pure, no React, server-safe):

```ts
export type EntitlementTier = 'free' | 'pass';
export interface Entitlements {
  tier: EntitlementTier;
  maxStops: number;
  interpretNames: boolean;   // free-text/plain-name input
  exportHighRes: boolean;    // PNG/PDF export
  watermark: boolean;
  tripId?: string;
}
export const FREE_LIMITS: Entitlements = {
  tier: 'free',
  maxStops: 8,
  interpretNames: false,
  exportHighRes: false,
  watermark: true,
};
export const PASS_LIMITS: Entitlements = {
  tier: 'pass',
  maxStops: 40,
  interpretNames: true,
  exportHighRes: true,
  watermark: false,
};
// Server-only: resolve entitlements for a user+trip
export async function resolveEntitlements(
  userId: string | null,
  tripId: string
): Promise<Entitlements> {
  if (!userId) return { ...FREE_LIMITS };
  // Check trip_entitlements table via Supabase service client
  // If row exists → PASS_LIMITS; else → FREE_LIMITS
}
```

### Pipeline Integration
In pipeline.ts → runPipeline(text, entitlements: Entitlements):
- Cap stop assembly at entitlements.maxStops
- Gate interpretNames adapter call behind entitlements.interpretNames
- Pass watermark flag to map render

This is the one checkpoint — all gating happens here, nothing in the engine itself.

### UI Touch Points

Paywall Modal — trigger when:
- Free user pastes input with >8 resolvable stops, OR
- Free user attempts text-only input (no Maps links), OR
- Free user clicks "Export" or "Remove Watermark"

Post-Purchase:
- /trip/[id]?payment=success → show success toast, re-run pipeline with pass entitlements
- No page reload if pipeline result already rendered — re-render with watermark removed

Account State (minimal v1):
- Top-right: "Sign in" (unauthenticated) → "N trips remaining" (authenticated)
- No full account dashboard in v1 — credit count only

### Environment Variables (add to Vercel)

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_SINGLE=
STRIPE_PRICE_BUNDLE_3=
STRIPE_PRICE_BUNDLE_5=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
```

### Files to Create / Modify

| File | Action |
|---|---|
| src/lib/entitlements.ts | Create — entitlements types + resolver |
| src/lib/supabase/server.ts | Create — server Supabase client (SSR) |
| src/lib/supabase/client.ts | Create — browser Supabase client |
| app/api/checkout/route.ts | Create — Stripe checkout session |
| app/api/webhooks/stripe/route.ts | Create — webhook handler |
| app/api/auth/callback/route.ts | Create — Supabase magic link callback *(amended: OTP verify)* |
| pipeline.ts | Modify — accept + apply entitlements param |
| app/trip/[id]/page.tsx | Modify — resolve entitlements server-side, pass to client |
| src/ui/reveal/PaywallModal.tsx | Create — paywall UI (see brand_voice doc for copy) |
| src/ui/layout/AuthButton.tsx | Create — sign in / credit count header widget |

### What NOT to Touch
- solver.ts — LOCKED
- map-style-defaults.mjs — LOCKED
- map-render-core.js — LOCKED (watermark = overlay, not engine change)
- resolvePlaces.ts — no changes; 40-cap stays
- Any existing test fixtures

### Acceptance Criteria
- [ ] Unauthenticated user sees free experience (8 stops, watermarked map)
- [ ] Paywall modal triggers correctly on all three gates (stop count, text input, export)
- [ ] Stripe Checkout completes and webhook grants credits
- [ ] trip_entitlements row created; pipeline re-runs with PASS_LIMITS
- [ ] Watermark removed, full stops rendered, export enabled post-purchase
- [ ] Magic link sign-in works; session persists across page refreshes *(amended: OTP)*
- [ ] No real API spend in test/CI (fixture mode unaffected)
- [ ] Webhook idempotent — duplicate events do not double-grant credits
