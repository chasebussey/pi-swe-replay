import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildReplayView, replayRoots, replaySummary } from "../visualization-model";
import { ReplayDashboard, safeDisplay } from "./dashboard";

export async function showReplayView(ctx: ExtensionCommandContext): Promise<void> {
  const entries = ctx.sessionManager.getEntries();
  const roots = replayRoots(entries);
  if (roots.length === 0) {
    ctx.ui.notify("No SWE-Replay runs found in this session.", "info");
    return;
  }
  const activeIds = ctx.sessionManager.getBranch().map((entry) => entry.id);
  const views = roots.map((root) => buildReplayView(entries, root.id, activeIds));
  if (ctx.mode !== "tui") {
    ctx.ui.notify(safeDisplay(views.map(replaySummary).join("\n\n")), "info");
    return;
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const loadMessage = (id: string): string => {
    const entry = byId.get(id);
    if (entry?.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) {
      return "Message unavailable.";
    }
    return entry.message.content.flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      if (block.type === "text" && typeof block.text === "string") return [block.text];
      if (block.type === "thinking" && !block.redacted && typeof block.thinking === "string") return [block.thinking];
      return [];
    }).join("\n\n") || "No visible text or reasoning.";
  };
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ReplayDashboard(
    views, theme, () => tui.requestRender(), () => done(), () => tui.terminal.rows, loadMessage,
  ));
}
