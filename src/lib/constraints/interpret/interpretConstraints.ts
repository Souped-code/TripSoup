// E7 — the constraint compile orchestrator: gated adapter selection (the
// parseItinerary pattern), then the SAFETY LAYER every adapter's output goes
// through before it can touch a doc:
//
//   1. THE HALLUCINATION TETHER — an emission whose `evidence` is not a
//      verbatim (whitespace/case-normalized) substring of the user's text is
//      DROPPED. The model is told this; here it is enforced in data.
//   2. STOP RESOLUTION — `stopName` resolves against the doc's real stops
//      (normalized containment, either direction); unresolved emissions drop.
//      A resolved name applies to EVERY occurrence of that stop (a cross-day
//      repeat visit gets the same constraint on each occurrence key).
//   3. WIRE CONVERSION — emissions become an E2 ConstraintPatch with
//      provenance { source: "llm", confirmed: false, evidence } and SOFT
//      hardness (LLM_SOFT_WEIGHT): everything an LLM asserts enters
//      soft-until-confirmed; a chip confirm is what promotes it.
//
// Failure of any kind returns null — a compile can never block a cook or a
// save. The caller merges the returned patch via mergeStoredPatches (so a
// re-compile updates old llm entries but never displaces a user's).

import { getEntitlements, type Entitlements } from "../../entitlements/entitlements";
import type { TripDoc } from "../../store/types";
import type { WeeklyHours } from "../types";
import type {
  ConstraintPatch,
  ListConstraint,
  StopConstraintsPatch,
  Window,
} from "../types";
import { stopKeys } from "../compile";
import { LLM_SOFT_WEIGHT, LLM_WINDOW_WEIGHT, sanitizeConstraintPatch } from "../persisted";
import { createFixtureConstraintsAdapter } from "./fixtureConstraintsAdapter";
import type { CompileContext, ConstraintCompileProvider, ConstraintEmission } from "./types";

function fixtureMapsInPlay(): boolean {
  return process.env.MAPS_PROVIDER === "fixture" || !process.env.GOOGLE_MAPS_API_KEY;
}

/** Mirror of getParseProvider's two-gate selection. Null = the feature is off
 * for this caller (no capability, or a live-money configuration without an
 * explicit CONSTRAINTS_PROVIDER=llm opt-in). */
