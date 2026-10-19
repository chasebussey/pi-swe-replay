import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExplorationState } from "./exploration-state";
import { reasoningScore } from "./reasoning-score";

export interface ExploitationSelection {
  state: ExplorationState;
  stepId: string;
  reasoningScore: number;
}

function sampleSoftmax(logits: readonly number[], random: () => number): number {
  const max = logits.reduce((a, b) => Math.max(a, b), -Infinity);
  const weights = logits.map((logit) => Math.exp(logit - max));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const draw = random();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) {
    throw new Error("Selection RNG must return a finite number in [0, 1).");
  }

  let threshold = draw * total;
  let lastPositive = 0;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] > 0) lastPositive = i;
    if (threshold < weights[i]) return i;
    threshold -= weights[i];
  }
  return lastPositive; // Guard against floating-point rounding at the upper boundary.
}

/** Sample a state by inverse group size, then a step by reasoning paragraphs. */
export function selectExploitationStep(
  states: readonly ExplorationState[],
  sessionManager: Pick<ExtensionContext["sessionManager"], "getEntry">,
  random: () => number = Math.random,
): ExploitationSelection | undefined {
  const eligible = states.filter((state) => state.files.length > 0 && state.candidateStepIds.length > 0);
  if (eligible.length === 0) return;

  // All recorded completed steps are provisionally eligible until regression evaluation exists.
  const state = eligible[sampleSoftmax(eligible.map((state) => 1 / state.candidateStepIds.length), random)];
  const scores = state.candidateStepIds.map((stepId) => reasoningScore(stepId, sessionManager));
  const index = sampleSoftmax(scores, random);
  return { state, stepId: state.candidateStepIds[index], reasoningScore: scores[index] };
}
