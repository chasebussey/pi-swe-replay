import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RegressionEvaluation } from "./evaluation";
import type { FinalSelectionCandidate, FinalSelectionDecision, FinalSelectionEvaluation, FinalSelectionScope } from "./final-selection";
import { isSupportedNormalizationProvenance } from "./normalization-policy";
import type { WorkspaceContentTree, WorkspaceSnapshot } from "./workspace";

export interface ReplayBaseRecord extends FinalSelectionScope {
  schemaVersion: 1;
  requestedCount: number;
  snapshot: WorkspaceSnapshot;
  tree: WorkspaceContentTree;
}

export interface ReplayCandidateRecord {
  schemaVersion: 1;
  rootEntryId: string;
  iteration: number;
  terminalEntryId: string;
  snapshot: WorkspaceSnapshot;
}

export interface ReplayEvaluationRecord extends RegressionEvaluation {
  schemaVersion: 1;
  /** Absent only for the baseline. */
  candidateEntryId?: string;
  testCommand: string;
  testTimeoutMs: number;
  cwd: string;
}

export interface ReplayIdentityRecord {
  schemaVersion: 1;
  rootEntryId: string;
  candidateEntryId: string;
  tree: WorkspaceContentTree;
  normalization: FinalSelectionCandidate["normalization"];
}

export interface ReplayFinalSelectionRecord {
  schemaVersion: 1;
  rootEntryId: string;
  baseEntryId: string;
  candidateEntryIds: string[];
  identityEntryIds: string[];
  evaluationEntryIds: string[];
  decision: FinalSelectionDecision;
}

export interface ArchiveDiagnostic {
  code: string;
  entryId: string;
}

export interface ReplayArchive {
  baseEntryId: string;
  base: ReplayBaseRecord;
  candidates: (ReplayCandidateRecord & { entryId: string })[];
  evaluations: FinalSelectionEvaluation[];
  baselineEntryIds: string[];
  identities: (ReplayIdentityRecord & { entryId: string })[];
}

export type ArchiveReadResult =
  | { status: "available"; archive: ReplayArchive }
  | { status: "unavailable"; diagnostics: ArchiveDiagnostic[] };

