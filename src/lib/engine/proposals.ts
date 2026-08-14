// E5a — conflicts -> priced trade-off proposals. Decision 6: "Infeasibility =
// trade-off proposals. Never silently cut; user chooses."
//
// HOW A PROPOSAL IS PRICED (and why it is honest)
// -----------------------------------------------
// Every candidate patch is TEST-APPLIED to the problem and re-scheduled ONCE
// through the same hybrid path that produced the plan (./solve), with the search
// reduced to construction + polish — no annealing, no search. The delta is then
// a difference of two numbers produced by the SAME scheduler: the base is
// re-scored the same cheap way, never against the full-search plan, because
// comparing a construction-only answer with an annealed one would make every
// proposal look worse than it is.
//
// A candidate survives only if it actually makes the conflict go away — a
// proposal that does not resolve anything is noise, and E6 would render it as a
// promise the engine cannot keep.
//
// BOUNDED BY CONSTRUCTION: unique candidate patches are deduplicated (two
// conflicts fixed by one patch become one proposal that resolves both), the
// number of conflicts that generate candidates is capped, alternative days for a
// `moveDay` are capped to the nearest few, and the total number of test-applies
// is capped. A 40-stop trip in trouble must not turn proposal generation into a
// second solve.

import { formatDuration } from "../util/duration";
import { evaluate } from "./evaluate";
import { deriveConflicts } from "./conflicts";
import { applyPatchToProblem } from "./patch";
import { scheduleProblem } from "./solve";
import type {
  Conflict,
  DocPatch,
  EngineNode,
  EngineProblem,
  Proposal,
  ProposalKind,
  SolveOptions,
} from "./types";

/** Conflicts (in the order ./conflicts sorted them) that get proposals. */
const MAX_CONFLICTS_CONSIDERED = 12;
/** Distinct candidate patches actually test-applied. */
const MAX_CANDIDATE_EVALS = 80;
/** Alternative days tried per stop for a `moveDay`, nearest first. */
const MOVE_DAY_LIMIT = 3;
/** Other stops on the conflicted day offered up for shortening. */
const MAX_TRIM_CANDIDATES = 3;

type Candidate = {
  kind: ProposalKind;
  patch: DocPatch;
  message: string;
  targets: Set<string>;
};

