import { isConsistentRegressionOutcome, type RegressionEvaluation } from "./evaluation";
import type { PatchNormalizationResult } from "./patch-normalization";
import { isSupportedNormalizationProvenance, PATCH_IDENTITY_POLICY } from "./normalization-policy";
import type { WorkspaceSnapshot } from "./workspace";

export const FINAL_VOTING_POLICY = "passing-candidate-occurrences-v1";

export interface FinalSelectionScope {
  rootEntryId: string;
  baseTreeOid: string;
  testCommand: string;
  testTimeoutMs: number;
  cwd: string;
}

/** Explicit completed-iteration input, not a persisted-entry schema or a tree leaf. */
export interface FinalSelectionCandidate {
  entryId: string;
  rootEntryId: string;
  iteration: number;
  terminalEntryId: string;
  snapshot: WorkspaceSnapshot;
  normalization: PatchNormalizationResult["patches"][number] & {
    policy: PatchNormalizationResult["policy"];
    python: PatchNormalizationResult["python"];
  };
}

/** The future persistence adapter must establish this append-only association. */
export interface FinalSelectionEvaluation {
  entryId: string;
  candidateEntryId: string;
  testCommand: string;
  testTimeoutMs: number;
  cwd: string;
  evaluation: Pick<RegressionEvaluation,
    "rootEntryId" | "iteration" | "terminalEntryId" | "snapshotOid" | "status" | "exitCode" | "killed" | "error">;
}

export const FINAL_SELECTION_EXCLUSIONS = [
  "wrong-run", "invalid-candidate", "unsupported-normalization", "base-tree-mismatch",
  "conflicting-candidate-records", "conflicting-evaluation-records",
  "evaluation-association-mismatch", "evaluation-command-mismatch", "invalid-evaluation",
  "unevaluated", "regression-failed", "regression-inconclusive", "raw-empty", "normalization-empty",
] as const;

export type FinalSelectionExclusion = typeof FINAL_SELECTION_EXCLUSIONS[number];

export interface FinalSelectionDiagnostic {
  code: FinalSelectionExclusion | "duplicate-candidate" | "duplicate-evaluation" | "orphan-evaluation";
  candidateEntryIds: string[];
  evaluationEntryIds: string[];
}

export interface FinalSelectionGroup {
  keyHash: string;
  candidateEntryIds: string[];
  iterations: number[];
  votes: number;
  representativeCandidateEntryId: string;
  representativeIteration: number;
}

interface FinalSelectionDecisionBase {
  rootEntryId: string;
  baseTreeOid: string;
  policy: {
    voting: typeof FINAL_VOTING_POLICY;
    equivalence: typeof PATCH_IDENTITY_POLICY;
    tieBreak: "earliest-passing-iteration";
  };
  candidates: {
    candidateEntryId: string;
    /** Null for malformed, non-integral iteration numbers. */
    iteration: number | null;
    status: "eligible" | "excluded" | "duplicate";
    exclusionReasons: FinalSelectionExclusion[];
    canonicalCandidateEntryId: string;
    evaluationEntryIds: string[];
  }[];
  groups: FinalSelectionGroup[];
  eligibleCount: number;
  /** Top-vote groups only; empty when the top rank is not tied. */
  tiedGroupKeyHashes: string[];
  diagnostics: FinalSelectionDiagnostic[];
}

export type FinalSelectionDecision = FinalSelectionDecisionBase & (
  | { status: "selected"; selectedCandidateEntryId: string; selectedKeyHash: string }
  | { status: "no-valid-candidates" }
);

const text = (value: string) => typeof value === "string" && value.length > 0;
const oid = (value: string) => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function candidateKey(candidate: FinalSelectionCandidate): string {
  const { snapshot: s, normalization: n } = candidate;
  const p = n.python;
  // Diagnostics and record IDs are not occurrence identity. No object-key-order dependence.
  return JSON.stringify([candidate.rootEntryId, candidate.iteration, candidate.terminalEntryId,
    s.rootEntryId, s.stepId, s.oid, s.ref, n.baseTreeOid, n.candidateTreeOid,
    n.policy, p.policy, p.upstreamRevision, p.pyodideVersion, p.pythonVersion, p.gitDiffPolicy,
    n.keyHash, n.rawEmpty, n.normalizationEmpty]);
}

