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
import type { ParsedItem } from "../parse/types";
import { getMapsProvider, getTripStore } from "../config";
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

export async function* runPipeline(
  text: string
): AsyncGenerator<PipelineProgress, PipelineResult> {
  let stage: PipelineStage = "parse";

  try {
    // ---------------------------------------------------------------- parse
    yield { stage: "parse", pct: 0, detail: "Reading your links…" };
    const parsed = await parseItinerary(text);
    yield {
      stage: "parse",
      pct: 15,
      detail: `Sorted ${parsed.items.length} line${parsed.items.length === 1 ? "" : "s"} into places and notes.`,
    };

    // -------------------------------------------------------------- resolve
    stage = "resolve";

    // -------------------------------------------------------------------
    // LOCKED RULE (mirrors src/lib/parse/parseItinerary.ts's comment): only
    // URLs extracted verbatim from kind==="link" items' `.url` field are ever
    // sent to resolvePlaces. label text / label-only items are NEVER used as
    // resolve queries — labels are display+context only. Do not "helpfully"
    // fall back to `item.label` or `item.raw` here for label-only items.
    // -------------------------------------------------------------------
    const allUrls: string[] = [];
    for (const item of parsed.items) {
      if (item.kind === "link" && item.url) allUrls.push(item.url);
    }
    // Spend guard (T9 audit, finding M1): every URL can become a billed
    // Places call and the pipeline is the public front door — same 40-input
    // cap /api/trips/[id]/resolve has carried since the D0 audit. The
    // overflow is REPORTED as failures below, never silently dropped.
    const RESOLVE_CAP = 40;
    const urls = allUrls.slice(0, RESOLVE_CAP);
    const overflowUrls = allUrls.slice(RESOLVE_CAP);

    yield {
      stage: "resolve",
      pct: 15,
      detail:
        urls.length > 0
          ? `Looking up ${urls.length} place${urls.length === 1 ? "" : "s"}…`
          : "No links to look up.",
    };

    // resolvePlaces resolves the whole batch in one call (see maps/types.ts /
    // resolvePlaces.ts) — there is no per-URL hook to observe mid-flight. We
    // do not fabricate progress across that single await; instead, once the
    // batch settles we honestly replay one granular event per URL using the
    // real result (found vs. failed), which is why these ticks land right
    // after the call rather than during it.
    const provider = getMapsProvider();
    const resolveResult =
      urls.length > 0 ? await provider.resolvePlaces(urls) : { stops: [], failures: [] };
    // capped-out links surface in the same failure panel as unresolvable ones
    for (const url of overflowUrls) {
      resolveResult.failures.push({
        source: url,
        reason: `That's a lot of links — Gracie cooks the first ${RESOLVE_CAP} per paste. Split the rest into another trip?`,
      });
    }

    const stopBySource = new Map<string, Stop>(resolveResult.stops.map((s) => [s.source, s]));

    if (urls.length > 0) {
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const pct = 15 + Math.round(((i + 1) / urls.length) * 40);
        const stop = stopBySource.get(url);
        yield {
          stage: "resolve",
          pct,
          detail: stop ? `Found ${stop.name}.` : "Couldn't find a match for one of your links.",
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
    // when present, but never affects which URL was queried.
    const resolvedByItemIndex = new Map<number, TripStop>();
    parsed.items.forEach((item: ParsedItem, idx: number) => {
      if (item.kind !== "link" || !item.url) return;
      const stop = stopBySource.get(item.url);
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

    const today = new Date().toISOString().slice(0, 10);
    let days: TripDay[];
    if (parsed.days.length === 0) {
      days = [
        {
          date: today,
          dayStartMin: DAY_START_MIN,
          dayEndMin: DAY_END_MIN,
          stops: [...resolvedByItemIndex.values()],
        },
      ];
    } else {
      days = parsed.days.map((d) => ({
        date: today,
        dayStartMin: DAY_START_MIN,
        dayEndMin: DAY_END_MIN,
        stops: d.itemRefs
          .map((ref) => resolvedByItemIndex.get(ref))
          .filter((s): s is TripStop => s !== undefined),
      }));
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
