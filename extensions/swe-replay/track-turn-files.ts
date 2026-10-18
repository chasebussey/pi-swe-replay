import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface TurnFilesEntry {
  rootEntryId: string;
  iteration: number;
  turnIndex: number;
  messageEntryId: string;
  files: string[];
}

/** Persist cumulative successful file-tool accesses along the active replay branch. */
export function trackTurnFiles(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rootEntryId: string,
  iteration: number,
): () => void {
  const files = new Set<string>();

  // Only inherit this replay run's latest snapshot on the active path.
  // Returning to the root therefore starts empty; sibling branches do not leak in.
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.id === rootEntryId) break;
    if (entry.type !== "custom" || entry.customType !== "swe-replay-turn-files") continue;

    const data = entry.data as Partial<TurnFilesEntry> | undefined;
    if (data?.rootEntryId !== rootEntryId || !Array.isArray(data.files)) continue;

    for (const file of data.files) {
      if (typeof file === "string") files.add(file);
    }
    break;
  }

  const unsubscribeResult = pi.on("tool_result", (event, ctx) => {
    if (event.isError || !["read", "write", "edit"].includes(event.toolName)) {
      return;
    }

    const path = event.input.path;
    if (typeof path === "string") {
      // Absolute paths deduplicate relative and absolute references to the same file.
      files.add(resolve(ctx.cwd, path));
    }
  });

  const unsubscribeEnd = pi.on("turn_end", (event) => {
    pi.appendEntry<TurnFilesEntry>("swe-replay-turn-files", {
      rootEntryId,
      iteration,
      turnIndex: event.turnIndex,
      messageEntryId: event.messageEntryId,
      files: [...files].sort(),
    });
  });

  return () => {
    unsubscribeResult();
    unsubscribeEnd();
  };
}
