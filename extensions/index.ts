import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseSweReplayRequest, runSweReplay } from "./swe-replay/run";

/** A minimal project extension that adds the /greet command. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("swe-replay", {
    description: "Generate n candidate patches for a task (usage: /swe-replay <n> <prompt>)",
    handler: async (args, ctx) => {
      const request = parseSweReplayRequest(args);

      if (!request) {
        ctx.ui.notify("Usage: /swe-replay <positive number of patches> <prompt>", "error");
        return;
      }

      const run = await runSweReplay(pi, ctx, request.n, request.prompt);
      ctx.ui.notify(
        `SWE-Replay scaffold started for ${run.requestedPatchCount} patch(es): ${run.prompt}`,
        "info",
      );
    },
  });

  pi.registerCommand("greet", {
    description: "Show a greeting (optionally provide a name)",
    handler: async (args, ctx) => {
      const name = args.trim() || "world";
      ctx.ui.notify(`Hello, ${name}!`, "info");
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
