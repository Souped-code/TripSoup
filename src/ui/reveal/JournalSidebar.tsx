"use client";

// D2.3 T6 — the reveal sidebar: a torn journal page with the day's itinerary
// as a handwritten-style list. Drag handles are WashiTag strips (dnd-kit
// pointer + keyboard sensors); dropping a row hands the new order up to
// RevealClient, which persists it as manualOrder and re-plans. RevealMap
// plays the pencil-scribble sfx and re-sketches on its own whenever the
// orderedIds prop changes — this component never triggers either directly.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TripDay, TripDoc, TripStop } from "@/lib/store/types";
import type { DayPlan, PlanEntry, PlanLeg } from "@/lib/schedule/types";
import type { Conflict, Proposal } from "@/lib/engine/types";
import { formatDuration } from "@/lib/util/duration";
import { WashiTag, type WashiTone } from "@/ui/journal/WashiTag";
import { InkButton } from "@/ui/journal/InkButton";
import { fmtTime } from "@/ui/time";
import "./reveal.css";

const TONE_CYCLE: WashiTone[] = ["coral", "sky", "pink", "leaf"];
// Hand-placed jauntiness, not a uniform rotation grid (§2.7). Duplicated
// (small, deliberately) in RevealClient.tsx for its day tabs — two short
// arrays are cheaper to keep in sync by eye than a shared module would be
// to maintain for two consumers.
const ROTATE_CYCLE = [-4, 3, -3, 4, -2, 2];
function toneFor(i: number): WashiTone {
  return TONE_CYCLE[i % TONE_CYCLE.length];
}
function rotateFor(i: number): number {
  return ROTATE_CYCLE[i % ROTATE_CYCLE.length];
}

