# E1 spike — CP-SAT contender (b)

Run: `pip install -r requirements.txt`, then
`python solve.py --budget-ms 10000 --seed 1 < problem.json > solution.json`.
Reads one SpikeProblem JSON on stdin, writes one SpikeSolution-shaped JSON
(`visits`/`dropped`/`solverStatus`/`objective`/`wallMs`) on stdout.

Model: one presence bool + one (arrive,start,duration) IntVar triple per
stop; per-day `AddCircuit` over a zero-cost depot node + that day's valid
stops, self-loop literal = "not assigned to this day", real arcs carry
travel-time-linked timing constraints and feed the objective's travel term
directly (chosen over big-M ordering booleans so only *consecutive* arcs
are charged, no manual big-M needed). Optional per-day min/max (pace
span, first/last stop) handled by linking `first_arrive_d`/`last_depart_d`
to the depot-adjacent arc literals rather than `AddMinEquality`/
`AddMaxEquality` over optional vars. Windows/hours/meal-blocks/relations
reified with `OnlyEnforceIf` on presence and day-assignment bools.
Objective integer-scaled by 10x (weights 1.0/0.3/0.5/200/60 → 10/3/5/
2000/600), reported value divided back down.

Determinism caveat: `num_search_workers=4` + `random_seed` set, but
multi-worker CP-SAT search is not strictly deterministic — different runs
of the same seed can still land on different (equally optimal, or
different feasible) solutions, especially before the time limit proves
optimality. Acceptable for this spike; single-worker would be
deterministic but slower.
