/** Durable explanation data. Consumers validate/format it; they do not rerun selection. */
export interface SelectionTrace {
  policyVersion: 1;
  eligibilityPolicy: "passed-trajectory-occurrences";
  states: {
    files: string[];
    candidates: { stepId: string; multiplicity: number }[];
    probability: number;
  }[];
  selectedStateIndex: number;
  /** Only the selected state's conditional distribution was evaluated. */
  candidates: {
    stepId: string;
    reasoningScore: number;
    probability: number;
  }[];
  selectedStepId: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")
    && new Set(value).size === value.length;
}
function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function distribution(values: number[]): boolean {
  return values.length > 0 && Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 1e-9;
}

/** Unknown versions or inconsistent records are unavailable, never reconstructed. */
export function parseSelectionTrace(value: unknown): SelectionTrace | undefined {
  const trace = record(value);

  if (trace?.policyVersion !== 1 || trace.eligibilityPolicy !== "passed-trajectory-occurrences" ||
      !Array.isArray(trace.states) || !Array.isArray(trace.candidates) ||
      typeof trace.selectedStateIndex !== "number" || !Number.isSafeInteger(trace.selectedStateIndex) ||
      trace.selectedStateIndex < 0 || trace.selectedStateIndex >= trace.states.length ||
      typeof trace.selectedStepId !== "string") return;

  const states: SelectionTrace["states"] = [];
  const seenSteps = new Set<string>();
  for (const raw of trace.states) {
    const state = record(raw);

    if (!stringList(state?.files) || !Array.isArray(state?.candidates) ||
        state.candidates.length === 0 || !probability(state?.probability)) return;

    const candidates: SelectionTrace["states"][number]["candidates"] = [];
    for (const rawCandidate of state.candidates) {
      const candidate = record(rawCandidate);
      if (typeof candidate?.stepId !== "string" ||
          typeof candidate.multiplicity !== "number" || !Number.isSafeInteger(candidate.multiplicity) ||
          candidate.multiplicity <= 0 || seenSteps.has(candidate.stepId)) return;

      seenSteps.add(candidate.stepId);
      candidates.push({ stepId: candidate.stepId, multiplicity: candidate.multiplicity });
    }

    states.push({ files: [...state.files], candidates, probability: state.probability });
  }

  if (!distribution(states.map((state) => state.probability))) return;

  const selectedState = states[trace.selectedStateIndex];
  if (selectedState.probability === 0 || trace.candidates.length !== selectedState.candidates.length) return;

  const candidates: SelectionTrace["candidates"] = [];
  for (let index = 0; index < trace.candidates.length; index++) {
    const candidate = record(trace.candidates[index]);

    if (candidate?.stepId !== selectedState.candidates[index].stepId ||
        typeof candidate?.reasoningScore !== "number" || !Number.isSafeInteger(candidate.reasoningScore) ||
        candidate.reasoningScore < 0 || !probability(candidate.probability)) return;

    candidates.push({ stepId: candidate.stepId, reasoningScore: candidate.reasoningScore, probability: candidate.probability });
  }

  if (!distribution(candidates.map((candidate) => candidate.probability)) ||
      !candidates.some((candidate) => candidate.stepId === trace.selectedStepId && candidate.probability > 0)) return;

  return {
    policyVersion: 1, eligibilityPolicy: "passed-trajectory-occurrences", states,
    selectedStateIndex: trace.selectedStateIndex, candidates, selectedStepId: trace.selectedStepId,
  };
}
