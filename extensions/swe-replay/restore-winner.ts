import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { appendReplayRecord, type ReplayCandidateRecord } from "./replay-records";
import type { ReplayWorkspace, WorkspaceSnapshot } from "./workspace";

interface RestorationAssociation {
  schemaVersion: 1;
  rootEntryId: string;
  selectionEntryId: string;
  candidateEntryId: string;
  targetSnapshotOid: string;
  fromEntryId: string;
  policy: "selected-candidate-context-v1";
}

export type WinnerRestoration = RestorationAssociation & (
  | { status: "started"; backupEntryId: string; backup: WorkspaceSnapshot }
  | { status: "restored"; attemptEntryId: string; backupEntryId: string }
  | { status: "failed"; attemptEntryId?: string; backupEntryId?: string; backup?: WorkspaceSnapshot; error: string;
      workspaceRecovery: "not-needed" | "restored" | "failed";
      contextRecovery: "not-needed" | "restored" | "failed";
      recoveryErrors: string[] }
);

/** Selection is already durable. Navigation and Git restoration can fail independently. */
export async function restoreWinner(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  workspace: ReplayWorkspace,
  selectionEntryId: string,
  candidate: ReplayCandidateRecord & { entryId: string },
  initial: WorkspaceSnapshot,
): Promise<Exclude<WinnerRestoration, { status: "started" }>> {
  const fromEntry = ctx.sessionManager.getLeafEntry();
  if (!fromEntry) throw new Error("No session position to back up before winner restoration.");
  const association: RestorationAssociation = {
    schemaVersion: 1, rootEntryId: candidate.rootEntryId, selectionEntryId,
    candidateEntryId: candidate.entryId, targetSnapshotOid: candidate.snapshot.oid,
    fromEntryId: fromEntry.id, policy: "selected-candidate-context-v1",
  };
  let backup: WorkspaceSnapshot | undefined;
  let backupEntryId: string | undefined;
  let attemptEntryId: string | undefined;
  let mutated = false;

  try {
    backup = await workspace.capture(candidate.rootEntryId, fromEntry.id);
    if (!ctx.isIdle() || ctx.sessionManager.getLeafEntry()?.id !== fromEntry.id) {
      throw new Error("Session changed while capturing the winner-restoration backup.");
    }
    backupEntryId = appendReplayRecord(pi, ctx, "swe-replay-workspace-backup", backup);
    attemptEntryId = appendReplayRecord<WinnerRestoration>(pi, ctx, "swe-replay-restoration", {
      ...association, status: "started", backupEntryId, backup,
    });

    await workspace.assertHeadUnchanged(initial);
    // A custom ENTRY is a post-trajectory anchor; unlike custom/user messages,
    // Pi navigates AT it, preserving every completed assistant/tool/context entry.
    const target = ctx.sessionManager.getEntry(candidate.entryId);
    if (target?.type !== "custom" || target.customType !== "swe-replay-candidate"
      || target.parentId !== candidate.terminalEntryId) throw new Error("Winner context anchor is unavailable.");
    const navigation = await ctx.navigateTree(candidate.entryId, { summarize: false });
    if (navigation.cancelled) throw new Error("Winner conversation navigation was cancelled.");
    if (ctx.sessionManager.getLeafEntry()?.id !== candidate.entryId) {
      throw new Error("Winner conversation navigation did not reach the candidate anchor.");
    }

    // A candidate captured after an agent-created commit must not authorize a
    // different HEAD than the frozen run base, even if its own HEAD still matches.
    await workspace.assertHeadUnchanged(initial);
    await workspace.restore(candidate.snapshot, () => {
      if (!ctx.isIdle() || ctx.sessionManager.getLeafEntry()?.id !== candidate.entryId) {
        throw new Error("Session changed before winner file restoration.");
      }
      mutated = true;
    });
    appendReplayRecord(pi, ctx, "swe-replay-workspace", candidate.snapshot);
    const result: WinnerRestoration = { ...association, status: "restored", attemptEntryId, backupEntryId };
    appendReplayRecord(pi, ctx, "swe-replay-restoration", result);
    return result;
  } catch (error) {
    // Best effort recovery of BOTH halves; never label a partially applied winner
    // as restored. The started record retains recovery identity if Pi exits here.
    let workspaceRecovery: "not-needed" | "restored" | "failed" = "not-needed";
    let contextRecovery: "not-needed" | "restored" | "failed" = "not-needed";
    const recoveryErrors: string[] = [];
    if (mutated && backup) {
      try {
        await workspace.restore(backup);
        workspaceRecovery = "restored";
      } catch (recoveryError) {
        workspaceRecovery = "failed";
        recoveryErrors.push(`Workspace: ${String(recoveryError).slice(-2000)}`);
      }
    }
    if (!ctx.sessionManager.getBranch().some((entry) => entry.id === fromEntry.id)) {
      try {
        const navigation = await ctx.navigateTree(fromEntry.id, { summarize: false });
        if (navigation.cancelled || ctx.sessionManager.getLeafEntry()?.id !== fromEntry.id) {
          throw new Error("Could not return to the pre-restoration conversation.");
        }
        contextRecovery = "restored";
      } catch (recoveryError) {
        contextRecovery = "failed";
        recoveryErrors.push(`Conversation: ${String(recoveryError).slice(-2000)}`);
      }
    }
    const result: WinnerRestoration = {
      ...association, status: "failed", attemptEntryId, backupEntryId, backup, error: String(error).slice(-4000),
      workspaceRecovery, contextRecovery, recoveryErrors,
    };
    appendReplayRecord(pi, ctx, "swe-replay-restoration", result);
    return result;
  }
}
