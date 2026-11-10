import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { selectFinalPatch, type FinalSelectionDecision } from "./final-selection";
import { normalizeWorkspacePatches, normalizedPatchIdentity, type WorkspaceNormalizationOptions } from "./patch-normalization";
import { capturePatchNormalization, parsePatchNormalization } from "./normalization-records";
import { normalizationProvenanceFrame, sameNormalizationContract } from "./normalization-policy";
import { snapshotNormalization, sameNormalizationExecution } from "./normalization-contract";
import { TscWorkspaceResourceError } from "./tsc-workspace-limits";
import type { TscPatchNormalizationOptions } from "./tsc-patch-normalization";
import {
  appendReplayRecord, assertReplayComplete, assertModernReplayArchive, completedSelectionInputs, readReplayArchive,
  type ReplayArchive, type ReplayFinalSelectionRecord, type ReplayIdentityPayloadV2,
} from "./replay-records";
import { restoreWinner, type WinnerRestoration } from "./restore-winner";
import { guardedReplayExecution, type ReplayExecution } from "./run-progress";
import type { ReplayWorkspace, WorkspaceContentTree } from "./workspace";

export interface FinalizedReplay {
  selectionEntryId: string;
  selection: FinalSelectionDecision;
  restoration?: Exclude<WinnerRestoration, { status: "started" }>;
}

function archiveAt(ctx: ExtensionCommandContext, rootEntryId: string): ReplayArchive {
  const result = readReplayArchive(ctx.sessionManager.getEntries(), rootEntryId);
  if (result.status !== "available") {
    throw new Error(`Final selection unavailable: ${result.diagnostics.map((d) => `${d.code} (${d.entryId})`).join(", ")}`);
  }
  return result.archive;
}

export interface FinalizationOptions {
  execution?: ReplayExecution;
  /** Host/cache settings only; captured execution and policy never come from here. */
  grammar?: TscPatchNormalizationOptions["grammar"];
}

/** Called only after the requested generation/evaluation loop completes. */
export async function finalizeReplay(
  pi: ExtensionAPI, ctx: ExtensionCommandContext, workspace: ReplayWorkspace, rootEntryId: string,
  options: FinalizationOptions = {},
): Promise<FinalizedReplay> {
  const execution = guardedReplayExecution(options.execution, ctx.signal);
  let phase = "archive";
  let selection: FinalSelectionDecision;
  let selectionEntryId: string;
  let archive: ReplayArchive;

  try {
    execution.assertActive();
    archive = archiveAt(ctx, rootEntryId);
    const { candidates, base } = archive;
    // Validate completion BEFORE spending normalization work. Identity records do
    // not exist yet; all other associations are already durable across branches.
    assertReplayComplete(archive);
    assertModernReplayArchive(archive);
    if (archive.identities.length) throw new Error("Replay identities already exist; captured runs cannot be automatically regrouped.");
    const frozenNormalization = snapshotNormalization(archive.base);
    const { normalizationContract, normalizationExecution } = frozenNormalization;
    if (normalizationExecution.backend === "tsc" && candidates.length > normalizationExecution.workspaceLimits.maxCandidates) {
      throw new TscWorkspaceResourceError("maxCandidates", candidates.length, normalizationExecution.workspaceLimits.maxCandidates);
    }

    phase = "normalization";
    execution.report({ type: "phase", phase: "normalizing" });
    ctx.ui.notify("Grouping completed replay patches…", "info");
    const trees: WorkspaceContentTree[] = [];
    for (const candidate of candidates) {
      execution.assertActive();
      trees.push(await workspace.contentTree(candidate.snapshot));
    }
    execution.assertActive();
    const normalizationOptions: WorkspaceNormalizationOptions = normalizationExecution.backend === "agentless"
      ? { backend: "agentless", timeoutMs: normalizationExecution.timeoutMs, signal: execution.signal ?? ctx.signal }
      : { backend: "tsc", timeoutMs: normalizationExecution.timeoutMs, signal: execution.signal ?? ctx.signal,
          limits: normalizationExecution.sourceLimits, workspaceLimits: normalizationExecution.workspaceLimits, grammar: options.grammar };
    const normalized = await normalizeWorkspacePatches(workspace, base.tree, trees, normalizationOptions);
    execution.assertActive();
    if (normalized.patches.length !== candidates.length) throw new Error("Incomplete normalization batch.");
    // Construct every payload before the first append. Never persist partial worker
    // results or declare a decision after a failed batch/append/archive validation.
    const identities: ReplayIdentityPayloadV2[] = candidates.map((candidate, index) => ({
      schemaVersion: 2, rootEntryId, candidateEntryId: candidate.entryId, tree: trees[index],
      normalization: capturePatchNormalization(normalizedPatchIdentity(normalized, index)),
    }));
    const expectedProvenance = JSON.stringify(normalizationProvenanceFrame(normalizationContract.provenance));
    for (const identity of identities) {
      const parsed = parsePatchNormalization(identity.normalization, 2);
      if (!parsed || JSON.stringify(normalizationProvenanceFrame(parsed)) !== expectedProvenance) {
        throw new Error("Normalization batch does not match the frozen run contract.");
      }
    }
    for (const identity of identities) {
      execution.assertActive();
      appendReplayRecord(pi, ctx, "swe-replay-patch-identity", identity);
    }

    phase = "selection";
    execution.report({ type: "phase", phase: "voting" });
    execution.assertActive();
    archive = archiveAt(ctx, rootEntryId);
    assertModernReplayArchive(archive);
    if (!sameNormalizationContract(normalizationContract, archive.base.normalizationContract)
      || !sameNormalizationExecution(normalizationExecution, archive.base.normalizationExecution)) {
      throw new Error("Frozen normalization contract/execution changed during finalization.");
    }
    selection = selectFinalPatch(archive.base, completedSelectionInputs(archive), archive.evaluations);
    execution.assertActive();
    selectionEntryId = appendReplayRecord<ReplayFinalSelectionRecord>(pi, ctx, "swe-replay-final-selection", {
      schemaVersion: 2, rootEntryId, baseEntryId: archive.baseEntryId,
      normalizationContract: archive.base.normalizationContract,
      candidateEntryIds: archive.candidates.map((c) => c.entryId), identityEntryIds: archive.identities.map((i) => i.entryId),
      evaluationEntryIds: [...archive.baselineEntryIds, ...archive.evaluations.map((e) => e.entryId)], decision: selection,
    });
  } catch (error) {
    execution.assertActive();
    appendReplayRecord(pi, ctx, "swe-replay-finalization-error", {
      schemaVersion: 1, rootEntryId, phase, error: String(error).slice(-4000),
    });
    throw error;
  }

  if (selection.status === "no-valid-candidates") return { selectionEntryId, selection };
  const candidate = archive.candidates.find((c) => c.entryId === selection.selectedCandidateEntryId);
  if (!candidate) throw new Error("Selected representative is missing from the completed archive.");
  execution.assertActive();
  execution.report({ type: "phase", phase: "restoring-winner" });
  const restoration = await restoreWinner(pi, ctx, workspace, selectionEntryId, candidate, archive.base.snapshot, execution);
  if (restoration.status === "failed") {
    const recovery = restoration.recoveryErrors.length ? ` Recovery failed: ${restoration.recoveryErrors.join("; ")}` : "";
    throw new Error(`Final patch selected, but restoration failed: ${restoration.error}.${recovery} Inspect swe-replay-restoration and the retained recovery snapshot.`);
  }
  return { selectionEntryId, selection, restoration };
}