/** appendEntry returns void in Pi; immediately capture the newly appended leaf. */
export function appendReplayRecord<T>(
  pi: Pick<ExtensionAPI, "appendEntry">, ctx: Pick<ExtensionCommandContext, "sessionManager">,
  customType: string, data: T,
): string {
  pi.appendEntry(customType, data);
  const entry = ctx.sessionManager.getLeafEntry();
  if (entry?.type !== "custom" || entry.customType !== customType || entry.data !== data) {
    throw new Error(`Could not identify appended ${customType} entry.`);
  }
  return entry.id;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const oid = (value: unknown): value is string => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function snapshot(value: unknown): value is WorkspaceSnapshot {
  const s = record(value);
  return !!s && text(s.rootEntryId) && text(s.stepId) && oid(s.oid)
    && typeof s.ref === "string" && s.ref.startsWith("refs/swe-replay/");
}

function tree(value: unknown): value is WorkspaceContentTree {
  const t = record(value);
  return !!t && text(t.rootEntryId) && oid(t.snapshotOid) && oid(t.treeOid)
    && typeof t.ref === "string" && t.ref.startsWith("refs/swe-replay/trees/");
}

function normalization(value: unknown): value is ReplayIdentityRecord["normalization"] {
  const n = record(value);
  if (!n || !isSupportedNormalizationProvenance(n)
    || !oid(n.baseTreeOid) || !oid(n.candidateTreeOid) || typeof n.keyHash !== "string" || !/^[0-9a-f]{64}$/.test(n.keyHash)
    || typeof n.rawEmpty !== "boolean" || typeof n.normalizationEmpty !== "boolean" || !Array.isArray(n.diagnostics)) return false;

  return n.diagnostics.every((value) => {
    const d = record(value);
    return d?.kind === "exact-content-fallback" && text(d.path) && typeof d.message === "string"
      && ["SyntaxError", "IndentationError", "TabError"].includes(String(d.pythonType));
  });
}

interface ReplayRecordEnvelope extends Record<string, unknown> {
  schemaVersion: 1;
  rootEntryId: string;
}

function isReplayRecordForRoot(
  data: Record<string, unknown> | undefined, rootEntryId: string,
): data is ReplayRecordEnvelope {
  return data?.schemaVersion === 1 && data.rootEntryId === rootEntryId;
}

// Parse payload shapes after the shared envelope check. Run ownership, ancestry,
// and relationships between otherwise valid records are checked by the archive reader.
function parseBaseRecord(data: ReplayRecordEnvelope): ReplayBaseRecord | undefined {
  if (!snapshot(data.snapshot) || !tree(data.tree) || !oid(data.baseTreeOid)
    || !positive(data.requestedCount) || !text(data.testCommand) || !data.testCommand.trim()
    || !positive(data.testTimeoutMs) || !text(data.cwd)) {
    return;
  }

  return {
    ...data, snapshot: data.snapshot, tree: data.tree, baseTreeOid: data.baseTreeOid,
    requestedCount: data.requestedCount, testCommand: data.testCommand,
    testTimeoutMs: data.testTimeoutMs, cwd: data.cwd,
  };
}

function parseCandidateRecord(data: ReplayRecordEnvelope): ReplayCandidateRecord | undefined {
  if (!positive(data.iteration) || !text(data.terminalEntryId) || !snapshot(data.snapshot)) {
    return;
  }

  return { ...data, iteration: data.iteration, terminalEntryId: data.terminalEntryId, snapshot: data.snapshot };
}

function parseIdentityRecord(data: ReplayRecordEnvelope): ReplayIdentityRecord | undefined {
  if (!text(data.candidateEntryId) || !tree(data.tree) || !normalization(data.normalization)) {
    return;
  }

  return { ...data, candidateEntryId: data.candidateEntryId, tree: data.tree, normalization: data.normalization };
}

function parseEvaluationRecord(data: ReplayRecordEnvelope): ReplayEvaluationRecord | undefined {
  if (typeof data.iteration !== "number" || !Number.isSafeInteger(data.iteration) || data.iteration < 0
    || !text(data.terminalEntryId) || !oid(data.snapshotOid)
    || (data.status !== "passed" && data.status !== "failed" && data.status !== "inconclusive")
    || typeof data.stdout !== "string" || typeof data.stderr !== "string"
    || typeof data.durationMs !== "number" || !Number.isFinite(data.durationMs) || data.durationMs < 0
    || (data.exitCode !== undefined && (typeof data.exitCode !== "number" || !Number.isInteger(data.exitCode)))
    || (data.killed !== undefined && typeof data.killed !== "boolean")
    || (data.error !== undefined && typeof data.error !== "string")
    || !text(data.testCommand) || !positive(data.testTimeoutMs) || !text(data.cwd)
    || (data.candidateEntryId !== undefined && !text(data.candidateEntryId))) {
    return;
  }

  const candidateEntryId = data.candidateEntryId;
  if (data.iteration === 0 ? candidateEntryId !== undefined : candidateEntryId === undefined) {
    return;
  }

  return {
    ...data, iteration: data.iteration, terminalEntryId: data.terminalEntryId, snapshotOid: data.snapshotOid,
    status: data.status, stdout: data.stdout, stderr: data.stderr, durationMs: data.durationMs,
    testCommand: data.testCommand, testTimeoutMs: data.testTimeoutMs, cwd: data.cwd,
  };
}

/**
 * Parse explicit v1 associations across ALL branches. Never infer candidates from
 * current leaves or migrate older runs. Missing identity/evaluation records are
 * allowed here so interrupted candidate capture remains inspectable; completion
 * and selection have stricter requirements below.
 */
export function readReplayArchive(entries: readonly SessionEntry[], rootEntryId: string): ArchiveReadResult {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length) {
    return { status: "unavailable", diagnostics: [{ code: "duplicate-session-entry", entryId: rootEntryId }] };
  }
  const root = byId.get(rootEntryId);
  const metadata = root?.type === "custom" && root.customType === "swe-replay-root" ? record(root.data) : undefined;
  if (metadata?.schemaVersion !== 1) {
    return { status: "unavailable", diagnostics: [{ code: "unsupported-or-missing-root", entryId: rootEntryId }] };
  }

  const diagnostics: ArchiveDiagnostic[] = [];
  const issue = (code: string, entryId: string) => diagnostics.push({ code, entryId });
  function owner(id: string): string | undefined {
    const seen = new Set<string>();
    let current: string | null = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      const entry = byId.get(current);
      if (!entry) return;
      if (entry.type === "custom" && entry.customType === "swe-replay-root") return entry.id;
      current = entry.parentId;
    }
  }
  function ancestor(id: string, target: string): boolean {
    const seen = new Set<string>();
    let current = byId.get(id)?.parentId;
    while (current && !seen.has(current)) {
      if (current === target) return true;
      seen.add(current);
      current = byId.get(current)?.parentId;
    }
    return false;
  }

  const bases: (ReplayBaseRecord & { entryId: string })[] = [];
  const candidates: ReplayArchive["candidates"] = [];
  const evaluations: FinalSelectionEvaluation[] = [];
  const baselines: (ReplayEvaluationRecord & { entryId: string })[] = [];
  const identities: ReplayArchive["identities"] = [];
  const relevant = new Set(["swe-replay-base", "swe-replay-candidate", "swe-replay-evaluation", "swe-replay-patch-identity"]);

  for (const entry of entries) {
    if (entry.type !== "custom" || !relevant.has(entry.customType)) continue;
    const data = record(entry.data);
    if (owner(entry.id) !== rootEntryId) {
      if (data?.rootEntryId === rootEntryId) issue("record-outside-run", entry.id);
      continue;
    }
    if (!isReplayRecordForRoot(data, rootEntryId)) {
      issue("unsupported-or-mismatched-record", entry.id);
      continue;
    }
    if (entry.customType === "swe-replay-base") {
      const base = parseBaseRecord(data);
      if (!base || base.snapshot.rootEntryId !== rootEntryId || base.snapshot.stepId !== rootEntryId
        || base.tree.rootEntryId !== rootEntryId || base.tree.snapshotOid !== base.snapshot.oid
        || base.baseTreeOid !== base.tree.treeOid || base.requestedCount !== metadata.requestedPatchCount
        || base.testCommand !== metadata.testCommand || base.testTimeoutMs !== metadata.testTimeoutMs
        || base.cwd !== metadata.cwd) {
        issue("invalid-base", entry.id);
        continue;
      }

      bases.push({ ...base, entryId: entry.id });
    } else if (entry.customType === "swe-replay-candidate") {
      const candidate = parseCandidateRecord(data);
      if (!candidate || candidate.snapshot.rootEntryId !== rootEntryId
        || candidate.snapshot.stepId !== candidate.terminalEntryId || entry.parentId !== candidate.terminalEntryId
        || owner(candidate.terminalEntryId) !== rootEntryId) {
        issue("invalid-candidate-association", entry.id);
        continue;
      }

      candidates.push({ ...candidate, entryId: entry.id });
    } else if (entry.customType === "swe-replay-patch-identity") {
      const identity = parseIdentityRecord(data);
      if (!identity) {
        issue("invalid-or-unsupported-patch-identity", entry.id);
        continue;
      }

      identities.push({ ...identity, entryId: entry.id });
    } else {
      const evaluation = parseEvaluationRecord(data);
      if (!evaluation) {
        issue("invalid-evaluation", entry.id);
        continue;
      }

      if (evaluation.iteration === 0) baselines.push({ ...evaluation, entryId: entry.id });
      else evaluations.push({ entryId: entry.id, candidateEntryId: evaluation.candidateEntryId!,
        testCommand: evaluation.testCommand, testTimeoutMs: evaluation.testTimeoutMs, cwd: evaluation.cwd, evaluation });
    }
  }

  if (bases.length !== 1) issue("missing-or-ambiguous-base", rootEntryId);
  const base = bases[0];
  if (base) {
    if (baselines.length !== 1 || baselines.some((e) => e.status !== "passed" || e.exitCode !== 0 || e.killed || e.error !== undefined
      || e.snapshotOid !== base.snapshot.oid || !ancestor(e.entryId, e.terminalEntryId)
      || e.testCommand !== base.testCommand || e.testTimeoutMs !== base.testTimeoutMs || e.cwd !== base.cwd)) {
      issue("missing-or-invalid-passing-baseline", rootEntryId);
    }
    for (const candidate of candidates) {
      if (candidate.iteration > base.requestedCount) issue("iteration-out-of-range", candidate.entryId);
    }
  }
  const candidateById = new Map(candidates.map((c) => [c.entryId, c]));
  for (const e of evaluations) {
    const candidate = candidateById.get(e.candidateEntryId);
    if (!candidate || !ancestor(e.entryId, candidate.entryId)) issue("invalid-evaluation-link", e.entryId);
  }
  for (const identity of identities) {
    const candidate = candidateById.get(identity.candidateEntryId);
    if (!candidate || identity.tree.rootEntryId !== rootEntryId || identity.tree.snapshotOid !== candidate.snapshot.oid
      || identity.tree.treeOid !== identity.normalization.candidateTreeOid
      || identity.normalization.baseTreeOid !== base?.baseTreeOid) issue("invalid-identity-link", identity.entryId);
  }

  if (diagnostics.length) return { status: "unavailable", diagnostics };
  return { status: "available", archive: {
    baseEntryId: base.entryId, base, candidates, evaluations, identities, baselineEntryIds: baselines.map((e) => e.entryId),
  } };
}