function evaluationKey(record: FinalSelectionEvaluation): string {
  const e = record.evaluation;
  // Candidate aliases for the same iteration may each have an association record.
  return JSON.stringify([record.testCommand, record.testTimeoutMs, record.cwd,
    e.rootEntryId, e.iteration, e.terminalEntryId, e.snapshotOid, e.status,
    e.exitCode ?? null, e.killed ?? false, e.error ?? null]);
}

function candidateExclusions(scope: FinalSelectionScope, c: FinalSelectionCandidate): FinalSelectionExclusion[] {
  const n = c.normalization;
  const reasons: FinalSelectionExclusion[] = [];
  if (c.rootEntryId !== scope.rootEntryId) reasons.push("wrong-run");
  if (!text(c.entryId) || !text(c.terminalEntryId) || !Number.isSafeInteger(c.iteration) || c.iteration <= 0
    || c.snapshot.rootEntryId !== c.rootEntryId || c.snapshot.stepId !== c.terminalEntryId
    || !oid(c.snapshot.oid) || !text(c.snapshot.ref) || !oid(n.baseTreeOid) || !oid(n.candidateTreeOid)
    || typeof n.keyHash !== "string" || !/^[0-9a-f]{64}$/.test(n.keyHash)
    || typeof n.rawEmpty !== "boolean" || typeof n.normalizationEmpty !== "boolean"
    || (n.rawEmpty && !n.normalizationEmpty)
    || (n.rawEmpty !== (n.baseTreeOid === n.candidateTreeOid))) reasons.push("invalid-candidate");
  if (!isSupportedNormalizationProvenance(n)) {
    reasons.push("unsupported-normalization");
  }
  if (n.baseTreeOid !== scope.baseTreeOid) reasons.push("base-tree-mismatch");
  if (n.rawEmpty) reasons.push("raw-empty");
  else if (n.normalizationEmpty) reasons.push("normalization-empty");
  return reasons;
}

interface IterationAssessment {
  iteration: number;
  canonicalCandidate: FinalSelectionCandidate;
  candidateEntryIds: string[];
  evaluationEntryIds: string[];
  evaluationCount: number;
  exclusionReasons: FinalSelectionExclusion[];
}

interface AssessmentContext {
  scope: FinalSelectionScope;
  evaluationsByCandidate: ReadonlyMap<string, readonly FinalSelectionEvaluation[]>;
  evaluationKeysById: ReadonlyMap<string, ReadonlySet<string>>;
  conflictingCandidateIds: ReadonlySet<string>;
}

/** Assess one occurrence, including all aliases, without recording outcomes or votes. */
function assessIteration(
  iteration: number,
  records: readonly FinalSelectionCandidate[],
  context: AssessmentContext,
): IterationAssessment {
  const { scope, evaluationsByCandidate, evaluationKeysById, conflictingCandidateIds } = context;
  const candidateEntryIds = [...new Set(records.map((candidate) => candidate.entryId))].sort(compareText);

  // Prefer a directly evaluated record over an unevaluated duplicate alias.
  // Within one iteration, record-ID order is only a stable alias tie-break.
  const canonicalId = candidateEntryIds.find((id) => evaluationsByCandidate.has(id)) ?? candidateEntryIds[0];
  const canonicalCandidate = records.find((candidate) => candidate.entryId === canonicalId)!;
  const evidence = candidateEntryIds.flatMap((id) => evaluationsByCandidate.get(id) ?? []);
  const evaluationEntryIds = [...new Set(evidence.map((record) => record.entryId))].sort(compareText);

  const reasons = records.flatMap((record) => candidateExclusions(scope, record));
  const hasCandidateConflict = new Set(records.map(candidateKey)).size > 1
    || candidateEntryIds.some((id) => conflictingCandidateIds.has(id));
  if (hasCandidateConflict) reasons.push("conflicting-candidate-records");

  if (!evidence.length) reasons.push("unevaluated");
  const hasEvaluationConflict = new Set(evidence.map(evaluationKey)).size > 1
    || evidence.some((record) => evaluationKeysById.get(record.entryId)!.size > 1);
  if (hasEvaluationConflict) reasons.push("conflicting-evaluation-records");

  for (const record of evidence) {
    const evaluation = record.evaluation;
    if (evaluation.rootEntryId !== scope.rootEntryId || evaluation.iteration !== iteration
      || evaluation.terminalEntryId !== canonicalCandidate.terminalEntryId
      || evaluation.snapshotOid !== canonicalCandidate.snapshot.oid) {
      reasons.push("evaluation-association-mismatch");
    }
    if (record.testCommand !== scope.testCommand || record.testTimeoutMs !== scope.testTimeoutMs || record.cwd !== scope.cwd) {
      reasons.push("evaluation-command-mismatch");
    }
    if (!text(record.entryId) || !isConsistentRegressionOutcome(evaluation)) {
      reasons.push("invalid-evaluation");
    }
    if (evaluation.status === "failed") reasons.push("regression-failed");
    if (evaluation.status === "inconclusive") reasons.push("regression-inconclusive");
  }

  return {
    iteration, canonicalCandidate, candidateEntryIds, evaluationEntryIds,
    evaluationCount: evidence.length,
    exclusionReasons: [...new Set(reasons)].sort(compareText),
  };
}

