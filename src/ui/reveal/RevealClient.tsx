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
import type { Conflict, Proposal } from "@/lib/engine/types";
import { applyDocPatch, dismissalKeyForConflict, isConflictDismissed, validManualOrder } from "@/lib/planShared";
import { stopKeys } from "@/lib/constraints/compile";
import { confirmConstraint, removeConstraint, type ChipTarget } from "@/lib/constraints/persisted";
import type { Constraint } from "@/lib/constraints/types";
import { RevealMap, type RevealStop } from "./RevealMap";
import { JournalSidebar, type ConstraintChipEntry, type TradeOffCardEntry } from "./JournalSidebar";
import { TradeOffModal } from "./TradeOffModal";
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

// E6b — whole-trip re-cook: the same {recook:{scope:"trip"}} POST recookDayDoc
// uses for scope "day", just the trip-scope body. One joint whole-trip solve
// (src/lib/planStore.ts's recookTrip) — the only place cross-day moveDay
// proposals can surface.
async function recookTripDoc(tripId: string): Promise<TripDoc> {
  const res = await fetch(`/api/trips/${tripId}/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recook: { scope: "trip" } }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    const msg = (body && (body as { error?: string }).error) ?? `re-cook failed: ${res.status}`;
    throw new Error(msg);
  }
  return (body as { doc: TripDoc }).doc;
}

async function fetchDoc(tripId: string): Promise<TripDoc | null> {
  const res = await fetch(`/api/trips/${tripId}`);
  if (!res.ok) return null;
  return (await res.json()) as TripDoc;
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

  // E6b — visible trade-off cards for the active day: this day's conflicts
  // PLUS any dayIndex-less (trip-level) ones (defensive — today every
  // conflict carries a dayIndex, per STATE.md's E5c note), minus whatever is
  // currently dismissed (src/lib/planShared.ts's isConflictDismissed keys the
  // dismissal to the conflict's OWN day hash, so an edit to that day silently
  // expires it). One card per conflict; its chips are the proposals whose
  // `resolves` includes that conflict's id.
  const tradeOffCards: TradeOffCardEntry[] = useMemo(() => {
    const allConflicts = doc.plan?.conflicts ?? [];
    const allProposals = doc.plan?.proposals ?? [];
    return allConflicts
      .filter((c) => c.dayIndex === activeDay || c.dayIndex === undefined)
      .filter((c) => !isConflictDismissed(doc, c))
      .map((conflict) => ({
        conflict,
        proposals: allProposals.filter((p) => p.resolves.includes(conflict.id)),
      }));
  }, [doc, activeDay]);

  // E7 — the persisted constraints as REVIEW CHIPS: one chip per llm/user
  // constraint (google/legacy/derived facts aren't statements to review),
  // attached to the active day's stop rows or to the trip panel. Confirm
  // promotes an inference to a hard, above-Google fact; delete removes it
  // from the stored patch; both go through the ordinary PUT (the patch is in
  // the solve projection, so every accept/delete re-cooks).
  const constraintChips = useMemo(() => {
    const byStopId = new Map<string, ConstraintChipEntry[]>();
    const trip: ConstraintChipEntry[] = [];
    const patch = doc.constraints;
    if (!patch) return { byStopId, trip };
    const chipOf = (
      target: ChipTarget,
      slot: string,
      c: Constraint<unknown>
    ): ConstraintChipEntry | null => {
      const src = c.provenance.source;
      if (src !== "llm" && src !== "user") return null;
      return {
        target,
        slot,
        value: c.value,
        source: src,
        confirmed: src === "user" || c.provenance.confirmed === true,
        ...(c.provenance.evidence ? { evidence: c.provenance.evidence } : {}),
      };
    };
    const keys = stopKeys(doc);
    doc.days[activeDay]?.stops.forEach((stop, j) => {
      const key = keys[activeDay][j];
      const sp = patch.stops?.[key];
      if (!sp) return;
      for (const slot of ["window", "hours", "duration", "effort", "priority", "pinnedDay"] as const) {
        const c = sp[slot];
        if (!c) continue;
        const chip = chipOf({ scope: "stop", key, slot }, slot, c as Constraint<unknown>);
        if (chip) byStopId.set(stop.id, [...(byStopId.get(stop.id) ?? []), chip]);
      }
    });
    const pace = patch.trip?.pacePreset;
    if (pace) {
      const chip = chipOf({ scope: "trip", slot: "pacePreset" }, "pacePreset", pace);
      if (chip) trip.push(chip);
    }
    for (const qb of patch.trip?.party?.quietBlocks ?? []) {
      const chip = chipOf({ scope: "quietBlock", id: qb.id }, "quietBlock", qb);
      if (chip) trip.push(chip);
    }
    return { byStopId, trip };
  }, [doc, activeDay]);

  // E6c — the decision modal (Chris, 2026-08-14). Auto-pops ONCE per new
  // issue set: the set's signature is the sorted visible conflict ids;
  // "decide later" records it in localStorage (a capped list, so revisiting
  // day 1 after deciding-later on day 2 doesn't nag again) and the sidebar
  // banner reopens the modal on demand. Accepting/dismissing changes the set,
  // so a genuinely new situation pops again — an already-seen one never does.
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const [decisionIndex, setDecisionIndex] = useState(0);
  const decisionKey = useMemo(
    () =>
      tradeOffCards.length === 0
        ? null
        : tradeOffCards
            .map((c) => c.conflict.id)
            .sort()
            .join("|"),
    [tradeOffCards]
  );
  const seenStorageKey = `ts-decisions-seen-${doc.tripId}`;
  const readSeenKeys = useCallback((): string[] => {
    try {
      const raw = JSON.parse(localStorage.getItem(seenStorageKey) ?? "[]");
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }, [seenStorageKey]);

  useEffect(() => {
    if (decisionKey === null) {
      setDecisionsOpen(false);
      setDecisionIndex(0);
      return;
    }
    if (!readSeenKeys().includes(decisionKey)) setDecisionsOpen(true);
  }, [decisionKey, readSeenKeys]);

  // Clamp the spotlight as accepts/dismisses shrink the queue.
  useEffect(() => {
    setDecisionIndex((i) => Math.min(i, Math.max(0, tradeOffCards.length - 1)));
  }, [tradeOffCards.length]);

  const handleOpenDecisions = useCallback(() => {
    setDecisionIndex(0);
    setDecisionsOpen(true);
  }, []);
  const handleNextDecision = useCallback(() => {
    setDecisionIndex((i) => (tradeOffCards.length === 0 ? 0 : (i + 1) % tradeOffCards.length));
  }, [tradeOffCards.length]);
  const handlePrevDecision = useCallback(() => {
    setDecisionIndex((i) =>
      tradeOffCards.length === 0 ? 0 : (i - 1 + tradeOffCards.length) % tradeOffCards.length
    );
  }, [tradeOffCards.length]);
  const handleDecideLater = useCallback(() => {
    setDecisionsOpen(false);
    if (decisionKey !== null) {
      try {
        const seen = [...readSeenKeys().filter((k) => k !== decisionKey), decisionKey];
        localStorage.setItem(seenStorageKey, JSON.stringify(seen.slice(-20)));
      } catch {
        // storage off — the modal will pop again next load; harmless
      }
    }
  }, [decisionKey, readSeenKeys, seenStorageKey]);

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

  // E7 — chip mutations + the standalone notes compile.
  const handleConfirmChip = useCallback(
    (target: ChipTarget) => {
      void runMutation(
        (d) => ({ ...d, constraints: confirmConstraint(d.constraints ?? {}, target) }),
        "That confirm didn't stick"
      );
    },
    [runMutation]
  );
  const handleDeleteChip = useCallback(
    (target: ChipTarget) => {
      void runMutation((d) => {
        const next = removeConstraint(d.constraints ?? {}, target);
        if (Object.keys(next).length === 0) {
          const { constraints: _dropped, ...rest } = d;
          return rest;
        }
        return { ...d, constraints: next };
      }, "That delete didn't stick");
    },
    [runMutation]
  );
  // POST to the compile endpoint, commit whatever it saved. compiled: 0 is a
  // legitimate outcome (no constraint language found) — not an error.
  const handleCompileNotes = useCallback(
    async (notes: string): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setActionError(null);
      try {
        const res = await fetch(`/api/trips/${doc.tripId}/constraints`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes }),
        });
        const body = (await res.json().catch(() => null)) as
          | { doc?: TripDoc; compiled?: number; error?: string }
          | null;
        if (!res.ok || !body?.doc) {
          throw new Error(body?.error ?? `compile failed: ${res.status}`);
        }
        setDoc(body.doc);
        if (body.doc.plan) setPlans(body.doc.plan.days);
        if (!body.compiled) {
          // audit finding 8: compiled: 0 must not read as a mute success —
          // say what happened without treating it as a failure.
          setActionError(
            "Gracie read your notes but didn't find anything to hold her to — try naming a stop, a time, or the pace."
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setActionError(`Gracie couldn't read those notes — ${msg}. Try again?`);
      } finally {
        setBusy(false);
      }
    },
    [busy, doc.tripId]
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

  // E6b — whole-trip re-cook: a real confirm gate lives in JournalSidebar
  // (inline, journal-styled — not a native browser dialog); this handler only
  // runs once that's been cleared. Same busy/optimistic/error shape as
  // handleReoptimize, just the trip-scope POST body.
  const handleRecookTrip = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    void (async () => {
      try {
        const savedDoc = await recookTripDoc(doc.tripId);
        setDoc(savedDoc);
        setPlans(savedDoc.plan!.days);
        setPendingOrder(null);
      } catch (e) {
        setPendingOrder(null);
        const msg = e instanceof Error ? e.message : String(e);
        setActionError(`Re-cooking the trip didn't stick — ${msg}. Try again?`);
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, doc.tripId]);

  // E6b — accept a trade-off proposal: apply its DocPatch CLIENT-SIDE first
  // (src/lib/planShared.ts's applyDocPatch — validates as it goes), then hand
  // the resulting doc through the ordinary PUT/re-plan round-trip. A stale
  // patch (the stop/day it targets already changed) is NEVER PUT — it shows a
  // margin error and refreshes the doc from the server instead, per the
  // brief's "never a misapply".
  const handleAcceptProposal = useCallback(
    (proposal: Proposal) => {
      if (busy) return;
      const result = applyDocPatch(doc, proposal.patch);
      if (!result.ok) {
        setActionError(`That trade-off couldn't be applied — ${result.reason} Refreshing…`);
        void (async () => {
          const fresh = await fetchDoc(doc.tripId);
          if (fresh) {
            setDoc(fresh);
            if (fresh.plan) setPlans(fresh.plan.days);
          }
        })();
        return;
      }
      const patched = result.doc;
      void runMutation(() => patched, "That trade-off didn't stick");
    },
    [busy, doc, runMutation]
  );

  // E6b — dismiss a trade-off card. Card-level, not per-chip (see
  // src/lib/store/types.ts's `dismissedProposals` doc comment): keyed to the
  // conflict's OWN day's CURRENT hash, so it rides through the cheap toggle
  // fast path (dismissedProposals isn't in solveProjection) rather than
  // forcing a real re-plan, and auto-expires the moment that day changes.
  const handleDismissConflict = useCallback(
    (conflict: Conflict) => {
      void runMutation((d) => {
        const key = dismissalKeyForConflict(d, conflict);
        if (key === null) return d; // no stored plan to key against — nothing to dismiss yet
        return {
          ...d,
          dismissedProposals: [
            ...(d.dismissedProposals ?? []).filter((x) => x.id !== conflict.id),
            { id: conflict.id, dayHash: key },
          ],
        };
      }, "That dismiss didn't stick");
    },
    [runMutation]
  );

  // E6c — set/override/clear the trip's home base (already resolved by the
  // pocket's fetch through the metered boundary; this only persists it).
  // Source is always "user" here — paste detection writes its own record in
  // the pipeline. homeBase is not solve-relevant yet (solveProjection.ts's
  // E6c note), so this PUT rides the cheap no-day-stale path.
  const handleSetHomeBase = useCallback(
    (base: { id: string; name: string; location: { lat: number; lng: number } } | null) => {
      void runMutation((d) => {
        if (base === null) {
          const { homeBase: _dropped, ...rest } = d;
          return rest;
        }
        return { ...d, homeBase: { ...base, source: "user" as const } };
      }, "That home base didn't stick");
    },
    [runMutation]
  );

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
          dayIndex={activeDay}
          day={tripDay}
          plan={plan}
          orderedIds={orderedIds}
          busy={busy}
          actionError={actionError}
          settings={doc.settings}
          tradeOffCards={tradeOffCards}
          onReorder={handleReorder}
          onReoptimizeDay={handleReoptimize}
          onRecookTrip={handleRecookTrip}
          onOpenDecisions={handleOpenDecisions}
          homeBase={doc.homeBase}
          onSetHomeBase={handleSetHomeBase}
          constraintChips={constraintChips}
          onConfirmChip={handleConfirmChip}
          onDeleteChip={handleDeleteChip}
          onCompileNotes={handleCompileNotes}
          onRemoveStop={handleRemoveStop}
          onToggleLeg={handleToggleLeg}
          onSettingsChange={handleSettingsChange}
        />
      </div>

      {decisionsOpen && tradeOffCards.length > 0 && (
        <TradeOffModal
          cards={tradeOffCards}
          index={decisionIndex}
          busy={busy}
          onAccept={handleAcceptProposal}
          onDismiss={handleDismissConflict}
          onPrev={handlePrevDecision}
          onNext={handleNextDecision}
          onDecideLater={handleDecideLater}
        />
      )}
    </div>
  );
}
