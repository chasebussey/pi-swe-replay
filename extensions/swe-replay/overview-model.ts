import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isConsistentRegressionOutcome } from "./evaluation";
import type { FinalSelectionDecision } from "./final-selection";
import { parseFinalSelectionRecord, parseRestorationEvidence, positive, record, strings } from "./overview-records";
import { assertReplayComplete, parseReplayEvaluation, readReplayArchive, type ReplayArchive, type ReplayEvaluationRecord } from "./replay-records";

export interface IterationOverview {
  candidateEntryId: string;
  iteration: number;
  terminalEntryId: string;
  approach: string;
  targetStepId?: string;
  evaluation?: ReplayEvaluationRecord;
  group?: string;
  vote: string;
  representative: boolean;
}

export interface ReplayOverview {
  headline: string;
  archiveAvailable?: boolean;
  notes: string[];
  iterations: IterationOverview[];
  groups: { label: string; votes: number; iterations: number[]; representativeIteration: number; selected: boolean }[];
  eligibleCount?: number;
  baseline?: ReplayEvaluationRecord;
  testCommand?: string;
  testTimeoutMs?: number;
  cwd?: string;
  diagnostics: string[];
}

const sameIds = (value: unknown, ids: string[]) => strings(value) && value.length === ids.length
  && new Set(value).size === value.length && ids.every((id) => value.includes(id));

/** Validate captured decisions, never run normalization or voting during inspection. */
function capturedDecision(d: FinalSelectionDecision, archive: ReplayArchive): FinalSelectionDecision | undefined {
  if (d.rootEntryId !== archive.base.rootEntryId || d.baseTreeOid !== archive.base.baseTreeOid) return;

  try {
    assertReplayComplete(archive);
  } catch {
    return;
  }

  const candidateById = new Map(archive.candidates.map((c) => [c.entryId, c]));
  const seen = new Set<string>();
  for (const c of d.candidates) {
    const source = candidateById.get(c.candidateEntryId);
    if (!source || seen.has(source.entryId) || c.iteration !== source.iteration
      || !candidateById.has(c.canonicalCandidateEntryId)
      || c.evaluationEntryIds.some((id) => !archive.evaluations.some((e) => e.entryId === id))
      || (c.status === "eligible" && c.exclusionReasons.length !== 0)
      || (c.status === "excluded" && c.exclusionReasons.length === 0)) return;
    if (c.status === "eligible") {
      const evaluationIds = c.evaluationEntryIds;
      const evidence = archive.evaluations.filter((e) => evaluationIds.includes(e.entryId));
      if (evidence.length === 0 || evidence.some((e) => e.evaluation.status !== "passed"
        || e.evaluation.iteration !== source.iteration || e.evaluation.snapshotOid !== source.snapshot.oid
        || e.evaluation.terminalEntryId !== source.terminalEntryId)) return;
    }
    seen.add(source.entryId);
  }
  if (seen.size !== candidateById.size) return;

  const eligibleIds = new Set(d.candidates.filter((c) => c.status === "eligible").map((c) => c.candidateEntryId));
  const groupedIds = new Set<string>();
  const groupedIterations = new Set<number>();
  const keys = new Set<string>();
  let votes = 0;
  for (const g of d.groups) {
    if (keys.has(g.keyHash) || g.votes !== g.candidateEntryIds.length || g.iterations.length !== g.votes
      || !g.candidateEntryIds.includes(g.representativeCandidateEntryId)
      || candidateById.get(g.representativeCandidateEntryId)?.iteration !== g.representativeIteration) return;

    for (const [index, id] of g.candidateEntryIds.entries()) {
      if (groupedIds.has(id) || !eligibleIds.has(id) || candidateById.get(id)?.iteration !== g.iterations[index]
        || !archive.identities.some((identity) => identity.candidateEntryId === id && identity.normalization.keyHash === g.keyHash)) return;
      const iteration = candidateById.get(id)!.iteration;
      const identity = archive.identities.filter((i) => i.candidateEntryId === id);
      if (groupedIterations.has(iteration) || identity.length !== 1
        || identity[0].normalization.rawEmpty || identity[0].normalization.normalizationEmpty) return;
      groupedIds.add(id);
      groupedIterations.add(iteration);
    }
    keys.add(g.keyHash);
    votes += g.votes;
  }
  if (votes !== d.eligibleCount || groupedIds.size !== eligibleIds.size
    || new Set(d.tiedGroupKeyHashes).size !== d.tiedGroupKeyHashes.length
    || d.tiedGroupKeyHashes.some((key) => !keys.has(key))) return;

  for (const [index, group] of d.groups.entries()) {
    if (group.representativeIteration !== Math.min(...group.iterations)) return;
    const previous = d.groups[index - 1];
    if (previous && (previous.votes < group.votes
      || (previous.votes === group.votes && previous.representativeIteration > group.representativeIteration))) return;
  }
  const topVotes = d.groups[0]?.votes;
  const topGroups = d.groups.filter((g) => g.votes === topVotes);
  if (!sameIds(d.tiedGroupKeyHashes, topGroups.length > 1 ? topGroups.map((g) => g.keyHash) : [])) return;

  if (d.status === "selected") {
    const winner = d.groups[0];
    if (!winner || d.selectedKeyHash !== winner.keyHash || d.selectedCandidateEntryId !== winner.representativeCandidateEntryId) return;
  } else if (d.status !== "no-valid-candidates" || votes !== 0 || d.groups.length !== 0) return;

  return d;
}