/** One eligible assessment contributes one vote, regardless of its alias/evidence counts. */
function aggregateVotes(assessments: readonly IterationAssessment[]): FinalSelectionGroup[] {
  const groupsByHash = new Map<string, FinalSelectionGroup>();
  const chronological = [...assessments].sort((a, b) => a.iteration - b.iteration);

  for (const assessment of chronological) {
    if (assessment.exclusionReasons.length) continue;

    const { iteration, canonicalCandidate } = assessment;
    const keyHash = canonicalCandidate.normalization.keyHash;
    const group = groupsByHash.get(keyHash) ?? {
      keyHash, candidateEntryIds: [], iterations: [], votes: 0,
      representativeCandidateEntryId: canonicalCandidate.entryId, representativeIteration: iteration,
    };
    group.candidateEntryIds.push(canonicalCandidate.entryId);
    group.iterations.push(iteration);
    group.votes++;
    groupsByHash.set(keyHash, group);
  }

  return [...groupsByHash.values()].sort((a, b) => b.votes - a.votes || a.representativeIteration - b.representativeIteration);
}

/**
 * Pure, deterministic occurrence voting. Inputs are typed projections, not unknown
 * persisted JSON: persistence parsing is separate. The caller must establish run
 * completion before invoking this; inconclusive runs must still stop orchestration.
 * No ancestry/leaf inference, normalization, test execution, randomness or I/O.
 */
