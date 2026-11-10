import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseSweReplayRequest, runSweReplay } from "./swe-replay/run";
import { ReplayRunController } from "./swe-replay/run-controller";
import { showReplayView } from "./swe-replay/ui/show-view";
import { resolveNormalization } from "./swe-replay/normalization-contract";

/** SWE-Replay commands and read-only inspection. */
export default function (pi: ExtensionAPI) {
  const controller = new ReplayRunController(pi);
  let preparingOrRunningDirect = false;

  pi.registerCommand("swe-replay", {
    description: "Generate, validate, select and restore a replay patch (usage: /swe-replay <n> <prompt>)",
    handler: async (args, ctx) => {
      const request = parseSweReplayRequest(args);

      if (!request) {
        ctx.ui.notify("Usage: /swe-replay <positive number of iterations> <prompt>", "error");
        return;
      }

      if (preparingOrRunningDirect || controller.isRunning()) {
        ctx.ui.notify("A SWE-Replay run is already active.", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the agent to become idle before starting SWE-Replay.", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("SWE-Replay requires UI input for patch equivalence and its regression test command.", "error");
        return;
      }
      preparingOrRunningDirect = true;
      try {
        const choices = [
          "TSC (default): .py/.ts syntax + added-helper heuristic; other files exact",
          "Agentless: Python heuristic; other files exact",
        ];
        const choice = await ctx.ui.select("Patch equivalence (heuristics, not proof of correctness)", choices);
        const backend = choice === choices[0] ? "tsc" : choice === choices[1] ? "agentless" : undefined;
        if (!backend) {
          ctx.ui.notify("Replay cancelled: no supported patch-equivalence choice selected.", "info");
          return;
        }

        const testCommand = await ctx.ui.input("Regression test command", "e.g. npm ci && npm test");
        if (!testCommand?.trim()) {
          ctx.ui.notify("Replay cancelled: a regression test command is required.", "info");
          return;
        }

        // Dialogs yield to Pi; recheck readiness before any controller/run mutation.
        if (controller.isRunning() || !ctx.isIdle()) {
          ctx.ui.notify("Replay cancelled: another run became active while gathering input.", "warning");
          return;
        }
        const normalization = resolveNormalization(backend);
        if (ctx.mode === "tui") {
          controller.start(ctx, request.n, request.prompt, testCommand.trim(), normalization);
          return;
        }

        const run = await runSweReplay(pi, ctx, request.n, request.prompt, testCommand.trim(), normalization);
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
      } finally {
        preparingOrRunningDirect = false;
      }
    },
  });

  pi.registerCommand("swe-replay-view", {
    description: "Inspect replay trajectories and selection decisions (read-only)",
    handler: async (_args, ctx) => {
      if (!controller.show(ctx)) await showReplayView(ctx);
    },
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