function fmtDayDate(iso: string): string {
  // Parsed at UTC noon (not midnight) so no local timezone can roll the
  // calendar date backward/forward a day — this is a display label, not a
  // scheduling computation (all real schedule math stays in minutes-from-
  // midnight per §1/§4 and is untouched here).
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

// Irregular hand-torn left edge (design.md §5: a rough-edge filter or
// border-image, never a bigger border-radius). A fixed wobble sequence, not
// Math.random() — this component renders on the server then hydrates on the
// client, and an unseeded random value would mismatch between those passes.
const TORN_WOBBLE = [
  2, 3.5, 0.8, 2.6, 1.2, 3.2, 0, 2.2, 3.6, 1.6, 0.4, 2.8, 3.4, 1, 0.2, 2.4, 3.8, 1.4, 2, 0.6, 3, 1.8,
];
function tornEdgeClipPath(): string {
  const steps = TORN_WOBBLE.length - 1;
  const left = TORN_WOBBLE.map((x, i) => `${x}px ${(i * 100) / steps}%`);
  return `polygon(${left.join(", ")}, 100% 100%, 100% 0%)`;
}

function dupLabelFor(stop: TripStop, orderedIds: string[]): string {
  if (!stop.duplicateOf) return "";
  const pos = orderedIds.indexOf(stop.duplicateOf);
  return pos >= 0 ? `stop ${pos + 1}` : "an earlier stop";
}

// Hand-drawn anchor glyph (design.md §2.6: no stock icon set — this is the
// first real icon need in the product, so it's authored here as a wobbly-
// stroke inline SVG rather than reached for from Heroicons/Lucide).
// Exported (Phase B.1) so the read-only share timeline can render the exact
// same booked glyph without duplicating the SVG.
export function AnchorGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <circle cx="8" cy="3.1" r="1.6" stroke="var(--ink-soft)" strokeWidth="1.5" />
      <path d="M8 4.7 L7.9 12.4" stroke="var(--ink-soft)" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5.3 7.5 L10.5 7.7" stroke="var(--ink-soft)" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M3.4 9.2 C3.9 11.8 5.7 13.5 7.9 13.8 C10.3 13.4 12.1 11.9 12.6 9.4"
        stroke="var(--ink-soft)"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

type PlannerSettings = TripDoc["settings"];

// E6b — one visible card = one conflict + the (already dismissal-filtered)
// proposals that resolve it. Computed by RevealClient (it owns `doc`, which
// is what dismissal-keying and day-scope filtering both need — see
// src/lib/planShared.ts); this component only renders what it's given.
export type TradeOffCardEntry = { conflict: Conflict; proposals: Proposal[] };

// E7 — one review chip per llm/user constraint (RevealClient computes these
// from doc.constraints + stopKeys; this component only renders). `value` is
// the raw constraint payload, narrowed per-slot by chipLabel below.
export type ConstraintChipEntry = {
  target: import("@/lib/constraints/persisted").ChipTarget;
  slot: string;
  value: unknown;
  source: "llm" | "user";
  confirmed: boolean;
  evidence?: string;
};

export interface JournalSidebarProps {
  tripId: string;
  dayIndex: number;
  day: TripDay;
  plan: DayPlan;
  orderedIds: string[];
  busy: boolean;
  actionError: string | null;
  settings: PlannerSettings;
  tradeOffCards: TradeOffCardEntry[];
  onReorder: (nextOrder: string[]) => void;
  onReoptimizeDay: () => void;
  onRecookTrip: () => void;
  /** E6c — opens the decision modal (RevealClient owns it, along with the
   * accept/dismiss callbacks that used to come through here); the sidebar
   * only shows the slim "N things need a decision" banner. */
  onOpenDecisions: () => void;
  /** E6c — where the trip sleeps (TripDoc.homeBase); shown + edited in the
   * planner's pocket. null clears it. */
  homeBase: TripDoc["homeBase"];
  onSetHomeBase: (base: { id: string; name: string; location: { lat: number; lng: number } } | null) => void;
  /** E7 — review chips for the active day's stops + the trip panel. */
  constraintChips: { byStopId: Map<string, ConstraintChipEntry[]>; trip: ConstraintChipEntry[] };
  onConfirmChip: (target: ConstraintChipEntry["target"]) => void;
  onDeleteChip: (target: ConstraintChipEntry["target"]) => void;
  onCompileNotes: (notes: string) => Promise<void>;
  onRemoveStop: (stopId: string) => void;
  onToggleLeg: (fromId: string, toId: string, mode: "walk" | "drive") => void;
  onSettingsChange: (settings: PlannerSettings) => void;
}

export function JournalSidebar({
  tripId,
  dayIndex,
  day,
  plan,
  orderedIds,
  busy,
  actionError,
  settings,
  tradeOffCards,
  onReorder,
  onReoptimizeDay,
  onRecookTrip,
  onOpenDecisions,
  homeBase,
  onSetHomeBase,
  constraintChips,
  onConfirmChip,
  onDeleteChip,
  onCompileNotes,
  onRemoveStop,
  onToggleLeg,
  onSettingsChange,
}: JournalSidebarProps) {
  const clipPath = useMemo(tornEdgeClipPath, []);
  const [recookTripConfirming, setRecookTripConfirming] = useState(false);
  useEffect(() => setRecookTripConfirming(false), [dayIndex]);

  // E6b — decorative prose (src/lib/prose/explainTradeoffs.ts), fetched
  // lazily ONLY when there are cards to explain, cached per (day, card set) so
  // an unrelated re-render never re-fetches. Silent on failure: `prose` just
  // stays null and the cards render exactly as fully without it (brief:
  // "decorative; structured cards always render even if the call fails").
  const cardsKey = tradeOffCards.map((c) => c.conflict.id).sort().join("|");
  const [prose, setProse] = useState<string | null>(null);
  const fetchedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (cardsKey === "") {
      setProse(null);
      fetchedKeyRef.current = null;
      return;
    }
    const key = `${dayIndex}:${cardsKey}`;
    if (fetchedKeyRef.current === key) return;
    fetchedKeyRef.current = key;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/trips/${tripId}/explain?day=${dayIndex}`);
        const body = await res.json().catch(() => null);
        if (!cancelled && res.ok) setProse((body as { prose: string | null } | null)?.prose ?? null);
      } catch {
        // decorative — silent, cards render without it
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tripId, dayIndex, cardsKey]);
  const timesAvailable = plan.status === "ok";
  const entriesById = useMemo(() => {
    const map = new Map<string, PlanEntry>();
    if (plan.status === "ok") for (const e of plan.entries) map.set(e.stopId, e);
    return map;
  }, [plan]);
  const stopsById = useMemo(() => new Map(day.stops.map((s) => [s.id, s])), [day.stops]);
  const rows = orderedIds.map((id) => stopsById.get(id)).filter((s): s is TripStop => !!s);

  // T7 — leg lines render only when the plan's order IS the displayed order:
  // during an optimistic drag window (pendingOrder) the plan is stale and
  // legs[i-1] would connect the wrong pair, so they hide until the re-plan
  // lands (§2 semantics come from the plan, never guessed client-side).
  const legs: PlanLeg[] | null = useMemo(() => {
    if (plan.status !== "ok") return null;
    if (plan.order.length !== orderedIds.length) return null;
    for (let i = 0; i < orderedIds.length; i++) {
      if (plan.order[i] !== orderedIds[i]) return null;
    }
    return plan.legs;
  }, [plan, orderedIds]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (busy || !over || active.id === over.id) return;
    const oldIndex = orderedIds.indexOf(String(active.id));
    const newIndex = orderedIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(orderedIds, oldIndex, newIndex));
  }

  // infeasible messages are bare constraint text and need the framing;
  // rejected messages arrive already self-explanatory (the page's plan
  // wrapper writes "This day's plan couldn't be cooked — …"), so framing
  // them again reads twice-prefixed (caught on the visual pass).
  const marginMessage =
    actionError ??
    (plan.status === "infeasible"
      ? `This order can't work — ${plan.message} Drag it back or re-optimize.`
      : plan.status === "rejected"
        ? `${plan.message} Re-optimize, or adjust the day and try again.`
        : null);

  return (
    <aside className="reveal-sidebar" style={{ clipPath }} data-testid="journal-sidebar">
      <div className="reveal-sidebar__scroll">
        {/* M1.5: dayLabel present => `date` is an inert placeholder, so show
            the honest label ("Day 2", "Saturday") rather than a date the user
            never gave. */}
        <h2 className="reveal-sidebar__heading" data-testid="sidebar-day-heading">
          {day.dayLabel ?? fmtDayDate(day.date)}
        </h2>

        {rows.length === 0 ? (
          <p className="reveal-row__wait">No stops on this day yet.</p>
        ) : (
          <>
            {/* E6d — the day leaves the home base and returns to it. Display
                rows only (no drag, no toggle in v1); times come straight off
                the plan's depot legs. Hidden when the plan predates the base
                or the day was manually re-timed without base rows. */}
            {plan.status === "ok" && plan.baseLegs && timesAvailable && (
              <div className="reveal-base-leg" data-testid="sidebar-base-lead">
                leave <strong>{plan.baseLegs.baseName}</strong>{" "}
                {fmtTime(plan.baseLegs.lead.departMin)} — {plan.baseLegs.lead.mode}{" "}
                {formatDuration(plan.baseLegs.lead.effectiveMin)}
              </div>
            )}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
                <ol className="reveal-rows" data-testid="sidebar-rows">
                  {rows.map((stop, i) => (
                    <SidebarRow
                      key={stop.id}
                      stop={stop}
                      index={i}
                      entry={entriesById.get(stop.id)}
                      leg={i > 0 ? (legs?.[i - 1] ?? null) : null}
                      timesAvailable={timesAvailable}
                      busy={busy}
                      dupLabel={dupLabelFor(stop, orderedIds)}
                      chips={constraintChips.byStopId.get(stop.id) ?? []}
                      onConfirmChip={onConfirmChip}
                      onDeleteChip={onDeleteChip}
                      onRemove={onRemoveStop}
                      onToggleLeg={onToggleLeg}
                    />
                  ))}
                </ol>
              </SortableContext>
            </DndContext>
            {plan.status === "ok" && plan.baseLegs && timesAvailable && (
              <div className="reveal-base-leg" data-testid="sidebar-base-back">
                {plan.baseLegs.back.mode} {formatDuration(plan.baseLegs.back.effectiveMin)} — back
                at <strong>{plan.baseLegs.baseName}</strong>{" "}
                {fmtTime(plan.baseLegs.back.arriveMin)}
              </div>
            )}
          </>
        )}

        {plan.status === "ok" && plan.quality === "manual" && (
          <p className="reveal-quality">Your order — Gracie&rsquo;s re-timed it.</p>
        )}
        {plan.status === "ok" && plan.quality === "heuristic" && (
          <p className="reveal-quality">Big day — this is Gracie&rsquo;s best quick route.</p>
        )}

        {/* E5c/E6b — explicit re-cook: day-scoped is the general-purpose
            control (absorbs the old manual-order-only "Re-optimize" button —
            same testid, same handler, now always offered whenever the day has
            stops to reorder, not just after a drag); trip-scope is a smaller,
            confirm-gated affordance since it reshuffles every day at once. */}
        {rows.length > 0 && (
          <div className="reveal-recook">
            <InkButton
              variant="secondary"
              data-testid="sidebar-reoptimize"
              onClick={onReoptimizeDay}
              disabled={busy}
            >
              Re-cook this day
            </InkButton>
            {!recookTripConfirming ? (
              <button
                type="button"
                className="reveal-recook-trip"
                data-testid="sidebar-recook-trip"
                disabled={busy}
                onClick={() => setRecookTripConfirming(true)}
              >
                Re-cook whole trip
              </button>
            ) : (
              <span className="reveal-recook-trip__confirm">
                This reshuffles every day — sure?
                <button
                  type="button"
                  data-testid="sidebar-recook-trip-confirm"
                  disabled={busy}
                  onClick={() => {
                    setRecookTripConfirming(false);
                    onRecookTrip();
                  }}
                >
                  Yes, reshuffle
                </button>
                <button
                  type="button"
                  data-testid="sidebar-recook-trip-cancel"
                  disabled={busy}
                  onClick={() => setRecookTripConfirming(false)}
                >
                  Never mind
                </button>
              </span>
            )}
          </div>
        )}

        {/* E7 — trip-level review chips (pace, quiet blocks): the party's own
            facts, reviewable in one line above the decision banner. */}
        {constraintChips.trip.length > 0 && (
          <div className="reveal-constraint-chips reveal-constraint-chips--trip" data-testid="sidebar-trip-chips">
            <span className="reveal-constraint-chips__label">the trip:</span>
            {constraintChips.trip.map((chip) => (
              <ConstraintChip
                key={`${chip.slot}-${chip.target.scope === "quietBlock" ? chip.target.id : "t"}`}
                chip={chip}
                busy={busy}
                onConfirm={onConfirmChip}
                onDelete={onDeleteChip}
              />
            ))}
          </div>
        )}

        {/* E6c — the card stack became a slim banner (Chris, 2026-08-14): the
            decisions themselves live in RevealClient's TradeOffModal, which
            auto-pops once per new issue set; this banner is the persistent
            way back in. Decorative prose doubles as the banner copy when it
            has arrived (never blocks the count). */}
        {tradeOffCards.length > 0 && (
          <div className="reveal-decision-banner" data-testid="sidebar-tradeoffs">
            <p className="reveal-decision-banner__text" data-testid="sidebar-tradeoffs-prose">
              {prose ??
                (tradeOffCards.length === 1
                  ? "One thing needs a decision."
                  : `${tradeOffCards.length} things need a decision.`)}
            </p>
            <InkButton data-testid="tradeoff-banner-open" onClick={onOpenDecisions} disabled={busy}>
              Decide now
            </InkButton>
          </div>
        )}

        {marginMessage && (
          <p className="reveal-margin-note" data-testid="sidebar-margin-note">
            {marginMessage}
          </p>
        )}

        {/* E3 — advisory opening-hours warnings (src/lib/plan/hoursAdvisory.ts).
            Distinct testid from sidebar-margin-note above: these are
            per-visit advisories on an OK plan, not the single
            infeasible/rejected/actionError framing that block covers. */}
        {plan.status === "ok" &&
          plan.marginNotes?.map((note, i) => (
            <p key={i} className="reveal-margin-note" data-testid="sidebar-hours-note">
              {note}
            </p>
          ))}

        {/* T7 — §2 LOCKED surface: the planner's notes pocket. */}
        <details className="reveal-pocket" data-testid="sidebar-pocket">
          <summary>planner&rsquo;s notes</summary>
          <HomeBasePocket tripId={tripId} homeBase={homeBase} busy={busy} onSetHomeBase={onSetHomeBase} />
          <NotesPocket busy={busy} onCompile={onCompileNotes} />
          <PocketForm settings={settings} busy={busy} onApply={onSettingsChange} />
        </details>

        <a
          href={`/share/${tripId}`}
          className="journal-btn journal-btn--primary reveal-share"
          data-testid="sidebar-share"
        >
          Share this plan
        </a>
      </div>
    </aside>
  );
}

