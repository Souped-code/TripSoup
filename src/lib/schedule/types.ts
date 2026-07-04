// Day-level schedule types — §1 (LOCKED) + §4 trip document shape.
// Anchors are marked inline on stops; a day's stop list is ordered, and runs of
// flexible stops between anchors (in list order) form the solver segments.

export type DayStop = {
  id: string;
  name: string;
  durationMin: number;
  anchor?: { startMin: number }; // fixed start time — immovable (§1)
};

export type Day = {
  date: string; // ISO date, e.g. "2026-07-10"
  dayStartMin: number; // minutes from midnight
  dayEndMin: number;
  stops: DayStop[];
  // Optional precedence wishes (D2.1b). See planDay for how each pair is routed
  // (within-segment / cross-segment / cross-day).
  precedence?: Array<{ beforeId: string; afterId: string; reason?: string }>;
};

export type PlanEntry = {
  stopId: string;
  kind: "anchor" | "flexible";
  arriveMin: number; // when you get there
  startMin: number; // when the visit starts (anchor: its fixed time; flexible: = arrive)
  departMin: number; // startMin + duration
  waitMin: number; // startMin - arriveMin — slack absorbed waiting at this stop
};

export type PlanLeg = {
  fromId: string;
  toId: string;
  mode: "walk" | "drive";
  walkMin: number | null; // both times retained on eligible legs (§2 decide-then-offer)
  driveMin: number;
  effectiveMin: number; // active mode's schedule time (walk est. | drive + overhead)
  chosenBy: "auto" | "user";
  departMin: number;
  arriveMin: number;
};

export type DayPlan =
  | {
      status: "ok";
      order: string[]; // full visit order including anchors
      entries: PlanEntry[];
      legs: PlanLeg[];
      quality: "optimal" | "heuristic"; // heuristic if ANY segment was heuristic
      totalTravelMin: number;
      daySlackMin: number; // day window left after the last departure
      marginNotes?: string[]; // soft advisories (e.g. cross-day precedence wishes)
    }
  | {
      status: "infeasible";
      constraint: string;
      violatedByMin: number;
      message: string;
    }
  | { status: "rejected"; message: string };