/** Require a complete parsed archive, before or after patch identities are available. */
export function assertReplayComplete(archive: ReplayArchive): void {
  const { candidates, evaluations, base } = archive;
  const iterations = new Set(candidates.map((candidate) => candidate.iteration));
  const evaluatedCandidateIds = new Set(evaluations.map((evaluation) => evaluation.candidateEntryId));
  const hasMissingEvaluation = candidates.some((candidate) => !evaluatedCandidateIds.has(candidate.entryId));
  const hasInconclusiveEvaluation = evaluations.some((evaluation) => evaluation.evaluation.status === "inconclusive");
  if (iterations.size !== base.requestedCount || hasMissingEvaluation || hasInconclusiveEvaluation) {
    throw new Error("Replay archive is incomplete or inconclusive; final selection is unavailable.");
  }
}

/** Automatic finalization only: no partial-run selection and no new regression execution. */
export function completedSelectionInputs(archive: ReplayArchive): FinalSelectionCandidate[] {
  assertReplayComplete(archive);

  return archive.candidates.map((candidate) => {
    const identities = archive.identities.filter((identity) => identity.candidateEntryId === candidate.entryId);
    if (identities.length !== 1) throw new Error(`Missing or ambiguous patch identity for ${candidate.entryId}.`);
    return { ...candidate, normalization: identities[0].normalization };
  });
}