// E7 — chip copy per slot, journal voice. `value` narrowed by slot; a shape
// this function doesn't recognize renders the slot name (never crashes).
function chipLabel(chip: ConstraintChipEntry): string {
  const v = chip.value;
  switch (chip.slot) {
    case "window": {
      const w = v as { startMin: number; endMin: number };
      return `${fmtTime(w.startMin)}–${fmtTime(w.endMin)}`;
    }
    case "hours": {
      const h = v as { lastEntryMin?: number };
      return h.lastEntryMin !== undefined ? `last entry ${fmtTime(h.lastEntryMin)}` : "opening hours";
    }
    case "duration": {
      const d = v as { typicalMin: number };
      return `~${formatDuration(d.typicalMin)} visit`;
    }
    case "effort":
      return `${String(v)} effort`;
    case "priority":
      return v === "must" ? "must-see" : v === "could" ? "if there's time" : "should-see";
    case "pinnedDay": {
      const p = v as { index: number };
      return `day ${p.index + 1}`;
    }
    case "pacePreset":
      return v === "relaxed" ? "chill pace" : v === "packed" ? "packed pace" : "balanced pace";
    case "quietBlock": {
      const w = v as { startMin: number; endMin: number };
      return `quiet ${fmtTime(w.startMin)}–${fmtTime(w.endMin)}`;
    }
    default:
      return chip.slot;
  }
}

