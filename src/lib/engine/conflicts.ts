// E5a — evaluation violations -> Conflicts. "Infeasibility = trade-off
// proposals", decision 6: the engine never returns a dead end, so every
// relaxation it took in order to hand back a plan is enumerated here, each one
// naming the constraint it broke and whose constraint that was.
//
// TWO sources, and only two:
//  1. every HARD violation the objective found in the returned schedule;
//  2. every stop the engine chose to leave out. A hard-`must` drop is already
//     source 1 (`dropped-must`); a `should`/`could` drop is a priced trade the
//     user never explicitly authorised, so it surfaces as a conflict too.
//
// Soft violations are NOT conflicts. They are priced in the objective
// (`objectiveBreakdown.softViolations`) and that is the whole meaning of soft:
// the engine was allowed to make that trade.

import type { EngineEvaluation } from "./evaluate";
import type { Conflict, EngineProblem, EngineSchedule } from "./types";

export function deriveConflicts(
  problem: EngineProblem,
  evaluation: EngineEvaluation,
  schedule: EngineSchedule
): Conflict[] {
  const byKey = new Map(problem.nodes.map((n) => [n.key, n]));
  const out: Conflict[] = [];

  for (const v of evaluation.violations) {
    if (!v.hard) continue;
    out.push({
      id: conflictId(v.code, v.ref.path, v.stopKeys, v.dayIndex),
      code: v.code,
      stopIds: [...v.stopKeys],
      ...(v.dayIndex === undefined ? {} : { dayIndex: v.dayIndex }),
      violatedByMin: v.byMin,
      constraintRef: v.ref,
      message: v.detail,
    });
  }

  for (const key of schedule.dropped) {
    const node = byKey.get(key);
    if (!node) continue;
    if (node.priority.value === "must" && node.priority.hard) continue; // already `dropped-must`
    const dayIndex = node.pinnedDay?.value;
    out.push({
      id: conflictId("dropped-stop", node.priority.ref.path, [key], dayIndex),
      code: "dropped-stop",
      stopIds: [key],
      ...(dayIndex === undefined ? {} : { dayIndex }),
      violatedByMin: 0,
      constraintRef: node.priority.ref,
      message: `"${node.name}" did not fit — it was left out of the plan.`,
    });
  }

  // Deterministic order: the same solve must produce the same bytes.
  out.sort((a, b) =>
    a.code < b.code
      ? -1
      : a.code > b.code
        ? 1
        : (a.dayIndex ?? -1) - (b.dayIndex ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return out;
}

/** Stable, content-derived id: same breach of the same constraint = same id
 * across solves, which is what lets E6 key a dismissal to it. */
export function conflictId(
  code: string,
  path: string,
  stopKeys: readonly string[],
  dayIndex: number | undefined
): string {
  return `${code}|${dayIndex ?? "-"}|${path}|${[...stopKeys].sort().join("+")}`;
}

/** Margin notes for one day, derived from its conflicts. The advisory channel
 * (§ marginNotes) finally carries something; E6 renders the structured cards. */
export function marginNotesForDay(conflicts: readonly Conflict[], dayIndex: number): string[] {
  return conflicts
    .filter((c) => c.dayIndex === dayIndex)
    .map((c) => c.message);
}
