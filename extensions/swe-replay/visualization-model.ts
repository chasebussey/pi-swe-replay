import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { reasoningScore } from "./reasoning-score";
import { parseSelectionTrace } from "./selection-trace";

export interface ReplayStepView {
  id: string;
  parentStepId?: string;
  iterations: number[];
  filesBefore?: string[];
  reasoningScore?: number;
  active: boolean;
  selectedIn: number[];
}

export interface DecisionStateView {
  files: string[];
  selected: boolean;
  probability?: number;
  candidates: { id: string; score?: number; probability?: number }[];
}

export interface ReplayDecisionView {
  id: string;
  iteration?: number;
  outcome: "selected-only" | "explore-fallback" | "unknown";
  selectedStepId?: string;
  recordedScore?: number;
  fallbackReason?: string;
  probabilitySource: "recorded" | "unavailable";
  traceNote: string;
  policyVersion?: number;
  states: DecisionStateView[];
}

export interface ReplayView {
  rootEntryId: string;
  timestamp?: string;
  prompt?: string;
  requestedCount?: number;
  active: boolean;
  steps: ReplayStepView[];
  decisions: ReplayDecisionView[];
  diagnostics: string[];
}

type RecordData = Record<string, unknown>;
function record(value: unknown): RecordData | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordData : undefined;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function files(value: string[]): string[] {
  return [...new Set(value)].sort();
}

export function replayRoots(entries: readonly SessionEntry[]): SessionEntry[] {
  return entries.filter((entry) => entry.type === "custom" && entry.customType === "swe-replay-root");
}

