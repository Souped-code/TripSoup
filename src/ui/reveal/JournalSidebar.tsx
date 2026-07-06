"use client";

// D2.3 T6 — the reveal sidebar: a torn journal page with the day's itinerary
// as a handwritten-style list. Drag handles are WashiTag strips (dnd-kit
// pointer + keyboard sensors); dropping a row hands the new order up to
// RevealClient, which persists it as manualOrder and re-plans. RevealMap
// plays the pencil-scribble sfx and re-sketches on its own whenever the
// orderedIds prop changes — this component never triggers either directly.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
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
function AnchorGlyph() {
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

export interface JournalSidebarProps {
  tripId: string;
  day: TripDay;
  plan: DayPlan;
  orderedIds: string[];
  busy: boolean;
  actionError: string | null;
  settings: PlannerSettings;
  onReorder: (nextOrder: string[]) => void;
  onReoptimize: () => void;
  onRemoveStop: (stopId: string) => void;
  onToggleLeg: (fromId: string, toId: string, mode: "walk" | "drive") => void;
  onSettingsChange: (settings: PlannerSettings) => void;
}

export function JournalSidebar({
  tripId,
  day,
  plan,
  orderedIds,
  busy,
  actionError,
  settings,
  onReorder,
  onReoptimize,
  onRemoveStop,
  onToggleLeg,
  onSettingsChange,
}: JournalSidebarProps) {
  const clipPath = useMemo(tornEdgeClipPath, []);
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
        <h2 className="reveal-sidebar__heading">{fmtDayDate(day.date)}</h2>

        {rows.length === 0 ? (
          <p className="reveal-row__wait">No stops on this day yet.</p>
        ) : (
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
                    onRemove={onRemoveStop}
                    onToggleLeg={onToggleLeg}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        )}

        {plan.status === "ok" && plan.quality === "manual" && (
          <div className="reveal-quality">
            <span>Your order — Gracie&rsquo;s re-timed it.</span>
            <InkButton variant="secondary" data-testid="sidebar-reoptimize" onClick={onReoptimize} disabled={busy}>
              Re-optimize
            </InkButton>
          </div>
        )}
        {plan.status === "ok" && plan.quality === "heuristic" && (
          <p className="reveal-quality">Big day — this is Gracie&rsquo;s best quick route.</p>
        )}

        {marginMessage && (
          <p className="reveal-margin-note" data-testid="sidebar-margin-note">
            {marginMessage}
          </p>
        )}

        {/* T7 — §2 LOCKED surface: the planner's notes pocket. */}
        <details className="reveal-pocket" data-testid="sidebar-pocket">
          <summary>planner&rsquo;s notes</summary>
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

function SidebarRow({
  stop,
  index,
  entry,
  leg,
  timesAvailable,
  busy,
  dupLabel,
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
                ? `walk ${Math.round(leg.walkMin)} min · drive ${Math.round(leg.driveMin)} min`
                : `drive ${Math.round(leg.driveMin)} min`}
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
          <div className="reveal-row__wait">waits {Math.round(entry.waitMin)} min</div>
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
      </div>
    </li>
  );
}

// T7 — the planner's notes form. Local drafts commit on Apply (not per
// keystroke: every apply is a PUT + a re-plan of EVERY day, so it should be
// one deliberate action). Drafts re-seed whenever the saved settings change.
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
