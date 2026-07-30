// D2.2 backend spine — pure orchestration, no HTTP/React/Next imports here.
// Turns pasted itinerary text into a persisted TripDoc + computed DayPlans,
// reporting progress as an async generator so a later SSE route (separate
// follow-up, NOT built here) can stream it to the browser.
//
// Stage weights (of the overall 0..100 pct):
//   parse   0  -> 15
//   resolve 15 -> 55  (40 points)
//   matrix  55 -> 85  (30 points, split across days)
//   solve   85 -> 100 (15 points, split across days)
// matrix+solve are interleaved per day below (each day's matrix tick then
// solve tick), but together they always span 55 -> 100.

import { randomBytes } from "crypto";
import { parseItinerary } from "../parse/parseItinerary";
import { getMapsProvider, getTripStore } from "../config";
import { getEntitlements, type Entitlements } from "../entitlements/entitlements";
import { planTripDay } from "../planService";
import type { TripDoc, TripDay, TripStop } from "../store/types";
import type { DayPlan } from "../schedule/types";
import type { Failure, Stop } from "../../../resolvePlaces";

export type PipelineStage = "parse" | "resolve" | "matrix" | "solve";

export type PipelineProgress = { stage: PipelineStage; pct: number; detail: string };

export type PipelineResult =
  | { status: "ok"; tripId: string; doc: TripDoc; plans: DayPlan[]; failures: Failure[] }
  | { status: "error"; stage: PipelineStage; message: string };

// Matches app/api/trips/route.ts's TripDay defaults exactly.
const DAY_START_MIN = 540;
const DAY_END_MIN = 1320;

// Parses timeHint strings the parse adapters produce (heuristic today; llm
// later) into minutes-from-midnight. Handles both am/pm ("2pm", "2:30pm",
// "9am") and 24h ("14:00") shapes. Unparseable input -> null, never throws —
// callers must treat a null as "skip the anchor", not a fatal error.
export function parseTimeHint(raw: string): number | null {
  const s = raw.trim().toLowerCase();

  const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (ampm) {
    let hour = parseInt(ampm[1], 10);
    const min = ampm[2] ? parseInt(ampm[2], 10) : 0;
    if (hour < 1 || hour > 12 || min > 59) return null;
    const meridiem = ampm[3];
    if (meridiem === "am") {
      if (hour === 12) hour = 0;
    } else if (hour !== 12) {
      hour += 12;
    }
    return hour * 60 + min;
  }

  const h24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const hour = parseInt(h24[1], 10);
    const min = parseInt(h24[2], 10);
    if (hour > 23 || min > 59) return null;
    return hour * 60 + min;
  }

  return null;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// "day 1:" -> "Day 1"; "  saturday " -> "Saturday". Display polish only — the
// label is never parsed downstream, it is printed as the day heading.
function cleanLabel(hint: string): string {
  const trimmed = hint.trim().replace(/[:\-–—]\s*$/, "").replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
}

/**
 * M1.5 — turn a day's `dateHint` into either a REAL calendar date or a human
 * label, and never anything in between. Pure and deterministic: `refToday`
 * (ISO yyyy-mm-dd) is injected rather than read from a clock so this is unit
 * testable and a pipeline run is reproducible.
 *
 * - An explicit day+month (± year) — "12 Jul", "15 March 2026", "Jul 12" —
 *   becomes a real ISO `date` with NO label. Year, when unstated, is inferred:
 *   this year if that month/day is still today-or-future, otherwise next year.
 * - Anything else — "Day 2", a bare weekday, or no hint at all — sets `date` to
 *   `refToday` as an INERT placeholder and returns a `dayLabel` instead.
 *
 * On the placeholder: nothing schedules on `date`. All schedule math runs in
 * minutes-from-midnight (`dayStartMin`/`dayEndMin`), so `date` is display-only
 * — and whenever it is a placeholder a `dayLabel` exists and the UI renders
 * that instead. This is the fix for the old bug where every day was stamped
 * with today's real date and shown as if it were the trip date.
 *
 * Deliberately does NOT parse ambiguous numeric forms ("12/7" — is that 12 July
 * or 7 December?). Guessing wrong silently mis-dates a trip; falling back to a
 * label is honest. Per the locked dates decision: never invent a calendar date.
 *
 * `ordinalLabel` is the caller-supplied fallback ("Day 1", "Day 2", …) used
 * when the hint is absent entirely — the helper cannot know a day's position in
 * the trip. (Additive third parameter vs. the spec's two-arg sketch.)
 */
