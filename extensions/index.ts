import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseSweReplayRequest, runSweReplay } from "./swe-replay/run";
import { showReplayView } from "./swe-replay/ui/show-view";

/** SWE-Replay commands and read-only inspection. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("swe-replay", {
    description: "Generate, validate, select and restore a replay patch (usage: /swe-replay <n> <prompt>)",
    handler: async (args, ctx) => {
      const request = parseSweReplayRequest(args);

      if (!request) {
        ctx.ui.notify("Usage: /swe-replay <positive number of patches> <prompt>", "error");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("SWE-Replay currently requires UI input for its regression test command.", "error");
        return;
      }
      const testCommand = await ctx.ui.input("Regression test command", "e.g. npm ci && npm test");
      if (!testCommand?.trim()) {
        ctx.ui.notify("Replay cancelled: a regression test command is required.", "info");
        return;
      }
      const run = await runSweReplay(pi, ctx, request.n, request.prompt, testCommand.trim());
      if (run.selection.status === "no-valid-candidates") {
        ctx.ui.notify(
          `SWE-Replay completed ${run.requestedPatchCount} iteration(s): no regression-passing, nonempty patch qualified. Workspace and conversation remain at the last iteration.`,
          "warning",
        );
        return;
      }
      const winner = run.selection.groups[0];
      const tie = run.selection.tiedGroupKeyHashes.length > 1 ? " Tie resolved by earliest passing iteration." : "";
      ctx.ui.notify(
        `Selected iteration ${winner.representativeIteration}: ${winner.votes} of ${run.selection.eligibleCount} eligible votes across ${run.requestedPatchCount} completed iterations.${tie} Workspace and conversation restored to the selected representative; regression passing is not proof of task correctness.`,
        "info",
      );
    },
  });

  pi.registerCommand("swe-replay-view", {
    description: "Inspect replay trajectories and selection decisions (read-only)",
    handler: async (_args, ctx) => showReplayView(ctx),
  });

  pi.registerCommand("inspect-session", {
    description: "Show persisted SWE-Replay session entries",
    handler: async (_args, ctx) => {
      const sweReplayEntries = ctx.sessionManager.getBranch().filter(
        (entry) =>
          entry.type.startsWith("swe-replay") ||
          (entry.type === "custom" && entry.customType.startsWith("swe-replay")),
      );

      if (sweReplayEntries.length === 0) {
        ctx.ui.notify("No SWE-Replay session entries found.", "info");
        return;
      }

      ctx.ui.notify(JSON.stringify(sweReplayEntries, null, 2), "info");
    },
  });
}