/** Read-only projection. Malformed legacy records become diagnostics, not UI errors. */
export function buildReplayView(
  entries: readonly SessionEntry[],
  rootEntryId: string,
  activeEntryIds: readonly string[] = [],
): ReplayView {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const active = new Set(activeEntryIds);
  const root = byId.get(rootEntryId);
  const metadata = root?.type === "custom" ? record(root.data) : undefined;
  const view: ReplayView = {
    rootEntryId,
    timestamp: root?.timestamp,
    prompt: typeof metadata?.prompt === "string" ? metadata.prompt : undefined,
    requestedCount: positiveInteger(metadata?.requestedPatchCount),
    active: active.has(rootEntryId),
    steps: [], decisions: [], diagnostics: [],
  };
  if (!root || root.type !== "custom" || root.customType !== "swe-replay-root") {
    view.diagnostics.push("Replay root is missing or invalid.");
    return view;
  }

  const owners = new Map<string, string | undefined>();
  function owner(id: string): string | undefined {
    const path = new Set<string>();
    let current: string | null = id;
    let result: string | undefined;
    while (current && !path.has(current)) {
      if (owners.has(current)) { result = owners.get(current); break; }
      path.add(current);
      const entry = byId.get(current);
      if (!entry) break;
      if (entry.type === "custom" && entry.customType === "swe-replay-root") { result = entry.id; break; }
      current = entry.parentId;
    }
    for (const item of path) owners.set(item, result);
    return result;
  }
  const ancestorCache = new Map<string, SessionEntry[]>();
  function ancestors(id: string): SessionEntry[] {
    const cached = ancestorCache.get(id);
    if (cached) return cached;
    const result: SessionEntry[] = [];
    const seen = new Set<string>([id]);
    let current = byId.get(id)?.parentId;
    while (current && current !== rootEntryId && !seen.has(current)) {
      seen.add(current);
      const entry = byId.get(current);
      if (!entry || owner(current) !== rootEntryId) break;
      result.push(entry);
      current = entry.parentId;
    }
    ancestorCache.set(id, result);
    return result;
  }
  const scores = new Map<string, number | undefined>();
  function score(id: string): number | undefined {
    if (scores.has(id)) return scores.get(id);
    let value: number | undefined;
    try {
      if (owner(id) !== rootEntryId) throw new Error("outside run");
      value = reasoningScore(id, { getEntry: (key) => byId.get(key) });
    } catch {
      view.diagnostics.push(`Reasoning unavailable for step ${id}.`);
    }
    scores.set(id, value);
    return value;
  }

  const snapshots = new Map<string, { stepId: string; iteration?: number; files: string[] }>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "swe-replay-turn-files") continue;
    const data = record(entry.data);
    if (owner(entry.id) !== rootEntryId) continue;
    if (data?.rootEntryId !== rootEntryId || typeof data.messageEntryId !== "string" || !strings(data.files)) {
      view.diagnostics.push(`Malformed turn snapshot ${entry.id}.`);
      continue;
    }
    const step = byId.get(data.messageEntryId);
    if (!step || step.type !== "message" || step.message.role !== "assistant" ||
        !ancestors(entry.id).some((ancestor) => ancestor.id === step.id)) {
      view.diagnostics.push(`Invalid step reference in snapshot ${entry.id}.`);
      continue;
    }
    snapshots.set(entry.id, { stepId: step.id, iteration: positiveInteger(data.iteration), files: files(data.files) });
  }

  const steps = new Map<string, ReplayStepView>();
  for (const snapshot of snapshots.values()) {
    let step = steps.get(snapshot.stepId);
    if (!step) {
      step = { id: snapshot.stepId, iterations: [], active: active.has(snapshot.stepId), selectedIn: [] };
      steps.set(step.id, step);
    }
    if (snapshot.iteration && !step.iterations.includes(snapshot.iteration)) step.iterations.push(snapshot.iteration);
  }
  for (const step of steps.values()) {
    const path = ancestors(step.id);
    step.parentStepId = path.find((entry) => steps.has(entry.id))?.id;
    const previous = path.map((entry) => snapshots.get(entry.id)).find((snapshot) => snapshot !== undefined);
    // A malformed intervening snapshot means the pre-step file state is unknown.
    const nearestSnapshot = path.find((entry) => entry.type === "custom" && entry.customType === "swe-replay-turn-files");
    step.filesBefore = nearestSnapshot && !snapshots.has(nearestSnapshot.id) ? undefined : previous?.files ?? [];
    step.reasoningScore = score(step.id);
    step.iterations.sort((a, b) => a - b);
  }
  view.steps = [...steps.values()];

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "swe-replay-exploit-log" || owner(entry.id) !== rootEntryId) continue;
    const data = record(entry.data);
    if (data?.rootEntryId !== undefined && data.rootEntryId !== rootEntryId) {
      view.diagnostics.push(`Mismatched replay root in decision ${entry.id}.`);
      continue;
    }
    const selection = record(data?.selection);
    const decision: ReplayDecisionView = {
      id: entry.id, iteration: positiveInteger(data?.iteration), outcome: "unknown", states: [],
      probabilitySource: "unavailable", traceNote: "Probabilities unavailable—no selection trace recorded.",
      selectedStepId: typeof selection?.stepId === "string" ? selection.stepId : undefined,
      recordedScore: typeof selection?.reasoningScore === "number" && Number.isFinite(selection.reasoningScore)
        ? selection.reasoningScore : undefined,
      fallbackReason: typeof data?.fallbackReason === "string" ? data.fallbackReason : undefined,
    };
    let trace = parseSelectionTrace(data?.trace);
    const tracedSelection = trace?.candidates.find((candidate) => candidate.stepId === trace?.selectedStepId);
    if (trace && (
      (decision.selectedStepId !== undefined && decision.selectedStepId !== trace.selectedStepId) ||
      (decision.recordedScore !== undefined && decision.recordedScore !== tracedSelection?.reasoningScore) ||
      decision.fallbackReason !== undefined
    )) trace = undefined;
    if (trace && tracedSelection) {
      decision.probabilitySource = "recorded";
      decision.policyVersion = trace.policyVersion;
      decision.traceNote = `Source: recorded at selection time · policy v${trace.policyVersion}.`;
      decision.selectedStepId = trace.selectedStepId;
      decision.recordedScore = tracedSelection.reasoningScore;
      const candidates = new Map(trace.candidates.map((candidate) => [candidate.stepId, candidate]));
      const selectedStateIndex = trace.selectedStateIndex;
      decision.states = trace.states.map((state, index) => ({
        files: [...state.files], selected: index === selectedStateIndex, probability: state.probability,
        candidates: state.candidateStepIds.map((id) => ({
          id, score: candidates.get(id)?.reasoningScore, probability: candidates.get(id)?.probability,
        })),
      }));
    } else {
      if (data?.trace != null) {
        decision.traceNote = "Probabilities unavailable—invalid or unsupported selection trace.";
        view.diagnostics.push(`Invalid, inconsistent, or unsupported selection trace in decision ${entry.id}.`);
      }
      let validStates = Array.isArray(data?.states);
      for (const raw of Array.isArray(data?.states) ? data.states : []) {
        const state = record(raw);
        if (!strings(state?.files) || !strings(state?.candidateStepIds)) { validStates = false; continue; }
        if (state.files.length === 0 || state.candidateStepIds.length === 0) continue;
        if (new Set(state.candidateStepIds).size !== state.candidateStepIds.length) validStates = false;
        decision.states.push({
          files: files(state.files), selected: state.candidateStepIds.includes(decision.selectedStepId ?? ""),
          candidates: state.candidateStepIds.map((id) => ({
            id, score: id === decision.selectedStepId ? decision.recordedScore : undefined,
          })),
        });
      }
      if (!validStates) view.diagnostics.push(`Decision ${entry.id} has incomplete candidate groups.`);
    }
    if (decision.selectedStepId) decision.outcome = "selected-only";
    else if (decision.fallbackReason) decision.outcome = "explore-fallback";
    for (const state of decision.states) {
      for (const candidate of state.candidates) {
        const message = byId.get(candidate.id);
        if (owner(candidate.id) !== rootEntryId || message?.type !== "message" || message.message.role !== "assistant") {
          view.diagnostics.push(`Candidate ${candidate.id} in decision ${entry.id} is unavailable in this run.`);
        }
      }
    }
    if (decision.selectedStepId) {
      const selected = steps.get(decision.selectedStepId);
      if (!selected || !decision.states.some((state) => state.candidates.some((candidate) => candidate.id === decision.selectedStepId))) {
        view.diagnostics.push(`Decision ${entry.id} references an unavailable or unlisted selected step.`);
      }
      if (selected && decision.iteration) selected.selectedIn.push(decision.iteration);
    }
    view.decisions.push(decision);
  }
  return view;
}

export function replaySummary(view: ReplayView): string {
  return [
    `Replay ${view.rootEntryId}${view.active ? " (active branch)" : ""}`,
    `Prompt: ${view.prompt ?? "unknown"}; requested iterations: ${view.requestedCount ?? "unknown"}`,
    `${view.steps.length} recorded steps; ${view.decisions.length} exploitation decisions`,
    ...view.decisions.map((decision) => `Iteration ${decision.iteration ?? "?"}: ${decision.outcome}${decision.selectedStepId ? ` → ${decision.selectedStepId}` : ""}${decision.fallbackReason ? ` (${decision.fallbackReason})` : ""}`),
    ...view.diagnostics.map((message) => `Warning: ${message}`),
    "Read-only snapshot. Selection-only is not a generated branch; patches are not evaluated.",
  ].join("\n");
}
