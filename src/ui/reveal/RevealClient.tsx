"use client";

// D2.3 T6 — reveal state plumbing: owns the trip document + per-day plans,
// derives the active day's visit order (solver plan -> manualOrder -> stored
// order), and wires drag-reorder / re-optimize / duplicate-removal mutations
// behind one busy flag (mirrors src/ui/board/TripBoard.tsx's toggleLeg
// pattern: one boolean, checked before each mutation, set around the await).
// RevealMap plays the pencil-scribble sfx and re-sketches on its own
// whenever its orderedIds prop changes — nothing here triggers either.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TripDoc } from "@/lib/store/types";
import type { DayPlan } from "@/lib/schedule/types";
import { validManualOrder } from "@/lib/planShared";
import { RevealMap, type RevealStop } from "./RevealMap";
import { JournalSidebar } from "./JournalSidebar";
import { WashiTag, type WashiTone } from "@/ui/journal/WashiTag";
import "./reveal.css";

const TONE_CYCLE: WashiTone[] = ["coral", "sky", "pink", "leaf"];
const ROTATE_CYCLE = [-3, 2, -2, 3]; // see JournalSidebar.tsx's matching note on why this is duplicated, not shared
function toneFor(i: number): WashiTone {
  return TONE_CYCLE[i % TONE_CYCLE.length];
}
function rotateFor(i: number): number {
  return ROTATE_CYCLE[i % ROTATE_CYCLE.length];
}

// E4 — PUT now re-plans server-side (src/lib/planStore.ts's savePlanned) and
// returns the freshly-planned doc in one round-trip, so there is no longer a
// follow-up POST /plan call to make: the doc IS the plan now.
async function putDoc(doc: TripDoc): Promise<TripDoc> {
  const res = await fetch(`/api/trips/${doc.tripId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    const msg = (body && (body as { error?: string }).error) ?? `save failed: ${res.status}`;
    throw new Error(msg);
  }
  return (body as { doc: TripDoc }).doc;
}

// E5c — Re-optimize now calls the explicit, day-scoped re-cook operation
// (src/lib/planStore.ts's recookDay via app/api/trips/[id]/plan's POST):
// clears this day's manualOrder and force-solves it fresh, leaving every
// other day untouched. Same response shape as putDoc ({ doc }), so the caller
// commits it identically.
async function recookDayDoc(tripId: string, dayIndex: number): Promise<TripDoc> {
  const res = await fetch(`/api/trips/${tripId}/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recook: { scope: "day", dayIndex } }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    const msg = (body && (body as { error?: string }).error) ?? `re-cook failed: ${res.status}`;
    throw new Error(msg);
  }
  return (body as { doc: TripDoc }).doc;
}

