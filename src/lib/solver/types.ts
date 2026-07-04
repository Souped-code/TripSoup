// Solver domain types — §1/§2 (LOCKED).

// One leg of the effective matrix (§2, decide-then-offer). Eligible legs retain
// BOTH times so the UI can show them side by side with a per-leg toggle.
export type EffectiveLeg = {
  mode: "walk" | "drive";
  walkMin: number | null; // null when the pair is not walk-eligible
  driveMin: number; // raw drive minutes (API/fixture) — overhead NOT folded in
  chosenBy: "auto" | "user";
};

export type EffectiveMatrix = Record<string, Record<string, EffectiveLeg>>;

export type SolverStop = {
  id: string;
  durationMin: number; // estimated visit duration
};

// A "visit beforeId before afterId" ordering constraint (D2.1b). Only pairs
// whose BOTH ids are flexible stops of the same segment reach the solver; the
// day layer handles cross-segment / cross-day pairs (§ planDay).
export type PrecedencePair = {
  beforeId: string;
  afterId: string;
};

// A maximal run of flexible stops between consecutive anchors, or between an
// anchor and the day's start/end (§1). Anchor times are segment boundaries —
// they are inputs, structurally immovable.
export type Segment = {
  startAtMin: number; // clock at which the segment begins (dep. from start anchor, or day start)
  startStopId: string | null; // travel origin (start anchor), null = day start (no inbound leg)
  endByMin: number; // latest allowed arrival at the end boundary (end anchor start, or day end)
  endStopId: string | null; // travel destination (end anchor), null = day end (no outbound leg)
  stops: SolverStop[]; // the flexible stops to order
};

export type ScheduleEntry = {
  stopId: string;
  arriveMin: number;
  departMin: number;
};

export type SolveResult =
  | {
      status: "ok";
      order: string[]; // stop ids, visit order
      schedule: ScheduleEntry[];
      quality: "optimal" | "heuristic";
      totalTravelMin: number;
    }
  | {
      status: "infeasible";
      constraint: string; // which constraint is violated
      violatedByMin: number; // by how much, in the least-violating ordering examined
      message: string;
    }
  | {
      status: "rejected"; // > maxHeuristic flexible stops
      message: string; // actionable: split the segment or add an anchor
    };
