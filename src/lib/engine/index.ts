// E5a — the engine's public surface. E5b (planService/pipeline/SSE) imports from
// here and nothing deeper.

export * from "./types";
export { buildProblem, isoWeekdayOfDay, PACE_BUDGETS, EFFORT_POINTS } from "./problem";
export type { BuildProblemOptions } from "./problem";
export { alnsEngine, solveWithAlns, ENGINE_NAME, ENGINE_VERSION } from "./alnsEngine";
export { evaluate, WEIGHT_TRAVEL, WEIGHT_WAIT, WEIGHT_COMPRESSION } from "./evaluate";
export type { EngineEvaluation, EngineViolation } from "./evaluate";
export { applyDocPatch, applyConstraintPatch, applyPatch, keyOnDay } from "./patch";
export { isOldClassDay, isLaunchMode } from "./exhaustive";
export { scheduleProblem } from "./solve";
export { deriveConflicts } from "./conflicts";
export { deriveProposals } from "./proposals";
