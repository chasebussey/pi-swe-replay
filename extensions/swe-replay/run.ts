import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { guardedReplayExecution, type ReplayExecution } from "./run-progress";
import { trackTurnFiles, type TurnFilesEntry } from "./track-turn-files";
import { rollUpExplorationStates } from "./exploration-state";
import { selectExploitationStep } from "./select-step";
import { ReplayWorkspace, preStepSnapshot, type WorkspaceSnapshot } from "./workspace";
import { eligibleStepIds, evaluateSnapshot, EVALUATION_TIMEOUT_MS } from "./evaluation";
import { finalizeReplay, type FinalizedReplay } from "./finalize-run";
import { appendReplayRecord, type ReplayBaseRecord, type ReplayCandidateRecord, type ReplayEvaluationRecord, type ReplayRootRecordV2 } from "./replay-records";
import { snapshotNormalization, type ResolvedNormalization } from "./normalization-contract";
import { TscWorkspaceResourceError } from "./tsc-workspace-limits";
import type { FinalizationOptions } from "./finalize-run";

export interface SweReplayRunOptions extends ResolvedNormalization, FinalizationOptions {}

interface SweReplayRequest {
  n: number;
  prompt: string;
}

export interface SweReplayRun extends FinalizedReplay {
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
  options: SweReplayRunOptions,
): Promise<SweReplayRun> {
  if (!Number.isSafeInteger(n) || n <= 0 || !prompt.trim()) throw new Error("A positive iteration count and prompt are required.");
  if (!testCommand.trim()) throw new Error("A regression test command is required.");
  if (activeRuns.has(ctx.sessionManager)) throw new Error("A SWE-Replay run is already active in this session.");
  if (!ctx.isIdle()) throw new Error("Wait for the agent to become idle before starting SWE-Replay.");

  const normalization = snapshotNormalization(options);
  const limits = normalization.normalizationExecution;
  if (limits.backend === "tsc" && n > limits.workspaceLimits.maxCandidates) {
    throw new TscWorkspaceResourceError("maxCandidates", n, limits.workspaceLimits.maxCandidates);
  }
  const execution = guardedReplayExecution(options.execution, ctx.signal);
  const resolved: SweReplayRunOptions = { ...normalization, execution, grammar: { ...options.grammar } };

  activeRuns.add(ctx.sessionManager);
  try {
    execution.assertActive();
    return await executeReplay(pi, ctx, n, prompt, testCommand, resolved, execution);
  } finally {
    activeRuns.delete(ctx.sessionManager);
  }
}

