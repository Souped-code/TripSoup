"use client";

// D2.3 T6 — the reveal sidebar: a torn journal page with the day's itinerary
// as a handwritten-style list. Drag handles are WashiTag strips (dnd-kit
// pointer + keyboard sensors); dropping a row hands the new order up to
// RevealClient, which persists it as manualOrder and re-plans. RevealMap
// plays the pencil-scribble sfx and re-sketches on its own whenever the
// orderedIds prop changes — this component never triggers either directly.

import { useMemo, type CSSProperties } from "react";
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
import type { TripDay, TripStop } from "@/lib/store/types";
import type { DayPlan, PlanEntry } from "@/lib/schedule/types";
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

export interface JournalSidebarProps {
  tripId: string;
  day: TripDay;
  plan: DayPlan;
  orderedIds: string[];
  busy: boolean;
  actionError: string | null;
  onReorder: (nextOrder: string[]) => void;
  onReoptimize: () => void;
  onRemoveStop: (stopId: string) => void;
}

export function JournalSidebar({
  tripId,
  day,
  plan,
  orderedIds,
  busy,
  actionError,
  onReorder,
  onReoptimize,
  onRemoveStop,
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
                    timesAvailable={timesAvailable}
                    busy={busy}
                    dupLabel={dupLabelFor(stop, orderedIds)}
                    onRemove={onRemoveStop}
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
  timesAvailable,
  busy,
  dupLabel,
  onRemove,
}: {
  stop: TripStop;
  index: number;
  entry: PlanEntry | undefined;
  timesAvailable: boolean;
  busy: boolean;
  dupLabel: string;
  onRemove: (stopId: string) => void;
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
