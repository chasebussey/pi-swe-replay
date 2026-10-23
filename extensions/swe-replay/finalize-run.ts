import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { selectFinalPatch, type FinalSelectionDecision } from "./final-selection";
import { normalizeWorkspacePatches } from "./patch-normalization";
import {
  appendReplayRecord, assertReplayComplete, completedSelectionInputs, readReplayArchive,
  type ReplayArchive, type ReplayFinalSelectionRecord, type ReplayIdentityRecord,
} from "./replay-records";
import { restoreWinner, type WinnerRestoration } from "./restore-winner";
import type { ReplayWorkspace } from "./workspace";

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

/** Called only after the requested generation/evaluation loop completes. */
export async function finalizeReplay(
  pi: ExtensionAPI, ctx: ExtensionCommandContext, workspace: ReplayWorkspace, rootEntryId: string,
): Promise<FinalizedReplay> {
  let phase = "archive";
  let selection: FinalSelectionDecision;
  let selectionEntryId: string;
  let archive: ReplayArchive;

  try {
    archive = archiveAt(ctx, rootEntryId);
    const { candidates, base } = archive;
    // Validate completion BEFORE spending normalization work. Identity records do
    // not exist yet; all other associations are already durable across branches.
    assertReplayComplete(archive);

    phase = "normalization";
    ctx.ui.notify("Grouping completed replay patches…", "info");
    const trees = [];
    for (const candidate of candidates) trees.push(await workspace.contentTree(candidate.snapshot));
    const normalized = await normalizeWorkspacePatches(workspace, base.tree, trees, { signal: ctx.signal });
    // Persist only after the entire batch succeeds. Infrastructure errors cannot
    // become partial exact-content votes or a partial-run selection.
    for (const [index, candidate] of candidates.entries()) {
      appendReplayRecord<ReplayIdentityRecord>(pi, ctx, "swe-replay-patch-identity", {
        schemaVersion: 1, rootEntryId, candidateEntryId: candidate.entryId, tree: trees[index],
        normalization: { ...normalized.patches[index], policy: normalized.policy, python: normalized.python },
      });
    }

    phase = "selection";
    archive = archiveAt(ctx, rootEntryId);
    selection = selectFinalPatch(archive.base, completedSelectionInputs(archive), archive.evaluations);
    selectionEntryId = appendReplayRecord<ReplayFinalSelectionRecord>(pi, ctx, "swe-replay-final-selection", {
      schemaVersion: 1, rootEntryId, baseEntryId: archive.baseEntryId,
      candidateEntryIds: archive.candidates.map((c) => c.entryId), identityEntryIds: archive.identities.map((i) => i.entryId),
      evaluationEntryIds: [...archive.baselineEntryIds, ...archive.evaluations.map((e) => e.entryId)], decision: selection,
    });
  } catch (error) {
    appendReplayRecord(pi, ctx, "swe-replay-finalization-error", {
      schemaVersion: 1, rootEntryId, phase, error: String(error).slice(-4000),
    });
    throw error;
  }

  if (selection.status === "no-valid-candidates") return { selectionEntryId, selection };
  const candidate = archive.candidates.find((c) => c.entryId === selection.selectedCandidateEntryId);
  if (!candidate) throw new Error("Selected representative is missing from the completed archive.");
  const restoration = await restoreWinner(pi, ctx, workspace, selectionEntryId, candidate, archive.base.snapshot);
  if (restoration.status === "failed") {
    const recovery = restoration.recoveryErrors.length ? ` Recovery failed: ${restoration.recoveryErrors.join("; ")}` : "";
    throw new Error(`Final patch selected, but restoration failed: ${restoration.error}.${recovery} Inspect swe-replay-restoration and the retained recovery snapshot.`);
  }
  return { selectionEntryId, selection, restoration };
}