export function resolveDayDate(
  dateHint: string | undefined,
  refToday: string,
  ordinalLabel: string
): { date: string; dayLabel?: string } {
  const hint = dateHint?.trim();
  if (!hint) return { date: refToday, dayLabel: ordinalLabel };

  const s = hint.toLowerCase().replace(/[:,]/g, " ").replace(/\s+/g, " ").trim();

  // "12 jul", "12 july 2026"
  let day: number | null = null;
  let month: number | null = null;
  let explicitYear: number | null = null;

  const dayFirst = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?(?:\s+(\d{4}))?$/);
  const monthFirst = s.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/);

  if (dayFirst && MONTHS[dayFirst[2]] !== undefined) {
    day = parseInt(dayFirst[1], 10);
    month = MONTHS[dayFirst[2]];
    explicitYear = dayFirst[3] ? parseInt(dayFirst[3], 10) : null;
  } else if (monthFirst && MONTHS[monthFirst[1]] !== undefined) {
    month = MONTHS[monthFirst[1]];
    day = parseInt(monthFirst[2], 10);
    explicitYear = monthFirst[3] ? parseInt(monthFirst[3], 10) : null;
  }

  if (day === null || month === null || day < 1) {
    return { date: refToday, dayLabel: cleanLabel(hint) };
  }

  if (explicitYear !== null) {
    if (day > daysInMonth(explicitYear, month)) {
      return { date: refToday, dayLabel: cleanLabel(hint) };
    }
    return { date: iso(explicitYear, month, day) };
  }

  // Year inference: the soonest year in which this month/day is a real date
  // that has not already passed. Normally that is this year or next; the wider
  // window exists solely for "29 Feb", whose next occurrence can be up to four
  // years out. The user gave an explicit day and month, so the honest answer is
  // the next time that date actually happens — not a label, and never 1 March.
  const refYear = parseInt(refToday.slice(0, 4), 10);
  for (let year = refYear; year <= refYear + 4; year++) {
    if (day > daysInMonth(year, month)) continue; // e.g. 29 Feb in a non-leap year
    const candidate = iso(year, month, day);
    if (candidate >= refToday) return { date: candidate }; // ISO strings compare lexicographically
  }

  return { date: refToday, dayLabel: cleanLabel(hint) };
}

// Flag same-place duplicates within a single day (D2.3 T4b — SUPERSEDES T4's
// dedupDayStops, commit 5ea9719). Chris's product call overrides the earlier
// dedup: two pasted links resolving to the SAME place within a day are now
// BOTH kept as stops — dropping one silently hides user intent (e.g. a
// deliberately split long visit), so instead every occurrence survives, and
// later occurrences are marked so the UI (T6 sidebar) can flag them for the
// user to remove if accidental.
//
// The engine constraint this must satisfy (do not violate elsewhere):
// schedule.ts's validateDay throws if two stops in a day share an id, and the
// id-keyed travel matrix assumes each id is a distinct node — so two stops at
// the same place MUST have distinct ids. Rule: walk in list order, tracking
// resolved place ids seen so far *within this day*. The FIRST occurrence of a
// place keeps its id (= the place id) untouched. Each LATER occurrence of that
// same place gets a deterministic, occurrence-order suffixed id
// `${placeId}#${n}` (n = 2, 3, … — never random; determinism is LOCKED) and a
// new `duplicateOf` set to the first occurrence's (bare) place id. "Same
// place" is judged by the resolved Stop.id BEFORE suffixing is applied.
//
// Mutates the given TripStop objects IN PLACE — callers below rely on this:
// the exact same object references also live in `resolvedByItemIndex`, so the
// precedence block (which reads ids off those objects) sees the final ids
// too, without needing its own copy of this logic.
//
// No merging, no anchor-carry: each stop keeps its own name / location /
// anchor / duration untouched. They are genuinely separate stops now, not a
// survivor + a dropped twin.
//
// Scoped to ONE day's stop list per call — a place may legitimately recur on
// a DIFFERENT day (e.g. breakfast at the same cafe twice), so this must never
// run across days; callers below invoke it once per day.
function markDuplicateStops(stops: TripStop[]): void {
  const occurrencesSeen = new Map<string, number>(); // bare place id -> count so far, this day
  for (const stop of stops) {
    const placeId = stop.id; // resolved place id, read BEFORE this stop is possibly suffixed
    const priorCount = occurrencesSeen.get(placeId);
    if (priorCount === undefined) {
      occurrencesSeen.set(placeId, 1);
      continue; // first occurrence of this place in this day — keeps the bare id
    }
    const n = priorCount + 1;
    occurrencesSeen.set(placeId, n);
    stop.id = `${placeId}#${n}`;
    stop.duplicateOf = placeId;
  }
}