async function executeReplay(
  pi: ExtensionAPI, ctx: ExtensionCommandContext, n: number, prompt: string, testCommand: string,
  options: SweReplayRunOptions, execution: ReplayExecution,
): Promise<SweReplayRun> {
  const { report, assertActive } = execution;
  report({ type: "phase", phase: "preparing" });
  const workspace = await ReplayWorkspace.open(ctx.cwd);
  assertActive();
  const { normalizationContract, normalizationExecution } = options;
  const rootEntryId = appendReplayRecord<ReplayRootRecordV2>(pi, ctx, "swe-replay-root", {
    schemaVersion: 2, prompt, requestedPatchCount: n, testCommand, testTimeoutMs: EVALUATION_TIMEOUT_MS, cwd: ctx.cwd,
    normalizationContract, normalizationExecution,
  });

  report({ type: "root", rootEntryId });
  const initial = await workspace.capture(rootEntryId, rootEntryId);
  assertActive();
  pi.appendEntry("swe-replay-workspace", initial);
  const baseTree = await workspace.contentTree(initial);
  assertActive();
  appendReplayRecord<ReplayBaseRecord>(pi, ctx, "swe-replay-base", {
    schemaVersion: 2, rootEntryId, requestedCount: n, testCommand, testTimeoutMs: EVALUATION_TIMEOUT_MS,
    cwd: ctx.cwd, baseTreeOid: baseTree.treeOid, snapshot: initial, tree: baseTree, normalizationContract, normalizationExecution,
  });

  const restore = async (snapshot: WorkspaceSnapshot) => {
    assertActive();
    report({ type: "phase", phase: "restoring" });
    // Retain a recovery snapshot before replacing any current files.
    const backup = await workspace.capture(rootEntryId, ctx.sessionManager.getLeafEntry()?.id ?? rootEntryId);
    assertActive();
    pi.appendEntry("swe-replay-workspace-backup", backup);
    await workspace.restore(snapshot, assertActive);
    assertActive();
  };

  const passedTerminals: string[] = [];
  const evaluate = async (iteration: number, snapshot?: WorkspaceSnapshot) => {
    assertActive();
    report({ type: "phase", phase: iteration === 0 ? "baseline" : "capturing" });
    const terminal = ctx.sessionManager.getLeafEntry();
    if (!terminal) throw new Error("No terminal entry to evaluate.");
    const candidate = snapshot ?? await workspace.capture(rootEntryId, terminal.id);
    assertActive();
    if (ctx.sessionManager.getLeafEntry()?.id !== terminal.id) throw new Error("Session changed while capturing a completed candidate.");
    // Persist the snapshot association BEFORE testing, so interruption cannot
    // strand it as an otherwise unassociated OID in evaluation evidence.
    const candidateEntryId = iteration > 0 ? appendReplayRecord<ReplayCandidateRecord>(pi, ctx, "swe-replay-candidate", {
      schemaVersion: 1, rootEntryId, iteration, terminalEntryId: terminal.id, snapshot: candidate,
    }) : undefined;
    if (iteration > 0) report({ type: "candidate", iteration });
    report({ type: "phase", phase: iteration === 0 ? "baseline" : "evaluating" });
    const label = iteration === 0 ? "baseline" : `iteration ${iteration}`;
    ctx.ui.notify(`Running regression validation: ${label}…`, "info");
    const result = await evaluateSnapshot(pi, workspace, candidate, ctx.cwd, testCommand, iteration, terminal.id);
    assertActive();
    appendReplayRecord<ReplayEvaluationRecord>(pi, ctx, "swe-replay-evaluation", {
      ...result, schemaVersion: 1, candidateEntryId, testCommand, testTimeoutMs: EVALUATION_TIMEOUT_MS, cwd: ctx.cwd,
    });
    report({ type: "evaluation", iteration, status: result.status });
    ctx.ui.notify(`Regression validation ${label}: ${result.status}`, result.status === "passed" ? "info" : "warning");
    if (result.status === "inconclusive" || (iteration === 0 && result.status !== "passed")) {
      throw new Error(`Regression ${iteration === 0 ? "baseline" : `evaluation for iteration ${iteration}`} ${result.status}. Inspect swe-replay-evaluation for details.`);
    }
    if (iteration > 0 && result.status === "passed") passedTerminals.push(terminal.id);
  };

  await evaluate(0, initial);
  report({ type: "iteration", iteration: 1, approach: "explore" });
  await startReplayAndWaitForSettlement(pi, ctx, () => pi.sendUserMessage(prompt), rootEntryId, 1, workspace, execution);
  await evaluate(1);

  for (let i = 2; i <= n; i++) {
    assertActive();
    report({ type: "phase", phase: "choosing" });
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
        const origin = entries.flatMap((entry) => entry.type === "custom" && entry.customType === "swe-replay-turn-files"
          ? [entry.data as Partial<TurnFilesEntry> | undefined] : [])
          .find((data) => data?.rootEntryId === rootEntryId && data?.messageEntryId === selection.stepId);
        const sourceIteration = origin && Number.isSafeInteger(origin.iteration) ? origin.iteration : undefined;
        report({ type: "iteration", iteration: i, approach: "exploit", targetStepId: selection.stepId, sourceIteration });
        report({ type: "phase", phase: "navigating" });
        // Navigate to the selected assistant's parent, not the previous assistant:
        // the intervening tool results and tracking snapshots belong in the context.
        const navigation = await ctx.navigateTree(step.parentId, { summarize: false });
        assertActive();
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
        }, rootEntryId, i, workspace, execution);
        await evaluate(i);
        continue;
      }
    }

    report({ type: "iteration", iteration: i, approach: explore ? "explore" : "fallback" });
    report({ type: "phase", phase: "navigating" });
    const navigation = await ctx.navigateTree(rootEntryId, { summarize: false });
    assertActive();
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
    await startReplayAndWaitForSettlement(pi, ctx, () => pi.sendUserMessage(prompt), rootEntryId, i, workspace, execution);
    await evaluate(i);
  }
  assertActive();
  const final = await finalizeReplay(pi, ctx, workspace, rootEntryId, { execution, grammar: options.grammar });
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
  execution: ReplayExecution,
): Promise<void> {
  execution.assertActive();
  execution.report({ type: "phase", phase: "generating" });
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
      execution.assertActive();
      execution.report({ type: "phase", phase: "capturing" });
      const snapshot = await workspace.capture(rootEntryId, event.messageEntryId);
      execution.assertActive();
      pi.appendEntry("swe-replay-workspace", snapshot);
    } catch (error) {
      // Pi reports handler exceptions but may continue. Abort and propagate at settlement.
      snapshotError = error;
      ctx.abort();
    }
  });
  let unsubscribe = () => {};
  let aborted = false;
  let invalidate = () => {};
  const settled = new Promise<void>((resolve, reject) => {
    invalidate = () => reject(new Error("Replay execution invalidated by session shutdown or reload."));
    execution.signal?.addEventListener("abort", invalidate, { once: true });
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
    execution.assertActive();
    if (snapshotError) throw snapshotError;
    if (aborted) throw new Error(`Replay iteration ${iteration} was aborted; no final selection was made.`);
    const lastAssistant = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1);
    if (lastAssistant?.type === "message" && lastAssistant.message.role === "assistant"
      && ["error", "aborted", "pending", "deferred"].includes(lastAssistant.message.stopReason)) {
      throw new Error(`Replay iteration ${iteration} did not complete successfully (${lastAssistant.message.stopReason}).`);
    }
  } finally {
    execution.signal?.removeEventListener("abort", invalidate);
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