function getCompileProvider(entitlements: Entitlements): ConstraintCompileProvider | null {
  if (!entitlements.has("interpret.constraints")) return null;

  const wantsLlm = process.env.CONSTRAINTS_PROVIDER === "llm";
  if (wantsLlm && process.env.ANTHROPIC_API_KEY) {
    // Lazy import keeps @anthropic-ai/sdk out of bundles that never use it —
    // and keeps the adapter-guard test's "no test imports the real adapter"
    // claim meaningful.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createLlmConstraintsAdapter } =
      require("./llmConstraintsAdapter") as typeof import("./llmConstraintsAdapter");
    return createLlmConstraintsAdapter();
  }
  if (fixtureMapsInPlay()) return createFixtureConstraintsAdapter();
  return null;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

const ALL_OPEN: ReadonlyArray<ReadonlyArray<Window>> = Array.from({ length: 7 }, () => [
  { startMin: 0, endMin: 1440 },
]);

/**
 * Compile the user's text into a sanitized ConstraintPatch, or null when the
 * feature is off / the adapter failed / nothing survived validation.
 */
export async function compileConstraintPatch(
  text: string,
  doc: TripDoc,
  entitlements: Entitlements = getEntitlements()
): Promise<ConstraintPatch | null> {
  if (text.trim() === "") return null;
  const provider = getCompileProvider(entitlements);
  if (!provider) return null;

  const keys = stopKeys(doc);
  const stops: Array<{ name: string; dayIndex: number }> = [];
  const keysByNormName = new Map<string, string[]>();
  const stopByKey = new Map<string, TripDoc["days"][number]["stops"][number]>();
  doc.days.forEach((day, dayIndex) => {
    day.stops.forEach((stop, stopIdx) => {
      stops.push({ name: stop.name, dayIndex });
      const key = keys[dayIndex][stopIdx];
      stopByKey.set(key, stop);
      const n = norm(stop.name);
      keysByNormName.set(n, [...(keysByNormName.get(n) ?? []), key]);
    });
  });

  let emissions;
  try {
    emissions = await provider.compile(text, { stops, dayCount: doc.days.length });
  } catch {
    return null; // a compile failure never blocks anything
  }

  const textNorm = norm(text);
  const tethered = emissions.constraints.filter((e) => textNorm.includes(norm(e.evidence)));

  /** Occurrence keys for an emitted stopName: exact normalized name first,
   * then containment either way. Empty = the emission drops. */
  const resolveKeys = (stopName: string): string[] => {
    const n = norm(stopName);
    const exact = keysByNormName.get(n);
    if (exact) return exact;
    const out: string[] = [];
    for (const [candidate, candidateKeys] of keysByNormName.entries()) {
      if (candidate.includes(n) || n.includes(candidate)) out.push(...candidateKeys);
    }
    return out;
  };

  const llm = (evidence: string, weight: number = LLM_SOFT_WEIGHT) => ({
    provenance: { source: "llm" as const, confirmed: false, evidence },
    hardness: { soft: { weight } },
  });

  const stopPatches: Record<string, StopConstraintsPatch> = {};
  const patchFor = (key: string): StopConstraintsPatch => (stopPatches[key] ??= {});
  let tripPatch: ConstraintPatch["trip"];
  const quietBlocks: ListConstraint<Window>[] = [];

  const applyEmission = (e: ConstraintEmission): void => {
    switch (e.kind) {
      case "pace": {
        tripPatch = {
          ...(tripPatch ?? {}),
          pacePreset: { value: e.preset, ...llm(e.evidence) },
        };
        return;
      }
      case "stopWindow": {
        if (e.endMin < e.startMin) return;
        for (const key of resolveKeys(e.stopName)) {
          patchFor(key).window = { value: { startMin: e.startMin, endMin: e.endMin }, ...llm(e.evidence, LLM_WINDOW_WEIGHT) };
        }
        return;
      }
      case "lastEntry": {
        for (const key of resolveKeys(e.stopName)) {
          // Build the hours VALUE from the stop's real (Google) hours when it
          // has them, so a later confirm doesn't replace real opening hours
          // with an invented all-open week — the constraint ADDS lastEntry to
          // what the world already said.
          const existing = stopByKey.get(key)?.hours;
          const value: WeeklyHours = {
            byWeekday: existing?.byWeekday ?? ALL_OPEN,
            ...(existing?.closedDates ? { closedDates: existing.closedDates } : {}),
            lastEntryMin: e.lastEntryMin,
          };
          patchFor(key).hours = { value, ...llm(e.evidence) };
        }
        return;
      }
      case "duration": {
        if (!(e.minMin <= e.typicalMin && e.typicalMin <= e.maxMin)) return;
        for (const key of resolveKeys(e.stopName)) {
          patchFor(key).duration = {
            value: { minMin: e.minMin, typicalMin: e.typicalMin, maxMin: e.maxMin },
            ...llm(e.evidence),
          };
        }
        return;
      }
      case "priority": {
        for (const key of resolveKeys(e.stopName)) {
          patchFor(key).priority = { value: e.priority, ...llm(e.evidence) };
        }
        return;
      }
      case "pinnedDay": {
        if (e.dayIndex >= doc.days.length) return;
        for (const key of resolveKeys(e.stopName)) {
          patchFor(key).pinnedDay = { value: { index: e.dayIndex }, ...llm(e.evidence, LLM_WINDOW_WEIGHT) };
        }
        return;
      }
      case "quietBlock": {
        if (e.endMin < e.startMin) return;
        quietBlocks.push({
          id: `quiet:${e.startMin}-${e.endMin}`,
          value: { startMin: e.startMin, endMin: e.endMin },
          ...llm(e.evidence),
        });
        return;
      }
    }
  };
  for (const e of tethered) applyEmission(e);

  if (quietBlocks.length > 0) {
    tripPatch = { ...(tripPatch ?? {}), party: { quietBlocks } };
  }

  const raw: ConstraintPatch = {
    ...(Object.keys(stopPatches).length > 0 ? { stops: stopPatches } : {}),
    ...(tripPatch ? { trip: tripPatch } : {}),
  };

  // The same sanitizer the PUT boundary runs — one canonical form everywhere.
  const sane = sanitizeConstraintPatch(raw, doc);
  if (!sane || Object.keys(sane).length === 0) return null;
  return sane;
}