/** One review chip: label, the quote that justifies it, confirm (llm,
 * unconfirmed only) and delete. */
function ConstraintChip({
  chip,
  busy,
  onConfirm,
  onDelete,
}: {
  chip: ConstraintChipEntry;
  busy: boolean;
  onConfirm: (target: ConstraintChipEntry["target"]) => void;
  onDelete: (target: ConstraintChipEntry["target"]) => void;
}) {
  return (
    <span
      className={`reveal-constraint-chip${chip.confirmed ? " reveal-constraint-chip--confirmed" : ""}`}
      data-testid="constraint-chip"
      data-chip-slot={chip.slot}
      data-chip-confirmed={chip.confirmed ? "1" : "0"}
      title={chip.evidence ? `from your notes: “${chip.evidence}”` : "you set this"}
    >
      <span className="reveal-constraint-chip__label">{chipLabel(chip)}</span>
      {chip.evidence && (
        <span className="reveal-constraint-chip__evidence">&ldquo;{chip.evidence}&rdquo;</span>
      )}
      {!chip.confirmed && (
        <button
          type="button"
          className="reveal-constraint-chip__btn"
          data-testid="constraint-chip-confirm"
          aria-label={`Confirm ${chipLabel(chip)}`}
          disabled={busy}
          onClick={() => onConfirm(chip.target)}
        >
          ✓
        </button>
      )}
      <button
        type="button"
        className="reveal-constraint-chip__btn"
        data-testid="constraint-chip-delete"
        aria-label={`Remove ${chipLabel(chip)}`}
        disabled={busy}
        onClick={() => onDelete(chip.target)}
      >
        ×
      </button>
    </span>
  );
}

