import { FINAL_SELECTION_EXCLUSIONS, FINAL_VOTING_POLICY } from "./final-selection";
import { PATCH_IDENTITY_POLICY } from "./normalization-policy";
import type { ReplayFinalSelectionRecord } from "./replay-records";

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const hash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const recovery = (value: unknown): value is "not-needed" | "restored" | "failed" => ["not-needed", "restored", "failed"].includes(String(value));

/** Payload validation only. Archive membership and associations belong to the model. */
export function parseFinalSelectionRecord(value: unknown): ReplayFinalSelectionRecord | undefined {
  const payload = record(value);
  const d = record(payload?.decision);
  const policy = record(d?.policy);
  if (!payload || payload.schemaVersion !== 1 || !text(payload.rootEntryId) || !text(payload.baseEntryId)
    || !strings(payload.candidateEntryIds) || !strings(payload.identityEntryIds) || !strings(payload.evaluationEntryIds)
    || !d || !text(d.rootEntryId) || typeof d.baseTreeOid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(d.baseTreeOid)
    || policy?.voting !== FINAL_VOTING_POLICY || policy.equivalence !== PATCH_IDENTITY_POLICY
    || policy.tieBreak !== "earliest-passing-iteration" || !Array.isArray(d.candidates) || !Array.isArray(d.groups)
    || !Array.isArray(d.diagnostics) || !strings(d.tiedGroupKeyHashes) || !d.tiedGroupKeyHashes.every(hash)
    || typeof d.eligibleCount !== "number" || !Number.isSafeInteger(d.eligibleCount) || d.eligibleCount < 0) return;

  const exclusionCodes: readonly string[] = FINAL_SELECTION_EXCLUSIONS;
  for (const raw of d.candidates) {
    const c = record(raw);
    if (!c || !text(c.candidateEntryId) || !(c.iteration === null || positive(c.iteration))
      || !["eligible", "excluded", "duplicate"].includes(String(c.status)) || !strings(c.exclusionReasons)
      || c.exclusionReasons.some((reason) => !exclusionCodes.includes(reason))
      || !text(c.canonicalCandidateEntryId) || !strings(c.evaluationEntryIds)) return;
  }
  for (const raw of d.groups) {
    const g = record(raw);
    if (!g || !hash(g.keyHash) || !strings(g.candidateEntryIds) || !Array.isArray(g.iterations)
      || !g.iterations.every(positive) || !positive(g.votes)
      || !text(g.representativeCandidateEntryId) || !positive(g.representativeIteration)) return;
  }
  for (const raw of d.diagnostics) {
    const diagnostic = record(raw);
    if (!diagnostic || !text(diagnostic.code)
      || ![...exclusionCodes, "duplicate-candidate", "duplicate-evaluation", "orphan-evaluation"].includes(diagnostic.code)
      || !strings(diagnostic.candidateEntryIds) || !strings(diagnostic.evaluationEntryIds)) return;
  }
  if (d.status === "selected") {
    if (!text(d.selectedCandidateEntryId) || !hash(d.selectedKeyHash)) return;
  } else if (d.status !== "no-valid-candidates") return;

  return payload as unknown as ReplayFinalSelectionRecord;
}

export type RestorationEvidence = {
  rootEntryId: string;
  selectionEntryId: string;
  candidateEntryId: string;
  targetSnapshotOid: string;
  fromEntryId: string;
  attemptEntryId?: string;
  backupEntryId?: string;
} & (
  | { status: "started" | "restored" }
  | { status: "failed"; error: string; workspaceRecovery: "not-needed" | "restored" | "failed";
      contextRecovery: "not-needed" | "restored" | "failed"; recoveryErrors: string[] }
);

/** Only project supported display evidence; backup payloads are not restoration targets here. */
export function parseRestorationEvidence(value: unknown): RestorationEvidence | undefined {
  const d = record(value);
  if (!d || d.schemaVersion !== 1 || d.policy !== "selected-candidate-context-v1"
    || !text(d.rootEntryId) || !text(d.selectionEntryId) || !text(d.candidateEntryId)
    || !text(d.fromEntryId) || typeof d.targetSnapshotOid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(d.targetSnapshotOid)
    || (d.attemptEntryId !== undefined && !text(d.attemptEntryId))
    || (d.backupEntryId !== undefined && !text(d.backupEntryId))) return;

  if (d.status === "started") {
    if (!text(d.backupEntryId)) return;
  } else if (d.status === "restored") {
    if (!text(d.attemptEntryId) || !text(d.backupEntryId)) return;
  } else if (d.status === "failed") {
    if (typeof d.error !== "string" || !recovery(d.workspaceRecovery) || !recovery(d.contextRecovery)
      || !Array.isArray(d.recoveryErrors) || !d.recoveryErrors.every((error) => typeof error === "string")) return;
  } else return;

  // The union's required fields were validated by status above. Other fields,
  // including backup snapshots, are intentionally outside this display contract.
  return d as unknown as RestorationEvidence;
}