/** Entries must already be scoped by nearest replay-root ownership. */
export function buildReplayOverview(entries: readonly SessionEntry[], rootEntryId: string): ReplayOverview {
  const view: ReplayOverview = { headline: "Run incomplete · no automatic final selection recorded", notes: [], iterations: [], groups: [], diagnostics: [] };
  const root = entries.find((entry) => entry.id === rootEntryId);
  const metadata = root?.type === "custom" ? record(root.data) : undefined;
  view.testCommand = typeof metadata?.testCommand === "string" ? metadata.testCommand : undefined;
  view.testTimeoutMs = positive(metadata?.testTimeoutMs) ? metadata.testTimeoutMs : undefined;
  view.cwd = typeof metadata?.cwd === "string" ? metadata.cwd : undefined;

  const custom = entries.filter((entry) => entry.type === "custom");
  const evaluations = custom.filter((entry) => entry.customType === "swe-replay-evaluation")
    .map((entry) => ({ entry, data: parseReplayEvaluation(entry.data) }));
  const baselines = evaluations.filter(({ data }) => data?.rootEntryId === rootEntryId && data.iteration === 0);
  if (baselines.length === 1) {
    const baseline = baselines[0].data!;
    const base = custom.find((entry) => entry.id === baselines[0].entry.parentId && entry.customType === "swe-replay-base");
    const baseData = record(base?.data);
    const snapshot = record(baseData?.snapshot);
    if (baseline.testCommand === view.testCommand && baseline.testTimeoutMs === view.testTimeoutMs && baseline.cwd === view.cwd
      && isConsistentRegressionOutcome(baseline) && baseData?.rootEntryId === rootEntryId && baseline.terminalEntryId === base?.id && baseline.snapshotOid === snapshot?.oid) {
      view.baseline = baseline;
      if (baseline.status !== "passed") view.headline = `Baseline ${baseline.status} · no automatic final selection`;
    }
  }

  const result = readReplayArchive(entries, rootEntryId);
  if (result.status === "unavailable") {
    view.headline = view.baseline && view.baseline.status !== "passed" ? view.headline : "Outcome unavailable · incomplete or unsupported run records";
    view.diagnostics.push(...result.diagnostics.map((d) => `${d.code} (${d.entryId})`));
    return view;
  }

  const archive = result.archive;
  view.archiveAvailable = true;
  const exploitLogs = custom.filter((entry) => entry.customType === "swe-replay-exploit-log");
  for (const candidate of [...archive.candidates].sort((a, b) => a.iteration - b.iteration)) {
    const evidence = evaluations.filter(({ data }) => data?.candidateEntryId === candidate.entryId);
    const evaluation = evidence.length === 1 ? evidence[0].data : undefined;
    const linked = evaluation && evaluation.rootEntryId === rootEntryId && evaluation.iteration === candidate.iteration
      && evaluation.terminalEntryId === candidate.terminalEntryId && evaluation.snapshotOid === candidate.snapshot.oid
      && evaluation.testCommand === archive.base.testCommand && evaluation.testTimeoutMs === archive.base.testTimeoutMs
      && evaluation.cwd === archive.base.cwd && isConsistentRegressionOutcome(evaluation);
    if (evidence.length && !linked) view.diagnostics.push(`Ambiguous or mismatched evaluation for ${candidate.entryId}.`);

    // Logs precede navigation and usually live on a different branch from the
    // continuation. Associate by explicit run/iteration, never candidate ancestry.
    const logs = exploitLogs.filter((entry) => record(entry.data)?.iteration === candidate.iteration);
    let approach = logs.length === 0 ? "Explore" : "Unknown";
    let targetStepId: string | undefined;
    if (logs.length === 1) {
      const data = record(logs[0].data);
      const selection = record(data?.selection);
      if (data?.rootEntryId === rootEntryId) {
        targetStepId = typeof selection?.stepId === "string" ? selection.stepId : undefined;
        approach = targetStepId ? "Exploit" : typeof data.fallbackReason === "string" ? "Explore (fallback)" : "Unknown";
      }
    }
    if (approach === "Unknown") view.diagnostics.push(`Ambiguous or invalid approach for iteration ${candidate.iteration}.`);

    view.iterations.push({ candidateEntryId: candidate.entryId, iteration: candidate.iteration,
      terminalEntryId: candidate.terminalEntryId, approach, targetStepId, evaluation: linked ? evaluation : undefined,
      vote: "not recorded", representative: false });
  }

  const selections = custom.filter((entry) => entry.customType === "swe-replay-final-selection");
  if (selections.length === 0) {
    const errors = custom.filter((entry) => entry.customType === "swe-replay-finalization-error");
    for (const entry of errors) {
      const data = record(entry.data);
      if (data?.schemaVersion === 1 && data.rootEntryId === rootEntryId && typeof data.error === "string"
        && ["archive", "normalization", "selection"].includes(String(data.phase))) {
        view.headline = "Finalization failed · no final selection recorded";
        view.notes.push(`${String(data.phase)}: ${data.error}`);
      } else {
        view.diagnostics.push(`Invalid or unsupported finalization-error record (${entry.id}).`);
      }
    }
    return view;
  }

  const selection = selections[0];
  const payload = parseFinalSelectionRecord(selection.data);
  const hasInvalidEvaluation = view.diagnostics.some((message) => message.startsWith("Ambiguous or mismatched evaluation"));
  const decision = !hasInvalidEvaluation && selections.length === 1 && payload?.schemaVersion === 1 && payload.rootEntryId === rootEntryId
    && payload.baseEntryId === archive.baseEntryId
    && sameIds(payload.candidateEntryIds, archive.candidates.map((c) => c.entryId))
    && sameIds(payload.identityEntryIds, archive.identities.map((i) => i.entryId))
    && sameIds(payload.evaluationEntryIds, [...archive.baselineEntryIds, ...archive.evaluations.map((e) => e.entryId)])
    ? capturedDecision(payload.decision, archive) : undefined;
  if (!decision) {
    view.headline = "Outcome unavailable · invalid or unsupported final selection";
    view.diagnostics.push("Invalid, ambiguous, or unsupported final-selection record.");
    return view;
  }

  view.eligibleCount = decision.eligibleCount;
  view.groups = decision.groups.map((group, index) => ({ label: `G${index + 1}`, votes: group.votes,
    iterations: [...group.iterations], representativeIteration: group.representativeIteration,
    selected: decision.status === "selected" && decision.selectedKeyHash === group.keyHash }));
  for (const row of view.iterations) {
    const assessment = decision.candidates.find((c) => c.candidateEntryId === row.candidateEntryId)!;
    row.vote = assessment.status === "eligible" ? "1 vote" : `${assessment.status}: ${assessment.exclusionReasons.join(", ") || "duplicate occurrence"}`;
    const index = decision.groups.findIndex((g) => g.candidateEntryIds.includes(row.candidateEntryId));
    row.group = index >= 0 ? view.groups[index].label : undefined;
    row.representative = decision.status === "selected" && decision.selectedCandidateEntryId === row.candidateEntryId;
  }
  view.notes.push("Plurality · ties favor earliest passing iteration");
  if (decision.tiedGroupKeyHashes.length) view.notes.push("Top-vote tie resolved by earliest passing iteration.");
  view.notes.push("Regression passing does not establish task correctness.");
  if (decision.status === "no-valid-candidates") {
    view.headline = "No qualifying patch · last iteration left active";
    return view;
  }

  const winner = archive.candidates.find((c) => c.entryId === decision.selectedCandidateEntryId)!;
  view.headline = `Selected iteration ${winner.iteration} · restoration not confirmed`;
  const restorations = custom.filter((entry) => entry.customType === "swe-replay-restoration");
  const associated = restorations.flatMap((entry) => {
    const data = parseRestorationEvidence(entry.data);
    return data && data.rootEntryId === rootEntryId && data.selectionEntryId === selection.id
      && data.candidateEntryId === winner.entryId && data.targetSnapshotOid === winner.snapshot.oid
      ? [{ id: entry.id, data }] : [];
  });
  const terminal = associated.filter(({ data }) => data.status !== "started");
  if (terminal.length === 1) {
    const data = terminal[0].data;
    const attempt = associated.find((entry) => entry.id === data.attemptEntryId && entry.data.status === "started");
    if (data.status === "restored" && attempt && data.backupEntryId === attempt.data.backupEntryId
      && data.fromEntryId === attempt.data.fromEntryId && restorations.length === associated.length) {
      view.headline = `Selected iteration ${winner.iteration} · workspace and conversation restored`;
    } else if (data.status === "failed") {
      view.headline = `Selected iteration ${winner.iteration} · restoration failed`;
      view.notes.push(data.error, `Recovery: workspace ${data.workspaceRecovery}; conversation ${data.contextRecovery}`, ...data.recoveryErrors);
    } else view.diagnostics.push("Invalid restoration evidence; restoration is not confirmed.");
  } else if (terminal.length > 1) view.diagnostics.push("Ambiguous restoration evidence; restoration is not confirmed.");
  else if (associated.length) view.notes.push("Restoration started; no terminal outcome recorded.");
  if (restorations.length !== associated.length) view.diagnostics.push("Unassociated or unsupported restoration record.");
  return view;
}