export function RevealClient({
  initialDoc,
  initialPlans,
}: {
  initialDoc: TripDoc;
  initialPlans: DayPlan[];
}) {
  const [doc, setDoc] = useState<TripDoc>(initialDoc);
  const [plans, setPlans] = useState<DayPlan[]>(initialPlans);
  const [activeDay, setActiveDay] = useState<number>(() => {
    const i = initialDoc.days.findIndex((d) => d.stops.length > 0);
    return i >= 0 ? i : 0;
  });
  // (a) the optimistic reorder overlay — set the instant a drag drops, so the
  // map/sidebar update before the PUT round-trip even starts; cleared once
  // that round-trip lands (success or revert-on-failure).
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // A drag/re-optimize/remove result belongs to the day it ran on — switching
  // tabs must not leak a stale transient error or optimistic order onto a
  // different day's rows.
  useEffect(() => {
    setPendingOrder(null);
    setActionError(null);
  }, [activeDay]);

  const tripDay = doc.days[activeDay];
  const plan = plans[activeDay];

  const stopIds = useMemo(() => tripDay.stops.map((s) => s.id), [tripDay.stops]);
  // Steady-state formula (design.md's D2.3 T6 brief): plan.order when the
  // plan solved, else the valid manualOrder, else the stored stop order.
  // pendingOrder overlays that for the brief optimistic window between a
  // drop and the server confirming it — see the comment above its useState.
  const orderedIds = useMemo(() => {
    if (pendingOrder) return pendingOrder;
    if (plan.status === "ok") return plan.order;
    return validManualOrder(tripDay.manualOrder, stopIds) ?? stopIds;
  }, [pendingOrder, plan, tripDay.manualOrder, stopIds]);

  const mapStops: RevealStop[] = useMemo(
    () => tripDay.stops.map((s) => ({ id: s.id, name: s.name, lat: s.location.lat, lng: s.location.lng })),
    [tripDay.stops]
  );
  const bookedId = tripDay.stops.find((s) => s.anchor)?.id ?? null;

  // Every mutation follows the same shape: build the next doc, PUT it (the
  // server re-plans EVERY day and returns the planned doc in that one
  // response — E4, see putDoc above), then commit it to state — or revert +
  // show a margin note. Serialized behind `busy` so two mutations (a fast
  // double-drag, a drag racing Re-optimize, etc.) can never interleave.
  const runMutation = useCallback(
    async (buildNextDoc: (d: TripDoc) => TripDoc, failureVerb: string) => {
      if (busy) return;
      setBusy(true);
      setActionError(null);
      try {
        const nextDoc = buildNextDoc(doc);
        const savedDoc = await putDoc(nextDoc);
        setDoc(savedDoc);
        setPlans(savedDoc.plan!.days);
        setPendingOrder(null);
      } catch (e) {
        setPendingOrder(null); // revert to the pre-mutation order
        const msg = e instanceof Error ? e.message : String(e);
        setActionError(`${failureVerb} — ${msg}. Try again?`);
      } finally {
        setBusy(false);
      }
    },
    [busy, doc]
  );

  const handleReorder = useCallback(
    (nextOrder: string[]) => {
      if (busy) return;
      setPendingOrder(nextOrder);
      void runMutation(
        (d) => ({
          ...d,
          days: d.days.map((day, i) => (i === activeDay ? { ...day, manualOrder: nextOrder } : day)),
        }),
        "That drag didn't stick"
      );
    },
    [busy, runMutation, activeDay]
  );

  // E5c — day-scoped explicit re-cook (src/lib/planStore.ts's recookDay), not
  // a PUT: the server clears this day's manualOrder AND force-solves it
  // fresh even if nothing's hash-stale (an already-auto-solved day still
  // gets a genuine new solve on request). Every OTHER day is left exactly as
  // stored. Mirrors runMutation's busy/optimistic/error shape.
  const handleReoptimize = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    void (async () => {
      try {
        const savedDoc = await recookDayDoc(doc.tripId, activeDay);
        setDoc(savedDoc);
        setPlans(savedDoc.plan!.days);
        setPendingOrder(null);
      } catch (e) {
        setPendingOrder(null); // revert to the pre-mutation order
        const msg = e instanceof Error ? e.message : String(e);
        setActionError(`Re-optimizing didn't stick — ${msg}. Try again?`);
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, doc.tripId, activeDay]);

  // T7 — §2 LOCKED surface: per-leg mode toggle. Same upsert shape as the old
  // board's toggleLeg (src/ui/board/TripBoard.tsx): drop any existing override
  // for this day+leg, append the new pick; planService re-times the fixed
  // order (never re-orders) and marks the leg chosenBy "user".
  const handleToggleLeg = useCallback(
    (fromId: string, toId: string, mode: "walk" | "drive") => {
      void runMutation(
        (d) => ({
          ...d,
          legOverrides: [
            ...d.legOverrides.filter(
              (o) => !(o.dayIndex === activeDay && o.fromId === fromId && o.toId === toId)
            ),
            { dayIndex: activeDay, fromId, toId, mode },
          ],
        }),
        "That leg wouldn't switch"
      );
    },
    [runMutation, activeDay]
  );

  // T7 — §2 LOCKED surface: walkMax / driveOverheadMin, the planner's notes.
  const handleSettingsChange = useCallback(
    (settings: TripDoc["settings"]) => {
      void runMutation((d) => ({ ...d, settings }), "Those notes didn't take");
    },
    [runMutation]
  );

  const handleRemoveStop = useCallback(
    (stopId: string) => {
      void runMutation(
        (d) => ({
          ...d,
          days: d.days.map((day, i) => {
            if (i !== activeDay) return day;
            const next = {
              ...day,
              stops: day.stops
                .filter((s) => s.id !== stopId)
                // T9 audit O2: if the REMOVED stop was the original, its
                // surviving duplicate stops flagging itself as a copy of a
                // stop that no longer exists
                .map((s) => {
                  if (s.duplicateOf !== stopId) return s;
                  const { duplicateOf: _dropped, ...rest } = s;
                  return rest;
                }),
            };
            if (next.manualOrder) next.manualOrder = next.manualOrder.filter((id) => id !== stopId);
            if (next.precedence) {
              next.precedence = next.precedence.filter((p) => p.beforeId !== stopId && p.afterId !== stopId);
            }
            return next;
          }),
          legOverrides: d.legOverrides.filter(
            (o) => !(o.dayIndex === activeDay && (o.fromId === stopId || o.toId === stopId))
          ),
        }),
        "Couldn't remove that stop"
      );
    },
    [runMutation, activeDay]
  );

  return (
    <div>
      {doc.days.length > 1 && (
        <div className="reveal-tabs">
          {doc.days.map((d, i) => (
            <WashiTag
              key={i}
              as="button"
              tone={i === activeDay ? "washi" : toneFor(i)}
              className="reveal-tab"
              style={{ transform: `rotate(${rotateFor(i)}deg)` }}
              aria-pressed={i === activeDay}
              onClick={() => setActiveDay(i)}
              data-testid={`day-tab-${i}`}
            >
              Day {i + 1}
            </WashiTag>
          ))}
        </div>
      )}

      <div className="reveal-layout">
        <div className="reveal-layout__map">
          {tripDay.stops.length > 0 ? (
            <RevealMap stops={mapStops} orderedIds={orderedIds} bookedId={bookedId} />
          ) : (
            <p style={{ fontFamily: "var(--font-body)", color: "var(--ink-soft)" }}>No stops on this day yet.</p>
          )}
        </div>

        <JournalSidebar
          tripId={doc.tripId}
          day={tripDay}
          plan={plan}
          orderedIds={orderedIds}
          busy={busy}
          actionError={actionError}
          settings={doc.settings}
          onReorder={handleReorder}
          onReoptimize={handleReoptimize}
          onRemoveStop={handleRemoveStop}
          onToggleLeg={handleToggleLeg}
          onSettingsChange={handleSettingsChange}
        />
      </div>
    </div>
  );
}
