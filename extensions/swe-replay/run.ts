import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { trackTurnFiles } from "./track-turn-files";
import { rollUpExplorationStates } from "./exploration-state";
import { selectExploitationStep } from "./select-step";
import { ReplayWorkspace, preStepSnapshot, type WorkspaceSnapshot } from "./workspace";
import { eligibleStepIds, evaluateSnapshot, EVALUATION_TIMEOUT_MS } from "./evaluation";
import { finalizeReplay, type FinalizedReplay } from "./finalize-run";
import { appendReplayRecord, type ReplayBaseRecord, type ReplayCandidateRecord, type ReplayEvaluationRecord } from "./replay-records";

interface SweReplayRequest {
  n: number;
  prompt: string;
}

interface SweReplayRun extends FinalizedReplay {
  requestedPatchCount: number;
  prompt: string;
}

const activeRuns = new WeakSet<object>();

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
  testCommand: string,
): Promise<SweReplayRun> {
  if (!Number.isSafeInteger(n) || n <= 0 || !prompt.trim()) throw new Error("A positive iteration count and prompt are required.");
  if (!testCommand.trim()) throw new Error("A regression test command is required.");
  if (activeRuns.has(ctx.sessionManager)) throw new Error("A SWE-Replay run is already active in this session.");
  if (!ctx.isIdle()) throw new Error("Wait for the agent to become idle before starting SWE-Replay.");

  activeRuns.add(ctx.sessionManager);
  try {
    return await executeReplay(pi, ctx, n, prompt, testCommand);
  } finally {
    activeRuns.delete(ctx.sessionManager);
  }
}

async function executeReplay(
  pi: ExtensionAPI, ctx: ExtensionCommandContext, n: number, prompt: string, testCommand: string,
): Promise<SweReplayRun> {
  const workspace = await ReplayWorkspace.open(ctx.cwd);
  const rootEntryId = appendReplayRecord(pi, ctx, "swe-replay-root", {
    schemaVersion: 1, prompt, requestedPatchCount: n, testCommand, testTimeoutMs: EVALUATION_TIMEOUT_MS, cwd: ctx.cwd,
  });

  const initial = await workspace.capture(rootEntryId, rootEntryId);
  pi.appendEntry("swe-replay-workspace", initial);
  const baseTree = await workspace.contentTree(initial);
  appendReplayRecord<ReplayBaseRecord>(pi, ctx, "swe-replay-base", {
    schemaVersion: 1, rootEntryId, requestedCount: n, testCommand, testTimeoutMs: EVALUATION_TIMEOUT_MS,
    cwd: ctx.cwd, baseTreeOid: baseTree.treeOid, snapshot: initial, tree: baseTree,
  });

  const restore = async (snapshot: WorkspaceSnapshot) => {
    // Retain a recovery snapshot before replacing any current files.
    const backup = await workspace.capture(rootEntryId, ctx.sessionManager.getLeafEntry()?.id ?? rootEntryId);
    pi.appendEntry("swe-replay-workspace-backup", backup);
    await workspace.restore(snapshot);
  };

  const passedTerminals: string[] = [];
  const evaluate = async (iteration: number, snapshot?: WorkspaceSnapshot) => {
    const terminal = ctx.sessionManager.getLeafEntry();
    if (!terminal) throw new Error("No terminal entry to evaluate.");
    const candidate = snapshot ?? await workspace.capture(rootEntryId, terminal.id);
    if (ctx.sessionManager.getLeafEntry()?.id !== terminal.id) throw new Error("Session changed while capturing a completed candidate.");
    // Persist the snapshot association BEFORE testing, so interruption cannot
    // strand it as an otherwise unassociated OID in evaluation evidence.
    const candidateEntryId = iteration > 0 ? appendReplayRecord<ReplayCandidateRecord>(pi, ctx, "swe-replay-candidate", {
      schemaVersion: 1, rootEntryId, iteration, terminalEntryId: terminal.id, snapshot: candidate,
    }) : undefined;
    const label = iteration === 0 ? "baseline" : `iteration ${iteration}`;
    ctx.ui.notify(`Running regression validation: ${label}…`, "info");
    const result = await evaluateSnapshot(pi, workspace, candidate, ctx.cwd, testCommand, iteration, terminal.id);
    appendReplayRecord<ReplayEvaluationRecord>(pi, ctx, "swe-replay-evaluation", {
      ...result, schemaVersion: 1, candidateEntryId, testCommand, testTimeoutMs: EVALUATION_TIMEOUT_MS, cwd: ctx.cwd,
    });
    ctx.ui.notify(`Regression validation ${label}: ${result.status}`, result.status === "passed" ? "info" : "warning");
    if (result.status === "inconclusive" || (iteration === 0 && result.status !== "passed")) {
      throw new Error(`Regression ${iteration === 0 ? "baseline" : `evaluation for iteration ${iteration}`} ${result.status}. Inspect swe-replay-evaluation for details.`);
    }
    if (iteration > 0 && result.status === "passed") passedTerminals.push(terminal.id);
  };

  await evaluate(0, initial);
  await startReplayAndWaitForSettlement(pi, ctx, () => pi.sendUserMessage(prompt), rootEntryId, 1, workspace);
  await evaluate(1);

  for (let i = 2; i <= n; i++) {
    const explore = Math.random() < 0.5;

    if (!explore) {
      const entries = ctx.sessionManager.getEntries();
      const states = rollUpExplorationStates(entries, rootEntryId, eligibleStepIds(entries, rootEntryId, passedTerminals));
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
        await evaluate(i);
        continue;
      }
    }

    const navigation = await ctx.navigateTree(rootEntryId, { summarize: false });
    if (navigation.cancelled) {
      throw new Error(`Explore iteration ${i} was cancelled.`);
    }
    if (ctx.sessionManager.getLeafEntry()?.id !== rootEntryId) {
      throw new Error(`Navigation did not reach the replay root for iteration ${i}.`);
    }

    await restore(initial);
    // Reattach the root state on this branch so its first step has a snapshot ancestor.
    pi.appendEntry("swe-replay-workspace", initial);
    // Make a fresh trajectory, including when exploitation has no candidates.
    await startReplayAndWaitForSettlement(pi, ctx, () => pi.sendUserMessage(prompt), rootEntryId, i, workspace);
    await evaluate(i);
  }
  const final = await finalizeReplay(pi, ctx, workspace, rootEntryId);
  return { requestedPatchCount: n, prompt, ...final };
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
  let aborted = false;
  const settled = new Promise<void>((resolve) => {
    unsubscribe = pi.on("agent_settled", (event) => {
      aborted = event.aborted;
      resolve();
    });
  });

  try {
    startRun();
    await settled;
    // Settlement, not the brief pre-start idle state, is the completion boundary.
    await ctx.waitForIdle();
    if (snapshotError) throw snapshotError;
    if (aborted) throw new Error(`Replay iteration ${iteration} was aborted; no final selection was made.`);
    const lastAssistant = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1);
    if (lastAssistant?.type === "message" && lastAssistant.message.role === "assistant"
      && ["error", "aborted", "pending", "deferred"].includes(lastAssistant.message.stopReason)) {
      throw new Error(`Replay iteration ${iteration} did not complete successfully (${lastAssistant.message.stopReason}).`);
    }
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
