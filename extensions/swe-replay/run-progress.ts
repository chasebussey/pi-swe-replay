import type { RegressionEvaluation } from "./evaluation";

export type ReplayPhase = "preparing" | "baseline" | "choosing" | "navigating" | "restoring"
  | "generating" | "capturing" | "evaluating" | "normalizing" | "voting" | "restoring-winner";

/** Ephemeral execution observations, never persisted or used to decide eligibility. */
export type ReplayProgress =
  | { type: "root"; rootEntryId: string }
  | { type: "phase"; phase: ReplayPhase }
  | { type: "iteration"; iteration: number; approach: "explore" | "exploit" | "fallback"; targetStepId?: string; sourceIteration?: number }
  | { type: "candidate"; iteration: number }
  | { type: "evaluation"; iteration: number; status: RegressionEvaluation["status"] };

export interface ReplayExecution {
  /** Invalidate stale background work on session shutdown/reload. Not a user Stop API. */
  signal?: AbortSignal;
  assertActive(): void;
  report(event: ReplayProgress): void;
}

export const unobservedExecution: ReplayExecution = { assertActive() {}, report() {} };

/** A direct caller's context signal still guards persistence/navigation without a controller. */
export function guardedReplayExecution(execution: ReplayExecution = unobservedExecution, fallbackSignal?: AbortSignal): ReplayExecution {
  const signal = execution.signal ?? fallbackSignal;
  return {
    signal,
    assertActive() { execution.assertActive(); signal?.throwIfAborted(); },
    report(event) { execution.report(event); },
  };
}
