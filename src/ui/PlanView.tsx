"use client";

// Result view — §5 P4: timeline entries, legs labelled walk/drive, eligible
// legs show BOTH times with a per-leg toggle (decide-then-offer, §2), heuristic
// state visible. Read-only mode reuses this for the P5 share view.

import type { DayPlan } from "@/lib/schedule/types";
import { fmtTime } from "./time";

export function PlanView({
  plan,
  stopNames,
  onToggleLeg,
  readOnly,
}: {
  plan: DayPlan;
  stopNames: Record<string, string>;
  onToggleLeg?: (fromId: string, toId: string, mode: "walk" | "drive") => void;
  readOnly?: boolean;
}) {
  if (plan.status === "rejected") {
    return (
      <div className="infeasible" data-testid="rejected-report">
        <strong>Too many stops to optimize.</strong>
        <div>{plan.message}</div>
      </div>
    );
  }

  if (plan.status === "infeasible") {
    return (
      <div className="infeasible" data-testid="infeasible-report">
        <strong>This day doesn&rsquo;t fit.</strong>
        <div data-testid="infeasible-constraint">
          Violated: <code>{plan.constraint}</code> by {Math.ceil(plan.violatedByMin)} min
        </div>
        <div>{plan.message}</div>
      </div>
    );
  }

  return (
    <div data-testid="plan">
      <div className="row">
        <span className={`badge ${plan.quality}`} data-testid="quality-badge">
          {plan.quality === "heuristic" ? "heuristic — near-best order" : "optimal order"}
        </span>
        <span className="muted">
          travel {Math.round(plan.totalTravelMin)} min · slack at day end{" "}
          {Math.round(plan.daySlackMin)} min
        </span>
      </div>
      <ol style={{ listStyle: "none", padding: 0 }} data-testid="plan-entries">
        {plan.entries.map((entry, i) => {
          const leg = i > 0 ? plan.legs[i - 1] : null;
          return (
            <li key={entry.stopId}>
              {leg && (
                <div className="plan-leg" data-testid={`leg-${leg.fromId}-${leg.toId}`}>
                  <span className={`badge ${leg.mode}`} data-testid="leg-mode">
                    {leg.mode}
                  </span>
                  <span data-testid="leg-times">
                    {leg.walkMin !== null
                      ? `walk ${Math.round(leg.walkMin)} min / drive ${Math.round(leg.driveMin)} min (+overhead)`
                      : `drive ${Math.round(leg.driveMin)} min (+overhead)`}
                  </span>
                  <span className="muted">
                    {fmtTime(leg.departMin)} → {fmtTime(leg.arriveMin)}
                  </span>
                  {!readOnly && leg.walkMin !== null && onToggleLeg && (
                    <button
                      data-testid={`toggle-${leg.fromId}-${leg.toId}`}
                      onClick={() =>
                        onToggleLeg(leg.fromId, leg.toId, leg.mode === "walk" ? "drive" : "walk")
                      }
                    >
                      switch to {leg.mode === "walk" ? "drive" : "walk"}
                    </button>
                  )}
                </div>
              )}
              <div className="plan-entry" data-testid={`entry-${entry.stopId}`}>
                <span className="time" data-testid="entry-time">
                  {fmtTime(entry.startMin)}–{fmtTime(entry.departMin)}
                </span>
                <span data-testid="entry-name">{stopNames[entry.stopId] ?? entry.stopId}</span>
                {entry.kind === "anchor" && <span className="badge anchor">booked</span>}
                {entry.waitMin > 0 && (
                  <span className="muted">arrive {fmtTime(entry.arriveMin)}, wait {Math.round(entry.waitMin)} min</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
