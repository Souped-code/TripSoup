// The gate-ability boundary (M1.1) — the ONE place that answers "who can do
// what". Every gated capability in the product asks this module and nothing
// else; no caller ever reads a tier string, an env var, or a database row to
// decide what a user may do.
//
// THE SHAPE BELOW IS LOCKED (PLAN-V1 §M1.1). It reconciles the interpretation
// spec's capability model (§4.1) with the D3 brief's tier fields, decided once
// here so M3 never has to reshape it. M3.5 replaces the *source* of these
// values (Supabase entitlement rows + PAYWALL_MODE) — never the shape. That is
// the whole point: when payments land, nothing outside this directory changes.
//
// Callers may use ONLY `.has(cap)`, `.maxStops`, `.watermark` (and `.tier` for
// display copy). Do not add behaviour here that a caller could branch on
// instead of asking a capability.

export type Capability =
  // Resolve Maps URLs -> places. Free, always on: a pasted link is an explicit,
  // bounded, user-supplied target, and this is the product's core promise.
  | "resolve.links"
  // Geocode place NAMES lifted from free text (M1's headline feature). Gated
  // because arbitrary text can fan out into unbounded billed Places lookups —
  // this capability IS the cost boundary, consulted at BOTH the parse-adapter
  // choice and the resolve checkpoint (see the two-consult rule in spec §4.1).
  | "interpret.names"
  // FUTURE (M4): extract places from TikTok/IG/YouTube links. Reserved now so
  // that work slots in without reopening this boundary. Nothing reads it yet.
  | "interpret.social"
  // FUTURE (M2): cross-date "propose a smoother move" suggestions. Reserved.
  | "suggest.crossDate"
  // FUTURE (M3.6): high-resolution, watermark-free PNG export.
  | "export.hires";

export type Tier = "free" | "pass";

export interface Entitlements {
  /** Display/copy only — never branch product behaviour on this; ask `has()`. */
  readonly tier: Tier;
  has(cap: Capability): boolean;
  /** Hard ceiling on stops the pipeline will resolve+plan for this user. */
  readonly maxStops: number;
  /** Whether rendered maps and exports carry the free-tier stamp. */
  readonly watermark: boolean;
}

export type EntitlementsSpec = {
  tier: Tier;
  capabilities: readonly Capability[];
  maxStops: number;
  watermark: boolean;
};

/**
 * Build an Entitlements from a plain spec. This is the only constructor —
 * the stub below and M3.5's real resolver both go through it, so there is
 * exactly one implementation of `has()` in the codebase.
 *
 * The capability list is copied into a Set at construction: callers hold the
 * returned object across a whole pipeline run, and a mid-run mutation of the
 * caller's array must not be able to change what is entitled halfway through.
 */
export function createEntitlements(spec: EntitlementsSpec): Entitlements {
  const granted = new Set<Capability>(spec.capabilities);
  return {
    tier: spec.tier,
    has: (cap: Capability): boolean => granted.has(cap),
    maxStops: spec.maxStops,
    watermark: spec.watermark,
  };
}

// Every capability, in declaration order. Exported so a test can assert the
// stub really is all-on without restating the list (a new capability added
// above must not silently default to "off" in the pre-M3 stub).
export const ALL_CAPABILITIES: readonly Capability[] = [
  "resolve.links",
  "interpret.names",
  "interpret.social",
  "suggest.crossDate",
  "export.hires",
];

// The combined links+names spend cap the pipeline enforces per paste. Lives
// here (not in pipeline.ts) because it is an entitlement value: M3.5's free
// tier lowers it to 8 by returning a different `maxStops`, without touching
// the checkpoint that reads it.
export const STUB_MAX_STOPS = 40;

/**
 * Pre-M3 stub: everything enabled, pass-tier limits, no watermark.
 *
 * M3.5 replaces this body with the real resolver (session -> Supabase
 * entitlement row -> PAYWALL_MODE matrix) behind the identical signature.
 * Until then all capabilities ship on, exactly as the interpretation spec
 * §10 and PLAN-V1 M1.1 specify — the gates are built and exercised now so
 * that flipping them at M3 is a source change, not a rewrite.
 */
export function getEntitlements(/* session?: Session — added at M3.5 */): Entitlements {
  return createEntitlements({
    tier: "pass",
    capabilities: ALL_CAPABILITIES,
    maxStops: STUB_MAX_STOPS,
    watermark: false,
  });
}
