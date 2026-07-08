// Phase B.1 — the read-only journal timeline for ONE day, used by the share
// view (/share/[id]). Mirrors JournalSidebar.tsx's VISUAL (the torn page,
// the rows, the leg lines, the booked washi tag) with every mutation
// surface stripped: no drag handle, no leg toggle, no re-optimize, no
// planner's-notes pocket, no share button. Purely presentational, so this
// stays a server component — no "use client", no hooks, no event handlers.
// WashiTag/AnchorGlyph are themselves client components (from "use client"
// modules), but rendering them here as static, handler-less JSX is a normal
// server-component-renders-client-component boundary, not a reason for this
// file to become a client component itself.
//
// One deliberate content divergence from the sidebar, called out at the
// booked-time comment below: the `entry-time` testid must stay byte-identical
// to the legacy PlanView's format so e2e/share.spec.ts's owner-vs-share
// comparison keeps passing.

import type { TripDay, TripStop } from "@/lib/store/types";
import type { DayPlan, PlanEntry, PlanLeg } from "@/lib/schedule/types";
import { WashiTag, type WashiTone } from "@/ui/journal/WashiTag";
import { AnchorGlyph } from "./JournalSidebar";
import { fmtTime } from "@/ui/time";
import "./reveal.css";

const TONE_CYCLE: WashiTone[] = ["coral", "sky", "pink", "leaf"];
// Hand-placed jauntiness (design.md §2.7) — duplicated from JournalSidebar.tsx
// (see that file's matching note): short arrays like this are cheaper to
// keep in sync by eye across a few consumers than a shared module would be
// to maintain for them.
const ROTATE_CYCLE = [-4, 3, -3, 4, -2, 2];
function toneFor(i: number): WashiTone {
  return TONE_CYCLE[i % TONE_CYCLE.length];
}
function rotateFor(i: number): number {
  return ROTATE_CYCLE[i % ROTATE_CYCLE.length];
}

// Copied verbatim from JournalSidebar.tsx (not exported there — see this
// component's brief: copying this small pure helper is fine and keeps the
// LOCKED sidebar file untouched).
function fmtDayDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

// Irregular hand-torn left edge — copied verbatim from JournalSidebar.tsx. A
// fixed wobble sequence, not Math.random(): this renders on the server only
// (no client re-render of this component to mismatch against), but the
// constant is kept identical anyway so the two torn pages read as the same
// page type.
const TORN_WOBBLE = [
  2, 3.5, 0.8, 2.6, 1.2, 3.2, 0, 2.2, 3.6, 1.6, 0.4, 2.8, 3.4, 1, 0.2, 2.4, 3.8, 1.4, 2, 0.6, 3, 1.8,
];
function tornEdgeClipPath(): string {
  const steps = TORN_WOBBLE.length - 1;
  const left = TORN_WOBBLE.map((x, i) => `${x}px ${(i * 100) / steps}%`);
  return `polygon(${left.join(", ")}, 100% 100%, 100% 0%)`;
}

export interface ShareTimelineProps {
  day: TripDay;
  plan: DayPlan;
  orderedIds: string[];
}