export type PipelineOptions = {
  /**
   * Who is running this. Gates `interpret.names` (both the parse-adapter choice
   * and the resolve checkpoint) and supplies the combined lookup cap via
   * `maxStops`. Defaults to the process-wide stub; M3.5 makes the caller pass
   * the signed-in user's real entitlements. Signature LOCKED at M1.1.
   */
  entitlements?: Entitlements;
  /**
   * Today's date as ISO yyyy-mm-dd, for `resolveDayDate`'s year inference.
   * Injected so a pipeline run is deterministic and testable; defaults to the
   * real clock.
   */
  refToday?: string;
};

export async function* runPipeline(
  text: string,
  opts: PipelineOptions = {}
): AsyncGenerator<PipelineProgress, PipelineResult> {
  let stage: PipelineStage = "parse";
  const entitlements = opts.entitlements ?? getEntitlements();

  try {
    // ---------------------------------------------------------------- parse
    yield { stage: "parse", pct: 0, detail: "Reading your links and places…" };
    // Gate 1 of 2 lives inside parseItinerary: without `interpret.names` it
    // will not select the (billed) LLM adapter at all.
    const parsed = await parseItinerary(text, { entitlements });
    yield {
      stage: "parse",
      pct: 15,
      detail: `Sorted ${parsed.items.length} line${parsed.items.length === 1 ? "" : "s"} into places and notes.`,
    };

    // -------------------------------------------------------------- resolve
    stage = "resolve";

    // ===================================================================
    // THE RESOLVE CHECKPOINT (M1.4) — the single place in the product where
    // a decision is made to spend money on a Places lookup. Every guard that
    // bounds Google spend lives in this block; nothing downstream can widen it.
    //
    // LOCKED RULE, as amended by M1 (mirrors parseItinerary.ts's comment —
    // read that one for the full rationale). ONLY these may be queried:
    //   (a) item.url        — a URL extracted VERBATIM from the paste. Always
    //                         allowed: `resolve.links` is the free core promise.
    //   (b) item.placeQuery — a deliberate, adapter-identified place search
    //                         string, ONLY when the caller holds
    //                         `interpret.names`.
    // item.label and item.raw are STILL NEVER queries. Do not "helpfully" fall
    // back to them for an item that produced neither (a) nor (b) — an item
    // with no url and no placeQuery is a note, and notes are not places.
    //
    // Three guards, in order:
    //   1. The capability gate — names contribute nothing without it.
    //   2. Links-first ordering — a paste full of names can never crowd a
    //      user's explicit links out of the cap.
    //   3. Dedupe, then cap at entitlements.maxStops — the same cafe on Day 1
    //      and Day 3 is ONE billed lookup and ONE cap slot, and the total is
    //      bounded regardless of paste size.
    // ===================================================================
    const namesAllowed = entitlements.has("interpret.names");

    const linkQueries: Array<{ source: string; itemIdx: number }> = [];
    const nameQueries: Array<{ source: string; itemIdx: number }> = [];
    parsed.items.forEach((item, idx) => {
      if (item.kind === "link" && item.url) {
        linkQueries.push({ source: item.url, itemIdx: idx });
      } else if (namesAllowed && item.placeQuery) {
        nameQueries.push({ source: item.placeQuery, itemIdx: idx });
      }
    });

    // Guard 2 (links first), then guard 3 (dedupe by exact query string,
    // preserving that order). itemsBySource fans one resolved stop back out to
    // every item that asked for it.
    const itemsBySource = new Map<string, number[]>();
    const uniqueSources: string[] = [];
    for (const q of [...linkQueries, ...nameQueries]) {
      const seen = itemsBySource.get(q.source);
      if (seen) {
        seen.push(q.itemIdx);
        continue;
      }
      itemsBySource.set(q.source, [q.itemIdx]);
      uniqueSources.push(q.source);
    }

    // The cap is an ENTITLEMENT, not a constant: M3.5's free tier lowers it to
    // 8 by returning a different maxStops, without touching this checkpoint.
    // The overflow is REPORTED as failures below, never silently dropped.
    const RESOLVE_CAP = entitlements.maxStops;
    const sources = uniqueSources.slice(0, RESOLVE_CAP);
    const overflowSources = uniqueSources.slice(RESOLVE_CAP);

    // The single authority on what was queried on whose behalf. Assembly reads
    // ONLY this map, so what gets resolved and what gets attached to an item
    // are structurally incapable of diverging (e.g. assembly can never pick up
    // a placeQuery that the gate above refused to send).
    const sourceByItemIndex = new Map<number, string>();
    for (const source of sources) {
      for (const idx of itemsBySource.get(source)!) sourceByItemIndex.set(idx, source);
    }

    yield {
      stage: "resolve",
      pct: 15,
      detail:
        sources.length > 0
          ? `Looking up ${sources.length} place${sources.length === 1 ? "" : "s"}…`
          : "No places to look up.",
    };

    // resolvePlaces resolves the whole batch in one call (see maps/types.ts /
    // resolvePlaces.ts) — there is no per-URL hook to observe mid-flight. We
    // do not fabricate progress across that single await; instead, once the
    // batch settles we honestly replay one granular event per URL using the
    // real result (found vs. failed), which is why these ticks land right
    // after the call rather than during it.
    const provider = getMapsProvider();
    const resolveResult =
      sources.length > 0 ? await provider.resolvePlaces(sources) : { stops: [], failures: [] };
    // capped-out sources surface in the same failure panel as unresolvable ones
    for (const source of overflowSources) {
      resolveResult.failures.push({
        source,
        reason: `That's a lot of places — Gracie cooks the first ${RESOLVE_CAP} per paste. Split the rest into another trip?`,
      });
    }

    const stopBySource = new Map<string, Stop>(resolveResult.stops.map((s) => [s.source, s]));

    if (sources.length > 0) {
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        const pct = 15 + Math.round(((i + 1) / sources.length) * 40);
        const stop = stopBySource.get(source);
        yield {
          stage: "resolve",
          pct,
          detail: stop ? `Found ${stop.name}.` : "Couldn't find a match for one of your places.",
        };
      }
    } else {
      yield { stage: "resolve", pct: 55, detail: "Nothing to resolve." };
    }

    // --- assemble (synchronous; still logically part of resolve's budget —
    // no additional progress events beyond what was already yielded above) ---
    const tripId = randomBytes(6).toString("hex"); // matches app/api/trips/route.ts

    // Map each resolved parse item -> TripStop. label (display/context only,
    // per the LOCKED RULE above) overrides the resolved Stop's display name
    // when present, but never affects which string was queried.
    //
    // Reads sourceByItemIndex — the checkpoint's record of what it actually
    // sent — rather than re-deriving a source from the item. Two items sharing
    // one deduped query each get their own TripStop object here (no shared
    // references); markDuplicateStops then handles same-day repeats.
    const resolvedByItemIndex = new Map<number, TripStop>();
    parsed.items.forEach((item, idx) => {
      const source = sourceByItemIndex.get(idx);
      if (!source) return; // a note, or gated/capped out — never resolved
      const stop = stopBySource.get(source);
      if (!stop) return; // failed to resolve — dropped cleanly; already in resolveResult.failures

      const tripStop: TripStop = {
        id: stop.id,
        name: item.label ?? stop.name,
        location: stop.location,
        address: stop.address,
        durationMin: 60,
        source: stop.source,
      };

      const anchorMin =
        item.anchorLikely && item.timeHint ? parseTimeHint(item.timeHint) : null;
      if (anchorMin !== null) tripStop.anchor = { startMin: anchorMin };

      resolvedByItemIndex.set(idx, tripStop);
    });

    // M1.5 — real dates when the paste gives them, honest "Day N" labels
    // otherwise. Days keep the parse order of parsed.days; nothing is ever
    // moved between days here.
    const refToday = opts.refToday ?? new Date().toISOString().slice(0, 10);
    let days: TripDay[];
    if (parsed.days.length === 0) {
      // The implicit single day gets a label too — today's real calendar date
      // must never be shown as if the user had said the trip is today.
      const { date, dayLabel } = resolveDayDate(undefined, refToday, "Day 1");
      days = [
        {
          date,
          ...(dayLabel ? { dayLabel } : {}),
          dayStartMin: DAY_START_MIN,
          dayEndMin: DAY_END_MIN,
          stops: [...resolvedByItemIndex.values()],
        },
      ];
    } else {
      days = parsed.days.map((d, i) => {
        const { date, dayLabel } = resolveDayDate(d.dateHint, refToday, `Day ${i + 1}`);
        return {
          date,
          ...(dayLabel ? { dayLabel } : {}),
          dayStartMin: DAY_START_MIN,
          dayEndMin: DAY_END_MIN,
          stops: d.itemRefs
            .map((ref) => resolvedByItemIndex.get(ref))
            .filter((s): s is TripStop => s !== undefined),
        };
      });
    }

    // D2.3 T4b: flag same-place duplicates WITHIN each day (supersedes T4's
    // dedup — see markDuplicateStops above). Must run BEFORE dayIndexOfStopId
    // and the precedence block below: it mutates ids in place on the same
    // TripStop objects resolvedByItemIndex holds, so those two steps observe
    // the final ids.
    for (const day of days) markDuplicateStops(day.stops);

    // stopId -> day index, so precedence pairs attach to the day X's stop landed in.
    const dayIndexOfStopId = new Map<string, number>();
    days.forEach((day, dayIdx) => {
      for (const s of day.stops) dayIndexOfStopId.set(s.id, dayIdx);
    });

    // precedence: item X's orderConstraint.before references OTHER items by
    // their raw string (the stable join key — see parse/types.ts). Drop any
    // pair where either side never resolved to a stop; never insert a
    // placeholder id.
    for (let idx = 0; idx < parsed.items.length; idx++) {
      const item = parsed.items[idx];
      if (!item.orderConstraint?.before) continue;
      const beforeStop = resolvedByItemIndex.get(idx);
      if (!beforeStop) continue;

      for (const rawY of item.orderConstraint.before) {
        const yIdx = parsed.items.findIndex((it) => it.raw === rawY);
        if (yIdx === -1) continue;
        const afterStop = resolvedByItemIndex.get(yIdx);
        if (!afterStop) continue;

        const dayIdx = dayIndexOfStopId.get(beforeStop.id);
        if (dayIdx === undefined) continue;

        const day = days[dayIdx];
        day.precedence = day.precedence ?? [];
        day.precedence.push({
          beforeId: beforeStop.id,
          afterId: afterStop.id,
          reason: item.orderConstraint.reason,
        });
      }
    }

    const doc: TripDoc = {
      tripId,
      days,
      settings: { walkMax: 10, driveOverheadMin: 10 },
      legOverrides: [],
    };

    await getTripStore().put(doc);

    // ------------------------------------------------------------ matrix/solve
    const plans: DayPlan[] = [];
    const perDay = 45 / doc.days.length; // 30 (matrix) + 15 (solve), split evenly per day

    for (let i = 0; i < doc.days.length; i++) {
      stage = "matrix";
      const matrixPct = Math.round(55 + i * perDay);
      yield {
        stage: "matrix",
        pct: matrixPct,
        detail: `Measuring the drives (day ${i + 1} of ${doc.days.length})…`,
      };

      // Idempotency note: planTripDay -> getMapsProvider().getTravelMatrix pulls
      // through matrixSource's MatrixCache (see maps/matrixSource.ts), which is
      // keyed by (fromId, toId, mode) and persisted (file/KV, see config.ts).
      // Pairs are cached as they resolve, so re-running this pipeline on the
      // same input text — which re-derives the same stop ids — resumes from
      // cache instead of paying for every pair again. Safe to re-invoke.
      const plan = await planTripDay(doc, i);

      stage = "solve";
      const solvePct = Math.round(55 + (i + 1) * perDay);
      yield {
        stage: "solve",
        pct: solvePct,
        detail: "Cooking the best order…",
      };

      plans.push(plan);
    }

    return { status: "ok", tripId, doc, plans, failures: resolveResult.failures };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", stage, message };
  }
}