export function deriveProposals(
  problem: EngineProblem,
  conflicts: readonly Conflict[],
  opts: SolveOptions
): Proposal[] {
  if (conflicts.length === 0) return [];
  const byKey = new Map(problem.nodes.map((n) => [n.key, n]));

  // ---- candidate generation -------------------------------------------
  const candidates = new Map<string, Candidate>();
  const add = (c: Omit<Candidate, "targets">, conflictIds: readonly string[]): void => {
    const sig = signature(c.patch);
    const existing = candidates.get(sig);
    if (existing) {
      for (const id of conflictIds) existing.targets.add(id);
      return;
    }
    candidates.set(sig, { ...c, targets: new Set(conflictIds) });
  };

  for (const conflict of conflicts.slice(0, MAX_CONFLICTS_CONSIDERED)) {
    for (const key of conflict.stopIds) {
      const node = byKey.get(key);
      if (!node) continue;
      const dayIndex = conflict.dayIndex ?? node.pinnedDay?.value;
      if (dayIndex === undefined || dayIndex < 0) continue;

      add(
        {
          kind: "dropStop",
          patch: { op: "removeStop", dayIndex, stopId: node.stopId },
          message: `Leave out ${node.name}.`,
        },
        [conflict.id]
      );

      // trimDuration — only when there is room to trim.
      const dur = node.duration.value;
      if (dur.minMin < dur.typicalMin) {
        add(
          {
            kind: "trimDuration",
            patch: {
              op: "setDuration",
              dayIndex,
              stopId: node.stopId,
              durationMin: dur.minMin,
            },
            message: `Shorten ${node.name} to ${formatDuration(dur.minMin)}.`,
          },
          [conflict.id]
        );
      }

      // shiftWindow — the SMALLEST move of the booked time that admits it.
      const shifted = shiftedAnchorMin(node, dayIndex, conflict);
      if (shifted !== null) {
        add(
          {
            kind: "shiftWindow",
            patch: { op: "setAnchor", dayIndex, stopId: node.stopId, startMin: shifted },
            message: `Move ${node.name}'s booked time to ${hhmm(shifted)}.`,
          },
          [conflict.id]
        );
      }

      // moveDay — nearest other days first. Launch mode EMITS this and never
      // applies it: the pins are the paste's decision, and E6 gates acceptance.
      for (const other of nearestDays(problem.days.length, dayIndex, MOVE_DAY_LIMIT)) {
        add(
          {
            kind: "moveDay",
            patch: {
              op: "moveStop",
              fromDayIndex: dayIndex,
              toDayIndex: other,
              stopId: node.stopId,
            },
            message: `Move ${node.name} to day ${other + 1}.`,
          },
          [conflict.id]
        );
      }
    }

    // Day-level fixes.
    if (conflict.dayIndex !== undefined) {
      const day = problem.days[conflict.dayIndex];
      if (day) {
        // The stop that is late is rarely the stop that made it late. Offer to
        // shorten the trimmable visits EARLIER in the day too — "shorten the
        // museum so you make your booking" is the fix a human would reach for.
        // Bounded: the three with the most to give back, and the resolution
        // check throws away any that do not actually help.
        const trimmable = day.nodeKeys
          .map((k) => byKey.get(k))
          .filter((n): n is EngineNode => !!n && n.duration.value.minMin < n.duration.value.typicalMin)
          .sort(
            (a, b) =>
              b.duration.value.typicalMin -
                b.duration.value.minMin -
                (a.duration.value.typicalMin - a.duration.value.minMin) ||
              (a.key < b.key ? -1 : 1)
          )
          .slice(0, MAX_TRIM_CANDIDATES);
        for (const node of trimmable) {
          add(
            {
              kind: "trimDuration",
              patch: {
                op: "setDuration",
                dayIndex: conflict.dayIndex,
                stopId: node.stopId,
                durationMin: node.duration.value.minMin,
              },
              message: `Shorten ${node.name} to ${formatDuration(node.duration.value.minMin)}.`,
            },
            [conflict.id]
          );
        }
        if (conflict.code === "day-window" && conflict.violatedByMin > 0) {
          add(
            {
              kind: "shiftWindow",
              patch: {
                op: "setDayWindow",
                dayIndex: conflict.dayIndex,
                endMin: day.window.value.endMin + Math.ceil(conflict.violatedByMin),
              },
              message: `Run day ${conflict.dayIndex + 1} ${formatDuration(conflict.violatedByMin)} later.`,
            },
            [conflict.id]
          );
        }
        if (conflict.code === "pace-active" || conflict.code === "pace-effort") {
          if (problem.pacePreset.value !== "packed") {
            add(
              {
                kind: "relaxPace",
                patch: { op: "setPacePreset", preset: "packed" },
                message: "Accept a packed pace for this trip.",
              },
              [conflict.id]
            );
          }
        }
      }
    }
  }

  // ---- pricing ---------------------------------------------------------
  // Base is re-scored with the SAME cheap scheduler the candidates get.
  const quick: SolveOptions = { seed: opts.seed, timeBudgetMs: 0, iterCap: 1 };
  const base = quickScore(problem, quick);
  const baseScore = base.score;
  const baseConflictIds = new Set(base.conflicts.map((c) => c.id));

  const out: Proposal[] = [];
  let evals = 0;
  for (const [sig, cand] of [...candidates.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  )) {
    if (evals >= MAX_CANDIDATE_EVALS) break;
    evals++;
    const patched = applyPatchToProblem(problem, cand.patch);
    if (patched === problem) continue; // stale/no-op patch
    const scored = quickScore(patched, quick);
    const stillThere = new Set(scored.conflicts.map((c) => c.id));
    const resolves = [...cand.targets].filter((id) => !stillThere.has(id)).sort();
    if (resolves.length === 0) continue;
    // A fix that swaps one conflict for another is not a fix. E6 renders these
    // as "accept" buttons; a button that trades the user's museum problem for a
    // restaurant problem is worse than no button.
    if (scored.conflicts.some((c) => !baseConflictIds.has(c.id))) continue;
    out.push({
      id: `${cand.kind}:${sig}`,
      kind: cand.kind,
      patch: cand.patch,
      resolves,
      costDeltaMin: round2(scored.score - baseScore),
      message: cand.message,
    });
  }

  out.sort((a, b) => a.costDeltaMin - b.costDeltaMin || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function quickScore(
  problem: EngineProblem,
  opts: SolveOptions
): { score: number; conflicts: Conflict[] } {
  const { schedule } = scheduleProblem(problem, opts);
  const evaluation = evaluate(problem, schedule);
  return {
    score: evaluation.score,
    conflicts: deriveConflicts(problem, evaluation, schedule),
  };
}

/**
 * The smallest move of a booked time that admits the stop, or null when there
 * is no booked time to move (or nothing to move it to).
 *  - a missed booked time: push it LATER by exactly the miss;
 *  - opening hours: clamp it into the nearest interval that can hold the visit,
 *    respecting lastEntry.
 */
function shiftedAnchorMin(node: EngineNode, dayIndex: number, conflict: Conflict): number | null {
  if (!node.isAnchor || !node.window) return null;
  const at = node.window.value.startMin;

  if (conflict.code === "anchor-start" && conflict.violatedByMin > 0) {
    return Math.ceil(at + conflict.violatedByMin);
  }

  if (conflict.code === "hours" && node.hours) {
    const open = node.hours.value.openByDay[dayIndex];
    if (!open || open.length === 0) return null;
    const length = node.duration.value.typicalMin;
    const lastEntry = node.hours.value.lastEntryMin ?? Infinity;
    let best: number | null = null;
    for (const iv of open) {
      const latest = Math.min(iv.endMin - length, lastEntry);
      if (latest < iv.startMin) continue;
      const candidate = at < iv.startMin ? iv.startMin : at > latest ? latest : at;
      if (best === null || Math.abs(candidate - at) < Math.abs(best - at)) best = candidate;
    }
    return best;
  }

  return null;
}

function nearestDays(total: number, from: number, limit: number): number[] {
  const others: number[] = [];
  for (let d = 0; d < total; d++) if (d !== from) others.push(d);
  others.sort((a, b) => Math.abs(a - from) - Math.abs(b - from) || a - b);
  return others.slice(0, limit);
}

function signature(patch: DocPatch): string {
  switch (patch.op) {
    case "removeStop":
      return `removeStop|${patch.dayIndex}|${patch.stopId}`;
    case "setAnchor":
      return `setAnchor|${patch.dayIndex}|${patch.stopId}|${patch.startMin}`;
    case "setDayWindow":
      return `setDayWindow|${patch.dayIndex}|${patch.startMin ?? "-"}|${patch.endMin ?? "-"}`;
    case "moveStop":
      return `moveStop|${patch.fromDayIndex}|${patch.toDayIndex}|${patch.stopId}`;
    case "setDuration":
      return `setDuration|${patch.dayIndex}|${patch.stopId}|${patch.durationMin}`;
    case "setPacePreset":
      return `setPacePreset|${patch.preset}`;
  }
}

function hhmm(min: number): string {
  const wrapped = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