export function ShareTimeline({ day, plan, orderedIds }: ShareTimelineProps) {
  const clipPath = tornEdgeClipPath();
  const timesAvailable = plan.status === "ok";

  const entriesById = new Map<string, PlanEntry>();
  if (plan.status === "ok") for (const e of plan.entries) entriesById.set(e.stopId, e);

  const stopsById = new Map(day.stops.map((s) => [s.id, s]));
  const rows = orderedIds.map((id) => stopsById.get(id)).filter((s): s is TripStop => !!s);

  // Same rule as JournalSidebar's `legs` memo: leg[i-1] only renders when the
  // plan's solved order IS the displayed order — a stale/manual mismatch
  // would connect the wrong pair of stops.
  let legs: PlanLeg[] | null = null;
  if (plan.status === "ok" && plan.order.length === orderedIds.length) {
    let matches = true;
    for (let i = 0; i < orderedIds.length; i++) {
      if (plan.order[i] !== orderedIds[i]) {
        matches = false;
        break;
      }
    }
    if (matches) legs = plan.legs;
  }

  // infeasible/rejected read-only note — reuses JournalSidebar's margin-note
  // framing, minus the "drag it back / re-optimize" call to action (there is
  // nothing to act on here).
  const marginMessage =
    plan.status === "infeasible"
      ? `This order can't work — ${plan.message}`
      : plan.status === "rejected"
        ? plan.message
        : null;

  return (
    <aside className="reveal-sidebar" style={{ clipPath }} data-testid="share-timeline">
      <div className="reveal-sidebar__scroll">
        <h2 className="reveal-sidebar__heading">{fmtDayDate(day.date)}</h2>

        {rows.length === 0 ? (
          <p className="reveal-row__wait">No stops on this day yet.</p>
        ) : (
          <ol className="reveal-rows" data-testid="share-rows">
            {rows.map((stop, i) => {
              const entry = entriesById.get(stop.id);
              const leg = i > 0 ? (legs?.[i - 1] ?? null) : null;
              const isBooked = !!stop.anchor;

              return (
                // testid mirrors the legacy PlanView's `entry-${stopId}` wrapper
                // (not just entry-name/entry-time) — e2e/fullflow.spec.ts derives
                // the share page's full stop-id order from these containers.
                <li key={stop.id} className="reveal-row" data-testid={`entry-${stop.id}`}>
                  {/* Static booked/tone handle — same tape look as the sidebar's
                      drag handle, but a plain span: no ref, no listeners, no
                      button semantics (nothing here is draggable or clickable). */}
                  <WashiTag
                    tone={isBooked ? "washi" : toneFor(i)}
                    className="reveal-row__handle"
                    style={{ transform: `rotate(${isBooked ? -1 : rotateFor(i)}deg)` }}
                  >
                    {isBooked ? "✓ Booked" : ""}
                  </WashiTag>

                  <div className="reveal-row__body">
                    {leg && (
                      <div className="reveal-leg" data-testid={`leg-${leg.fromId}-${leg.toId}`}>
                        <span className="reveal-leg__mode" data-testid="leg-mode">
                          {leg.mode}
                        </span>
                        <span>
                          {leg.walkMin !== null
                            ? `walk ${Math.round(leg.walkMin)} min · drive ${Math.round(leg.driveMin)} min`
                            : `drive ${Math.round(leg.driveMin)} min`}
                          {leg.chosenBy === "user" ? " — your pick" : ""}
                        </span>
                        {/* no toggle button — read-only */}
                      </div>
                    )}
                    <div className="reveal-row__head">
                      {/* entry-time is deliberately ALWAYS startMin–departMin
                          (never the sidebar's "anchored HH:MM" wording) — this
                          testid/format must stay byte-identical to the legacy
                          PlanView's entry-time so e2e/share.spec.ts's
                          owner-vs-share comparison keeps passing regardless of
                          whether either day has a booked stop. */}
                      {timesAvailable && entry && (
                        <span className="reveal-row__time" data-testid="entry-time">
                          {`${fmtTime(entry.startMin)}–${fmtTime(entry.departMin)}`}
                        </span>
                      )}
                      <span className="reveal-row__name" data-testid="entry-name">
                        {isBooked && <AnchorGlyph />}
                        {stop.name}
                      </span>
                    </div>
                    {timesAvailable && entry && entry.waitMin > 0 && (
                      <div className="reveal-row__wait">waits {Math.round(entry.waitMin)} min</div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {plan.status === "ok" && plan.quality === "manual" && (
          <p className="reveal-quality">Their order — Gracie&rsquo;s re-timed it.</p>
        )}
        {plan.status === "ok" && plan.quality === "heuristic" && (
          <p className="reveal-quality">Big day — this is Gracie&rsquo;s best quick route.</p>
        )}

        {marginMessage && (
          <p className="reveal-margin-note" data-testid="share-margin-note">
            {marginMessage}
          </p>
        )}
      </div>
    </aside>
  );
}
