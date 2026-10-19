import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { trackTurnFiles } from "./track-turn-files";
import { rollUpExplorationStates } from "./exploration-state";
import { selectExploitationStep } from "./select-step";

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
  // TODO: Use pi and ctx to create a stable root entry for this replay run.
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

  await sendPromptAndWaitForSettlement(pi, ctx, prompt, rootEntryId, 1);

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
        // TODO: Restore pre-step context/workspace and continue a new branch.
        continue;
      }
    }

    const navigation = await ctx.navigateTree(rootEntryId, { summarize: false });
    if (navigation.cancelled) {
      throw new Error(`Explore iteration ${i} was cancelled.`);
    }

    // Make a fresh trajectory, including when exploitation has no candidates.
    await sendPromptAndWaitForSettlement(pi, ctx, prompt, rootEntryId, i);
  }
  // TODO: Generate and evaluate one patch per iteration.
  // TODO: Record candidates and return the best result.
  return { requestedPatchCount: n, prompt };
}

/**
 * Sends one replay prompt and waits for that run's final settlement.
 *
 * The listener is registered before sendUserMessage because that method is
 * fire-and-forget: calling ctx.waitForIdle() immediately after it can observe
 * the brief pre-start idle state and return too early.
 */
async function sendPromptAndWaitForSettlement(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prompt: string,
  rootEntryId: string,
  iteration: number,
): Promise<void> {
  const stopTracking = trackTurnFiles(pi, ctx, rootEntryId, iteration);
  let unsubscribe = () => {};
  const settled = new Promise<void>((resolve) => {
    unsubscribe = pi.on("agent_settled", () => {
      resolve();
    });
  });

  try {
    pi.sendUserMessage(prompt);
    await settled;
  } finally {
    unsubscribe();
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
