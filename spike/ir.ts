// E1 spike — the problem IR both solver contenders consume. FROZEN for the
// duration of the spike: the generator, the shared evaluator, the TS ALNS
// prototype, and the CP-SAT worker all build against exactly this shape, so a
// mid-spike change here invalidates every cached artifact. Promoted (with
// whatever the spike taught us) into src/lib/constraints/ at E2.
//
// Everything is minutes-from-midnight local time and day INDEXES (0-based),
// matching the repo's schedule-math convention (see src/lib/schedule/). No
// Date objects anywhere — determinism is part of the contract.
//
// This file is plain types + tiny pure helpers. No I/O, no deps.

export type Minutes = number;

/** [startMin, endMin] inclusive-start exclusive-nothing — a stop must START
 * within the window; see evaluator for the exact semantics. */
export type Window = { startMin: Minutes; endMin: Minutes };

/** Per-weekday open intervals, 0 = Monday .. 6 = Sunday (ISO). Empty array =
 * closed that day. lastEntryMin, when present, caps the latest allowed START
 * (models "last entry 16:30" attractions). */
export type WeeklyHours = {
  byWeekday: ReadonlyArray<ReadonlyArray<Window>>; // length 7
  lastEntryMin?: Minutes;
};

export type Effort = "low" | "medium" | "high";
export type Priority = "must" | "should" | "could";

export type SpikeStop = {
  id: string;
  /** Synthetic planar coordinates in KM (not lat/lng — the spike's travel
   * function is straight-line over these; production swaps in the real
   * matrix behind the same travelMin signature). */
  x: number;
  y: number;
  duration: { minMin: Minutes; typicalMin: Minutes; maxMin: Minutes };
  /** Visit-start window, already day-concrete (generator resolves hours ×
   * weekday down to this when it plants one). */
  window?: Window;
  /** Weekly hours — the evaluator intersects these with the day the stop is
   * scheduled on. Present on a subset of stops (attractions/restaurants). */
  hours?: WeeklyHours;
  effort: Effort;
  priority: Priority;
  /** Day index this stop must (hard) land on. The spike ALWAYS sets hardness
   * "hard" when pinning — soft pins are an E5+ production concern, but the
   * field carries hardness now so the shape never changes. Absent = engine
   * assigns the day freely. */
  pinnedDay?: { index: number; hardness: "hard" | "soft" };
};

export type SpikeRelation =
  | { kind: "precedence"; beforeId: string; afterId: string }
  | { kind: "sameDay"; aId: string; bId: string }
  | { kind: "notSameDay"; aId: string; bId: string };

export type SpikeDay = {
  /** ISO weekday 0=Mon..6=Sun — what WeeklyHours intersect against. */
  weekday: number;
  window: Window; // day start/end
  /** Blocks during which no stop may START (meal reservations owned by the
   * schedule, quiet blocks). Travel may span them; starting inside is the
   * violation. */
  mealBlocks?: Window[];
};

export type Pace = "relaxed" | "balanced" | "packed";

export type SpikeProblem = {
  seed: number;
  days: SpikeDay[];
  stops: SpikeStop[];
  relations: SpikeRelation[];
  pace: Pace;
  /** Straight-line speed for the synthetic travel function, km/min. */
  speedKmPerMin: number;
};

export type SpikeVisit = {
  stopId: string;
  dayIndex: number;
  arriveMin: Minutes;
  startMin: Minutes;
  departMin: Minutes;
};

/** A contender's answer. Dropped stops are legal ONLY as an explicit list —
 * a stop absent from both visits and dropped is an evaluator error, so
 * nothing can be silently cut. */
export type SpikeSolution = {
  visits: SpikeVisit[]; // ordered within each day by startMin
  dropped: string[];
};

// ---------------------------------------------------------------------------

/** The one travel function of the spike. Straight-line distance / speed,
 * ceil'd to whole minutes (matches the repo's ceil-preserving convention). */
export function travelMin(a: SpikeStop, b: SpikeStop, speedKmPerMin: number): Minutes {
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  return Math.ceil(d / speedKmPerMin);
}

/** Pace presets → per-day budgets. Effort points: low 1 / medium 2 / high 3.
 * These are the spike's fixed knobs — production tunes them at E5. */
export const PACE_BUDGETS: Record<
  Pace,
  { maxActiveMin: Minutes; maxEffortPoints: number; minGapMin: Minutes }
> = {
  relaxed: { maxActiveMin: 480, maxEffortPoints: 8, minGapMin: 20 },
  balanced: { maxActiveMin: 600, maxEffortPoints: 12, minGapMin: 10 },
  packed: { maxActiveMin: 720, maxEffortPoints: 16, minGapMin: 0 },
};

export const EFFORT_POINTS: Record<Effort, number> = { low: 1, medium: 2, high: 3 };