function SidebarRow({
  stop,
  index,
  entry,
  leg,
  timesAvailable,
  busy,
  dupLabel,
  chips,
  onConfirmChip,
  onDeleteChip,
  onRemove,
  onToggleLeg,
}: {
  stop: TripStop;
  index: number;
  entry: PlanEntry | undefined;
  leg: PlanLeg | null;
  timesAvailable: boolean;
  busy: boolean;
  dupLabel: string;
  chips: ConstraintChipEntry[];
  onConfirmChip: (target: ConstraintChipEntry["target"]) => void;
  onDeleteChip: (target: ConstraintChipEntry["target"]) => void;
  onRemove: (stopId: string) => void;
  onToggleLeg: (fromId: string, toId: string, mode: "walk" | "drive") => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: stop.id,
    disabled: busy,
  });
  const isBooked = !!stop.anchor;

  const rowStyle: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  const handleStyle: CSSProperties = { transform: `rotate(${isBooked ? -1 : rotateFor(index)}deg)` };

  return (
    <li ref={setNodeRef} style={rowStyle} className="reveal-row" data-testid={`sidebar-row-${stop.id}`}>
      <WashiTag
        as="button"
        ref={setActivatorNodeRef}
        tone={isBooked ? "washi" : toneFor(index)}
        className="reveal-row__handle"
        style={handleStyle}
        disabled={busy}
        aria-label={isBooked ? `Booked — ${stop.name}, drag to reorder` : `Drag to reorder ${stop.name}`}
        data-testid={`sidebar-handle-${stop.id}`}
        {...attributes}
        {...listeners}
      >
        {isBooked ? "✓ Booked" : ""}
      </WashiTag>

      <div className="reveal-row__body">
        {/* T7 — the leg from the previous stop: mode + BOTH times when the
            walk is eligible (§2 decide-then-offer), toggle persists the pick */}
        {leg && (
          <div className="reveal-leg" data-testid={`sidebar-leg-${leg.fromId}-${leg.toId}`}>
            <span className="reveal-leg__mode" data-testid="sidebar-leg-mode">
              {leg.mode}
            </span>
            <span data-testid="sidebar-leg-times">
              {leg.walkMin !== null
                ? `walk ${formatDuration(leg.walkMin)} · drive ${formatDuration(leg.driveMin)}`
                : `drive ${formatDuration(leg.driveMin)}`}
              {leg.chosenBy === "user" ? " — your pick" : ""}
            </span>
            {leg.walkMin !== null && (
              <button
                type="button"
                className="reveal-leg__toggle"
                data-testid={`sidebar-toggle-${leg.fromId}-${leg.toId}`}
                onClick={() => onToggleLeg(leg.fromId, leg.toId, leg.mode === "walk" ? "drive" : "walk")}
                disabled={busy}
              >
                take the {leg.mode === "walk" ? "drive" : "walk"}
              </button>
            )}
          </div>
        )}
        <div className="reveal-row__head">
          {timesAvailable && (
            <span className="reveal-row__time" data-testid={`sidebar-time-${stop.id}`}>
              {isBooked
                ? `anchored ${fmtTime(stop.anchor!.startMin)}`
                : entry
                  ? `${fmtTime(entry.startMin)}–${fmtTime(entry.departMin)}`
                  : ""}
            </span>
          )}
          <span className="reveal-row__name" data-testid={`sidebar-name-${stop.id}`}>
            {isBooked && <AnchorGlyph />}
            {stop.name}
          </span>
        </div>
        {timesAvailable && entry && entry.waitMin > 0 && (
          <div className="reveal-row__wait">waits {formatDuration(entry.waitMin)}</div>
        )}
        {stop.duplicateOf && (
          <div className="reveal-row__dup" data-testid={`sidebar-dup-note-${stop.id}`}>
            same place as {dupLabel} — remove if it snuck in twice?{" "}
            <button
              type="button"
              className="reveal-row__remove-btn"
              data-testid={`sidebar-remove-${stop.id}`}
              onClick={() => onRemove(stop.id)}
              disabled={busy}
            >
              remove
            </button>
          </div>
        )}
        {/* E7 — this stop's review chips (compiled from notes / user edits). */}
        {chips.length > 0 && (
          <div className="reveal-constraint-chips" data-testid={`sidebar-chips-${stop.id}`}>
            {chips.map((chip) => (
              <ConstraintChip
                key={`${chip.slot}`}
                chip={chip}
                busy={busy}
                onConfirm={onConfirmChip}
                onDelete={onDeleteChip}
              />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

// T7 — the planner's notes form. Local drafts commit on Apply (not per
// keystroke: every apply is a PUT + a re-plan of EVERY day, so it should be
// one deliberate action). Drafts re-seed whenever the saved settings change.
// E7 — "tell Gracie more": free-form notes -> the constraint compiler ->
// review chips. One deliberate action (a compile is a rate-limited, possibly
// billed call + a re-plan), mirroring PocketForm's commit-on-apply shape.
function NotesPocket({
  busy,
  onCompile,
}: {
  busy: boolean;
  onCompile: (notes: string) => Promise<void>;
}) {
  const [notes, setNotes] = useState("");
  const submit = async () => {
    const text = notes.trim();
    if (text === "" || busy) return;
    await onCompile(text);
    setNotes("");
  };
  return (
    <div className="reveal-notes-pocket" data-testid="sidebar-notes">
      <textarea
        className="reveal-notes-pocket__input"
        data-testid="sidebar-notes-input"
        placeholder="tell Gracie more — “mum walks slow”, “sunset at the park”, “last entry 5pm”…"
        rows={2}
        value={notes}
        disabled={busy}
        onChange={(e) => setNotes(e.target.value)}
      />
      <InkButton
        data-testid="sidebar-notes-compile"
        disabled={busy || notes.trim() === ""}
        onClick={() => void submit()}
      >
        Read my notes
      </InkButton>
    </div>
  );
}

// E6c — the "staying at" row in the planner's pocket. Detection from the
// paste fills this automatically; here the user can set/override/clear it.
// Resolution goes through the same metered, rate-limited server boundary
// every other place lookup uses (POST /api/trips/[id]/resolve — key never on
// the client, one billed lookup per set).
function HomeBasePocket({
  tripId,
  homeBase,
  busy,
  onSetHomeBase,
}: {
  tripId: string;
  homeBase: TripDoc["homeBase"];
  busy: boolean;
  onSetHomeBase: (base: { id: string; name: string; location: { lat: number; lng: number } } | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const q = query.trim();
    if (!q || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/trips/${tripId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: [q] }),
      });
      const body = (await res.json().catch(() => null)) as {
        stops?: Array<{ id: string; name: string; location: { lat: number; lng: number } }>;
      } | null;
      const stop = res.ok ? body?.stops?.[0] : undefined;
      if (!stop) {
        setError("Couldn't find that place — try its full name?");
        return;
      }
      onSetHomeBase({ id: stop.id, name: stop.name, location: stop.location });
      setEditing(false);
      setQuery("");
    } catch {
      setError("Couldn't find that place — try again?");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="reveal-homebase" data-testid="sidebar-homebase">
      <span className="reveal-homebase__label">staying at</span>
      {homeBase && !editing ? (
        <>
          <span className="reveal-homebase__name" data-testid="sidebar-homebase-name">
            {homeBase.name}
          </span>
          <button
            type="button"
            className="reveal-homebase__link"
            data-testid="sidebar-homebase-change"
            disabled={busy}
            onClick={() => {
              setQuery(homeBase.name);
              setEditing(true);
            }}
          >
            change
          </button>
          <button
            type="button"
            className="reveal-homebase__link"
            data-testid="sidebar-homebase-clear"
            disabled={busy}
            onClick={() => onSetHomeBase(null)}
          >
            clear
          </button>
        </>
      ) : (
        <>
          <input
            className="reveal-homebase__input"
            data-testid="sidebar-homebase-input"
            placeholder="hotel, airbnb…"
            value={query}
            disabled={busy || pending}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          <button
            type="button"
            className="reveal-homebase__link"
            data-testid="sidebar-homebase-set"
            disabled={busy || pending || query.trim() === ""}
            onClick={() => void submit()}
          >
            {pending ? "finding…" : "set"}
          </button>
          {homeBase && (
            <button
              type="button"
              className="reveal-homebase__link"
              disabled={busy || pending}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              cancel
            </button>
          )}
        </>
      )}
      {error && (
        <span className="reveal-homebase__error" data-testid="sidebar-homebase-error">
          {error}
        </span>
      )}
    </div>
  );
}

function PocketForm({
  settings,
  busy,
  onApply,
}: {
  settings: PlannerSettings;
  busy: boolean;
  onApply: (settings: PlannerSettings) => void;
}) {
  const [walkMax, setWalkMax] = useState(String(settings.walkMax));
  const [overhead, setOverhead] = useState(String(settings.driveOverheadMin));
  useEffect(() => {
    setWalkMax(String(settings.walkMax));
    setOverhead(String(settings.driveOverheadMin));
  }, [settings]);

  const parse = (s: string) => {
    const n = Number(s);
    return s.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 120 ? n : null;
  };
  const w = parse(walkMax);
  const o = parse(overhead);
  const unchanged = w === settings.walkMax && o === settings.driveOverheadMin;

  return (
    <div className="reveal-pocket__form">
      <label>
        walks up to
        <input
          type="number"
          min={0}
          max={120}
          value={walkMax}
          data-testid="sidebar-walkmax"
          onChange={(e) => setWalkMax(e.target.value)}
        />
        min
      </label>
      <label>
        driving adds
        <input
          type="number"
          min={0}
          max={120}
          value={overhead}
          data-testid="sidebar-overhead"
          onChange={(e) => setOverhead(e.target.value)}
        />
        min overhead
      </label>
      <InkButton
        variant="secondary"
        data-testid="sidebar-settings-apply"
        disabled={busy || w === null || o === null || unchanged}
        onClick={() => {
          if (w !== null && o !== null) onApply({ walkMax: w, driveOverheadMin: o });
        }}
      >
        Apply
      </InkButton>
    </div>
  );
}