export function selectFinalPatch(
  scope: FinalSelectionScope,
  candidates: readonly FinalSelectionCandidate[],
  evaluations: readonly FinalSelectionEvaluation[],
): FinalSelectionDecision {
  if (!text(scope.rootEntryId) || !oid(scope.baseTreeOid) || !scope.testCommand.trim()
    || !text(scope.cwd) || !Number.isFinite(scope.testTimeoutMs) || scope.testTimeoutMs <= 0) {
    throw new Error("Invalid final-selection scope.");
  }

  const diagnostics: FinalSelectionDiagnostic[] = [];
  const diagnose = (code: FinalSelectionDiagnostic["code"], ids: string[], evalIds: string[] = []) => {
    diagnostics.push({ code, candidateEntryIds: [...new Set(ids)].sort(compareText), evaluationEntryIds: [...new Set(evalIds)].sort(compareText) });
  };
  const byId = new Map<string, FinalSelectionCandidate[]>();
  for (const candidate of candidates) {
    const records = byId.get(candidate.entryId) ?? [];
    records.push(candidate);
    byId.set(candidate.entryId, records);
  }
  const evaluationIds = new Map<string, Set<string>>();
  const byCandidate = new Map<string, FinalSelectionEvaluation[]>();
  for (const record of evaluations) {
    const keys = evaluationIds.get(record.entryId) ?? new Set<string>();
    keys.add(JSON.stringify([record.candidateEntryId, evaluationKey(record)]));
    evaluationIds.set(record.entryId, keys);
    const records = byCandidate.get(record.candidateEntryId) ?? [];
    records.push(record);
    byCandidate.set(record.candidateEntryId, records);
    if (!byId.has(record.candidateEntryId)) diagnose("orphan-evaluation", [record.candidateEntryId], [record.entryId]);
  }

  const outcomes: FinalSelectionDecisionBase["candidates"] = [];
  const conflictingIds = new Set<string>();
  const iterations = new Map<number, FinalSelectionCandidate[]>();
  for (const records of byId.values()) {
    records.sort((a, b) => compareText(candidateKey(a), candidateKey(b)));
    const candidate = records[0];
    if (new Set(records.map(candidateKey)).size > 1) conflictingIds.add(candidate.entryId);
    else if (records.length > 1) diagnose("duplicate-candidate", [candidate.entryId]);

    for (const record of records) {
      if (record.rootEntryId === scope.rootEntryId && Number.isSafeInteger(record.iteration) && record.iteration > 0) {
        const bucket = iterations.get(record.iteration) ?? [];
        bucket.push(record);
        iterations.set(record.iteration, bucket);
      }
    }
    if (!records.some((record) => record.rootEntryId === scope.rootEntryId && Number.isSafeInteger(record.iteration) && record.iteration > 0)) {
      const reasons = candidateExclusions(scope, candidate);
      if (conflictingIds.has(candidate.entryId)) reasons.push("conflicting-candidate-records");
      const evalIds = (byCandidate.get(candidate.entryId) ?? []).map((e) => e.entryId);
      const iteration = Number.isSafeInteger(candidate.iteration) ? candidate.iteration : null;
      outcomes.push({ candidateEntryId: candidate.entryId, iteration, status: "excluded",
        exclusionReasons: reasons, canonicalCandidateEntryId: candidate.entryId, evaluationEntryIds: [...new Set(evalIds)].sort(compareText) });
      for (const reason of reasons) diagnose(reason, [candidate.entryId], evalIds);
    }
  }

  const assessmentContext: AssessmentContext = {
    scope, evaluationsByCandidate: byCandidate, evaluationKeysById: evaluationIds,
    conflictingCandidateIds: conflictingIds,
  };
  const orderedIterations = [...iterations].sort(([a], [b]) => a - b);
  const assessments = orderedIterations.map(([iteration, records]) => assessIteration(iteration, records, assessmentContext));

  for (const assessment of assessments) {
    const { iteration, canonicalCandidate, candidateEntryIds, evaluationEntryIds, exclusionReasons } = assessment;
    for (const reason of exclusionReasons) diagnose(reason, candidateEntryIds, evaluationEntryIds);
    if (!exclusionReasons.length && candidateEntryIds.length > 1) {
      diagnose("duplicate-candidate", candidateEntryIds, evaluationEntryIds);
    }
    if (!exclusionReasons.length && assessment.evaluationCount > 1) {
      diagnose("duplicate-evaluation", candidateEntryIds, evaluationEntryIds);
    }

    for (const id of candidateEntryIds) {
      if (outcomes.some((outcome) => outcome.candidateEntryId === id)) continue;

      outcomes.push({
        candidateEntryId: id, iteration,
        status: exclusionReasons.length ? "excluded" : id === canonicalCandidate.entryId ? "eligible" : "duplicate",
        exclusionReasons: [...exclusionReasons], canonicalCandidateEntryId: canonicalCandidate.entryId,
        evaluationEntryIds: [...evaluationEntryIds],
      });
    }
  }

  const groups = aggregateVotes(assessments);
  const top = groups[0];
  const tied = groups.filter((group) => group.votes === top?.votes);
  outcomes.sort((a, b) => (a.iteration ?? Infinity) - (b.iteration ?? Infinity)
    || compareText(a.candidateEntryId, b.candidateEntryId));
  // Stable captured output even when records arrive in a different storage order.
  const uniqueDiagnostics = [...new Map(diagnostics.map((d) => [JSON.stringify(d), d])).values()];
  uniqueDiagnostics.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
  const decision: FinalSelectionDecisionBase = {
    rootEntryId: scope.rootEntryId, baseTreeOid: scope.baseTreeOid,
    policy: { voting: FINAL_VOTING_POLICY, equivalence: PATCH_IDENTITY_POLICY, tieBreak: "earliest-passing-iteration" },
    candidates: outcomes, groups, eligibleCount: groups.reduce((sum, group) => sum + group.votes, 0),
    tiedGroupKeyHashes: tied.length > 1 ? tied.map((group) => group.keyHash) : [], diagnostics: uniqueDiagnostics,
  };
  return top
    ? { ...decision, status: "selected", selectedCandidateEntryId: top.representativeCandidateEntryId, selectedKeyHash: top.keyHash }
    : { ...decision, status: "no-valid-candidates" };
}
