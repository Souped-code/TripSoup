#!/usr/bin/env python3
"""E1 spike, contender (b): OR-Tools CP-SAT itinerary solver.

Reads one SpikeProblem (see spike/ir.ts, FROZEN) as JSON on stdin, writes one
SpikeSolution-shaped result JSON on stdout:

    {"visits": [...], "dropped": [...], "solverStatus": "OPTIMAL|FEASIBLE|INFEASIBLE",
     "objective": <number>, "wallMs": <number>}

Mirrors spike/ir.ts semantics exactly: minutes-from-midnight, 0-based day
indexes, travelMin = ceil(hypot(dx,dy)/speedKmPerMin), pace budgets, and
effort points. See the module docstrings below and the README for the model
sketch and determinism caveat.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from typing import Any

from ortools.sat.python import cp_model

# ---------------------------------------------------------------------------
# Constants mirrored verbatim from spike/ir.ts (FROZEN IR — keep in sync by
# hand; there is no shared schema to import across the TS/Python boundary).

PACE_BUDGETS: dict[str, dict[str, int]] = {
    "relaxed": {"maxActiveMin": 480, "maxEffortPoints": 8, "minGapMin": 20},
    "balanced": {"maxActiveMin": 600, "maxEffortPoints": 12, "minGapMin": 10},
    "packed": {"maxActiveMin": 720, "maxEffortPoints": 16, "minGapMin": 0},
}

EFFORT_POINTS: dict[str, int] = {"low": 1, "medium": 2, "high": 3}

# Objective weights, matching the TS evaluator exactly:
#   1.0 * travel + 0.3 * wait + 0.5 * compression + drop penalties (200/60).
# CP-SAT objective coefficients must be integers, so every weight is scaled
# by SCALE and the reported objective is divided back down at the end.
SCALE = 10
TRAVEL_W = 1.0 * SCALE          # 10
WAIT_W = int(0.3 * SCALE)       # 3
COMPRESSION_W = int(0.5 * SCALE)  # 5
SHOULD_DROP_PENALTY = 200 * SCALE  # 2000
COULD_DROP_PENALTY = 60 * SCALE    # 600


def travel_min(a: dict, b: dict, speed_km_per_min: float) -> int:
    """Straight-line travel time, minutes, ceil'd — same as ir.ts travelMin."""
    d = math.hypot(a["x"] - b["x"], a["y"] - b["y"])
    return math.ceil(d / speed_km_per_min)


