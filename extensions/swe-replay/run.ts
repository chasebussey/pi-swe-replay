import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { trackTurnFiles } from "./track-turn-files";
import { rollUpExplorationStates } from "./exploration-state";
import { selectExploitationStep } from "./select-step";
import { ReplayWorkspace, preStepSnapshot, type WorkspaceSnapshot } from "./workspace";

interface SweReplayRequest {
  n: number;
  prompt: string;
}

interface SweReplayRun {
  requestedPatchCount: number;
  prompt: string;
}

/**
 * The algorithm's main entry point.
 *
 * Keep this function focused on the replay algorithm. Pi and the command context
 * are injected by the slash-command handler in extensions/index.ts.
 *
 * State restoration model: create one Git stash snapshot after each completed
 * turn, map its immutable OID to that turn's session-entry ID, and restore the
 * selected snapshot before an explore or exploit iteration. This keeps replay
 * state step-oriented without creating commits or worktrees per trajectory.
 */
export async function runSweReplay(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  n: number,
  prompt: string,
): Promise<SweReplayRun> {
  const workspace = await ReplayWorkspace.open(ctx.cwd);
  pi.appendEntry(
    "swe-replay-root",
    {
    }
  );

  const rootEntry = ctx.sessionManager.getLeafEntry();

  if (!rootEntry) {
    throw new Error("Root entry was not created.");
  }

  const rootEntryId = rootEntry.id;

  const initial = await workspace.capture(rootEntryId, rootEntryId);
  pi.appendEntry("swe-replay-workspace", initial);

  const restore = async (snapshot: WorkspaceSnapshot) => {
    // Retain a recovery snapshot before replacing any current files.
    const backup = await workspace.capture(rootEntryId, ctx.sessionManager.getLeafEntry()?.id ?? rootEntryId);
    pi.appendEntry("swe-replay-workspace-backup", backup);
    await workspace.restore(snapshot);
  };

  await startReplayAndWaitForSettlement(pi, ctx, () => pi.sendUserMessage(prompt), rootEntryId, 1, workspace);

  for (let i = 2; i <= n; i++) {
    const explore = Math.random() < 0.5;

    if (!explore) {
      const states = rollUpExplorationStates(ctx.sessionManager.getEntries(), rootEntryId);
      const selection = selectExploitationStep(states, ctx.sessionManager);
      pi.appendEntry("swe-replay-exploit-log", {
        rootEntryId,
        iteration: i,
        states,
        selection: selection ? {
          state: selection.state, stepId: selection.stepId, reasoningScore: selection.reasoningScore,
        } : null,
        trace: selection?.trace ?? null,
        fallbackReason: selection ? undefined : "no-eligible-states",
      });
      if (selection) {
        const snapshot = preStepSnapshot(ctx.sessionManager.getEntries(), rootEntryId, selection.stepId);
        const step = ctx.sessionManager.getEntry(selection.stepId);
        if (!step?.parentId) {
          throw new Error(`No pre-step context for ${selection.stepId}.`);
        }
        // Navigate to the selected assistant's parent, not the previous assistant:
        // the intervening tool results and tracking snapshots belong in the context.
        const navigation = await ctx.navigateTree(step.parentId, { summarize: false });
        if (navigation.cancelled) {
          throw new Error(`Exploit iteration ${i} was cancelled.`);
        }
        // Pi navigates BEFORE user/custom messages, unlike other entry types.
        // Do not restore files if navigation did not reach the requested boundary.
        if (ctx.sessionManager.getLeafEntry()?.id !== step.parentId) {
          throw new Error(`Navigation did not reach the pre-step context for ${selection.stepId}.`);
        }
        await restore(snapshot);
        await startReplayAndWaitForSettlement(pi, ctx, () => {
          // This starts a run without adding a textual instruction. Pi still sends
          // an empty user-role message; provider acceptance needs a live smoke test.
          pi.sendMessage({
            customType: "swe-replay-continue",
            content: "",
            display: false,
          }, { triggerTurn: true });
        }, rootEntryId, i, workspace);
        continue;
      }
    }

    const navigation = await ctx.navigateTree(rootEntryId, { summarize: false });
    if (navigation.cancelled) {
      throw new Error(`Explore iteration ${i} was cancelled.`);
    }

    await restore(initial);
    // Reattach the root state on this branch so its first step has a snapshot ancestor.
    pi.appendEntry("swe-replay-workspace", initial);
    // Make a fresh trajectory, including when exploitation has no candidates.
    await startReplayAndWaitForSettlement(pi, ctx, () => pi.sendUserMessage(prompt), rootEntryId, i, workspace);
  }
  // TODO: Generate and evaluate one patch per iteration.
  // TODO: Record candidates and return the best result.
  return { requestedPatchCount: n, prompt };
}

/**
 * Starts an exploration or exploitation run and waits for its final settlement.
 *
 * Listeners are registered before triggering either fire-and-forget message API:
 * calling ctx.waitForIdle() immediately afterward can observe the brief pre-start
 * idle state and return too early.
 */
async function startReplayAndWaitForSettlement(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  startRun: () => void,
  rootEntryId: string,
  iteration: number,
  workspace: ReplayWorkspace,
): Promise<void> {
  const stopTracking = trackTurnFiles(pi, ctx, rootEntryId, iteration);
  const stopBoundaries = pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    // Pi navigates before user/custom messages. A non-context anchor after the
    // trigger lets later exploitation retain that message when replacing this step.
    pi.appendEntry("swe-replay-step-boundary", { rootEntryId, iteration });
  });
  let snapshotError: unknown;
  const stopSnapshots = pi.on("turn_end", async (event) => {
    try {
      const snapshot = await workspace.capture(rootEntryId, event.messageEntryId);
      pi.appendEntry("swe-replay-workspace", snapshot);
    } catch (error) {
      // Pi reports handler exceptions but may continue. Abort and propagate at settlement.
      snapshotError = error;
      ctx.abort();
    }
  });
  let unsubscribe = () => {};
  const settled = new Promise<void>((resolve) => {
    unsubscribe = pi.on("agent_settled", () => {
      resolve();
    });
  });

  try {
    startRun();
    await settled;
    if (snapshotError) throw snapshotError;
  } finally {
    unsubscribe();
    stopSnapshots();
    stopBoundaries();
    stopTracking();
  }
}

export function parseSweReplayRequest(args: string): SweReplayRequest | undefined {
  const [nText, ...promptParts] = args.trim().split(/\s+/);
  const n = Number(nText);
  const prompt = promptParts.join(" ").trim();

  if (!Number.isSafeInteger(n) || n <= 0 || !prompt) {
    return undefined;
  }

  return { n, prompt };
}