def solve(problem: dict, budget_ms: int, seed: int) -> dict:
    stops = problem["stops"]
    stops_by_id = {s["id"]: s for s in stops}
    days = problem["days"]
    relations = problem["relations"]
    pace = problem["pace"]
    speed = problem["speedKmPerMin"]

    budget = PACE_BUDGETS[pace]
    max_active_min = budget["maxActiveMin"]
    max_effort_points = budget["maxEffortPoints"]
    min_gap_min = budget["minGapMin"]

    n_days = len(days)

    if days:
        min_start = min(d["window"]["startMin"] for d in days)
        max_end = max(d["window"]["endMin"] for d in days)
    else:
        min_start, max_end = 0, 24 * 60

    model = cp_model.CpModel()

    # -- Per-stop decision variables -----------------------------------
    presented: dict[str, Any] = {}
    arrive: dict[str, Any] = {}
    start: dict[str, Any] = {}
    duration: dict[str, Any] = {}
    valid_days: dict[str, list[int]] = {}
    day_assign: dict[tuple[str, int], Any] = {}

    for sid, stop in stops_by_id.items():
        # Which days is this stop even allowed to land on?
        vdays: list[int] = []
        pinned = stop.get("pinnedDay")
        hours = stop.get("hours")
        for d_idx, day in enumerate(days):
            if pinned is not None and pinned["index"] != d_idx:
                continue
            if hours is not None:
                intervals = hours["byWeekday"][day["weekday"]]
                if not intervals:
                    continue  # closed that weekday
            vdays.append(d_idx)
        valid_days[sid] = vdays

        presented[sid] = model.NewBoolVar(f"presented_{sid}")
        if stop["priority"] == "must":
            model.Add(presented[sid] == 1)
        if not vdays:
            # Nowhere to put it. If it's "must" this makes the model
            # correctly INFEASIBLE; otherwise it is forced dropped.
            model.Add(presented[sid] == 0)

        dur = stop["duration"]
        arrive[sid] = model.NewIntVar(min_start, max_end, f"arrive_{sid}")
        start[sid] = model.NewIntVar(min_start, max_end, f"start_{sid}")
        duration[sid] = model.NewIntVar(dur["minMin"], dur["maxMin"], f"dur_{sid}")
        model.Add(start[sid] >= arrive[sid])

        window = stop.get("window")
        if window is not None:
            model.Add(start[sid] >= window["startMin"])
            model.Add(start[sid] <= window["endMin"])

        for d_idx in vdays:
            day_assign[(sid, d_idx)] = model.NewBoolVar(f"day_{sid}_{d_idx}")
        model.Add(
            sum(day_assign[(sid, d)] for d in vdays) == presented[sid]
        )

        for d_idx in vdays:
            day = days[d_idx]
            da = day_assign[(sid, d_idx)]
            model.Add(arrive[sid] >= day["window"]["startMin"]).OnlyEnforceIf(da)
            model.Add(start[sid] + duration[sid] <= day["window"]["endMin"]).OnlyEnforceIf(da)

            if hours is not None:
                intervals = hours["byWeekday"][day["weekday"]]
                interval_bools = []
                for k, intv in enumerate(intervals):
                    b = model.NewBoolVar(f"hrs_{sid}_{d_idx}_{k}")
                    # ir.ts semantics: the visit fits ENTIRELY inside one open
                    # interval — start after open AND depart before close.
                    # (Start-only was a bug: TS-evaluator cross-validation
                    # caught a depart 36min past closing, 2026-08-10.)
                    model.Add(start[sid] >= intv["startMin"]).OnlyEnforceIf([da, b])
                    model.Add(start[sid] + duration[sid] <= intv["endMin"]).OnlyEnforceIf([da, b])
                    interval_bools.append(b)
                model.Add(sum(interval_bools) == 1).OnlyEnforceIf(da)
                last_entry = hours.get("lastEntryMin")
                if last_entry is not None:
                    model.Add(start[sid] <= last_entry).OnlyEnforceIf(da)

            for b_idx, block in enumerate(day.get("mealBlocks") or []):
                before_ok = model.NewBoolVar(f"meal_before_{sid}_{d_idx}_{b_idx}")
                after_ok = model.NewBoolVar(f"meal_after_{sid}_{d_idx}_{b_idx}")
                # Evaluator forbids start in [blockStart, blockEnd) — the block
                # START is inside the block. `<= startMin` allowed exactly that
                # point, and a wait-minimizing solver lands on binding
                # boundaries constantly: this off-by-one alone produced every
                # "infeasible" CP-SAT artifact in the first race run (E1 gate
                # audit finding 1, proven by reproduction, 2026-08-10).
                model.Add(start[sid] <= block["startMin"] - 1).OnlyEnforceIf([da, before_ok])
                model.Add(start[sid] >= block["endMin"]).OnlyEnforceIf([da, after_ok])
                model.Add(before_ok + after_ok >= 1).OnlyEnforceIf(da)

    # -- Per-day sequencing via AddCircuit -------------------------------
    # Node 0 = a virtual depot (day start/end, no coordinates, zero travel
    # cost to/from it — first/last legs aren't charged). Nodes 1..k = stops
    # valid for this day, in AddCircuit's optional-node style: a stop's
    # self-loop literal is "not assigned to this day"; a real i->j arc means
    # j is visited immediately after i on this day's route.
    travel_terms: list[tuple[int, Any]] = []
    wait_gap_terms: list[Any] = []  # structural idle-gap vars, one per arc

    for d_idx, day in enumerate(days):
        day_stops = [sid for sid in stops_by_id if d_idx in valid_days[sid]]
        node_of = {sid: i + 1 for i, sid in enumerate(day_stops)}

        day_empty = model.NewBoolVar(f"day_empty_{d_idx}")
        total_present = sum(day_assign[(sid, d_idx)] for sid in day_stops) if day_stops else 0
        if day_stops:
            model.Add(total_present == 0).OnlyEnforceIf(day_empty)
            model.Add(total_present >= 1).OnlyEnforceIf(day_empty.Not())
        else:
            model.Add(day_empty == 1)

        arcs: list[tuple[int, int, Any]] = [(0, 0, day_empty)]
        depot_out: dict[str, Any] = {}
        depot_in: dict[str, Any] = {}

        for sid in day_stops:
            i = node_of[sid]
            arcs.append((i, i, day_assign[(sid, d_idx)].Not()))
            do = model.NewBoolVar(f"depot_out_{sid}_{d_idx}")
            di = model.NewBoolVar(f"depot_in_{sid}_{d_idx}")
            depot_out[sid] = do
            depot_in[sid] = di
            arcs.append((0, i, do))
            arcs.append((i, 0, di))

        arc_vars: dict[tuple[str, str], Any] = {}
        for sid_a in day_stops:
            for sid_b in day_stops:
                if sid_a == sid_b:
                    continue
                v = model.NewBoolVar(f"arc_{sid_a}_{sid_b}_{d_idx}")
                arcs.append((node_of[sid_a], node_of[sid_b], v))
                arc_vars[(sid_a, sid_b)] = v

        if day_stops:
            model.AddCircuit(arcs)

        for (sid_a, sid_b), v in arc_vars.items():
            t = travel_min(stops_by_id[sid_a], stops_by_id[sid_b], speed)
            model.Add(
                arrive[sid_b] >= start[sid_a] + duration[sid_a] + t + min_gap_min
            ).OnlyEnforceIf(v)
            travel_terms.append((t, v))
            # STRUCTURAL wait on this arc (evaluator change 2026-08-10): the
            # idle gap start_b - depart_a - travel, independent of reported
            # arrive. Equality reified on the active arc; when inactive the
            # minimizer drives the free var to its 0 lower bound, so no
            # spurious cost. Replaces the old start-arrive wait term, which a
            # solver could zero by backdating arrive.
            gap = model.NewIntVar(0, max_end - min_start, f"gap_{sid_a}_{sid_b}_{d_idx}")
            model.Add(gap == start[sid_b] - start[sid_a] - duration[sid_a] - t).OnlyEnforceIf(v)
            wait_gap_terms.append(gap)

        if day_stops:
            first_arrive_d = model.NewIntVar(min_start, max_end, f"first_arrive_{d_idx}")
            last_depart_d = model.NewIntVar(min_start, max_end, f"last_depart_{d_idx}")
            for sid in day_stops:
                model.Add(first_arrive_d == arrive[sid]).OnlyEnforceIf(depot_out[sid])
                model.Add(last_depart_d == start[sid] + duration[sid]).OnlyEnforceIf(depot_in[sid])
            model.Add(last_depart_d - first_arrive_d <= max_active_min).OnlyEnforceIf(day_empty.Not())

            effort_expr = sum(
                EFFORT_POINTS[stops_by_id[sid]["effort"]] * day_assign[(sid, d_idx)]
                for sid in day_stops
            )
            model.Add(effort_expr <= max_effort_points)

    # -- Relations --------------------------------------------------------
    def day_index_expr(sid: str):
        vdays = valid_days[sid]
        if not vdays:
            return 0
        return sum(d * day_assign[(sid, d)] for d in vdays)

    def both_present_bool(a_id: str, b_id: str):
        both = model.NewBoolVar(f"both_{a_id}_{b_id}")
        model.AddBoolAnd([presented[a_id], presented[b_id]]).OnlyEnforceIf(both)
        model.AddBoolOr([presented[a_id].Not(), presented[b_id].Not()]).OnlyEnforceIf(both.Not())
        return both

    for r_idx, rel in enumerate(relations):
        kind = rel["kind"]
        if kind == "precedence":
            b_id, a_id = rel["beforeId"], rel["afterId"]
            both = both_present_bool(b_id, a_id)
            db, da = day_index_expr(b_id), day_index_expr(a_id)
            model.Add(da >= db).OnlyEnforceIf(both)
            same_day = model.NewBoolVar(f"prec_sameday_{r_idx}")
            model.Add(da - db <= 0).OnlyEnforceIf([both, same_day])
            model.Add(da - db >= 1).OnlyEnforceIf([both, same_day.Not()])
            model.Add(start[a_id] >= start[b_id] + 1).OnlyEnforceIf([both, same_day])
        elif kind == "sameDay":
            a_id, b_id = rel["aId"], rel["bId"]
            both = both_present_bool(a_id, b_id)
            model.Add(day_index_expr(a_id) == day_index_expr(b_id)).OnlyEnforceIf(both)
        elif kind == "notSameDay":
            a_id, b_id = rel["aId"], rel["bId"]
            both = both_present_bool(a_id, b_id)
            da, db = day_index_expr(a_id), day_index_expr(b_id)
            lt = model.NewBoolVar(f"nsd_lt_{r_idx}")
            gt = model.NewBoolVar(f"nsd_gt_{r_idx}")
            model.Add(lt + gt == 1).OnlyEnforceIf(both)
            model.Add(da - db <= -1).OnlyEnforceIf([both, lt])
            model.Add(da - db >= 1).OnlyEnforceIf([both, gt])
        else:
            raise ValueError(f"unknown relation kind: {kind}")

    # -- Objective ----------------------------------------------------------
    objective_terms = []
    for t, v in travel_terms:
        objective_terms.append(int(TRAVEL_W) * t * v)
    for gap in wait_gap_terms:
        objective_terms.append(WAIT_W * gap)
    for sid, stop in stops_by_id.items():
        dur = stop["duration"]
        shortfall = model.NewIntVar(0, dur["typicalMin"] - dur["minMin"], f"shortfall_{sid}")
        model.Add(shortfall >= dur["typicalMin"] - duration[sid])
        objective_terms.append(COMPRESSION_W * shortfall)
    for sid, stop in stops_by_id.items():
        if stop["priority"] == "should":
            objective_terms.append(SHOULD_DROP_PENALTY * (1 - presented[sid]))
        elif stop["priority"] == "could":
            objective_terms.append(COULD_DROP_PENALTY * (1 - presented[sid]))

    model.Minimize(sum(objective_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = budget_ms / 1000.0
    solver.parameters.num_search_workers = 4
    solver.parameters.random_seed = seed

    t0 = time.perf_counter()
    status = solver.Solve(model)
    wall_ms = (time.perf_counter() - t0) * 1000.0

    visits = []
    dropped = []
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        for sid in stops_by_id:
            if solver.Value(presented[sid]) == 1:
                d_idx = next(d for d in valid_days[sid] if solver.Value(day_assign[(sid, d)]) == 1)
                a = solver.Value(arrive[sid])
                s = solver.Value(start[sid])
                dur_v = solver.Value(duration[sid])
                visits.append(
                    {
                        "stopId": sid,
                        "dayIndex": d_idx,
                        "arriveMin": a,
                        "startMin": s,
                        "departMin": s + dur_v,
                    }
                )
            else:
                dropped.append(sid)
        visits.sort(key=lambda v: (v["dayIndex"], v["startMin"]))
        objective = solver.ObjectiveValue() / SCALE
        status_str = "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE"
    else:
        dropped = list(stops_by_id.keys())
        objective = 0.0
        status_str = "INFEASIBLE"

    return {
        "visits": visits,
        "dropped": dropped,
        "solverStatus": status_str,
        "objective": objective,
        "wallMs": round(wall_ms, 1),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="E1 spike CP-SAT itinerary solver")
    parser.add_argument("--budget-ms", type=int, default=10000)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()

    problem = json.load(sys.stdin)
    result = solve(problem, args.budget_ms, args.seed)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
