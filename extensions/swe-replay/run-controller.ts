import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { ReplayLiveState } from "./live-state";
import { runSweReplay } from "./run";
import { buildReplayView } from "./visualization-model";
import { openLiveConsole } from "./ui/live-console";
import { safeDisplay } from "./ui/dashboard";
import { showReplayView } from "./ui/show-view";

function toolSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const fields = args as Record<string, unknown>;
  const value = fields.path ?? fields.command;
  return typeof value === "string" ? value.slice(0, 500) : "";
}

interface ActiveReplay {
  state: ReplayLiveState;
  sessionId: string;
  open(): void;
}

/** One extension runtime owns its background job, guards, and teardown. */
export class ReplayRunController {
  private active?: ActiveReplay;
  private task?: Promise<void>;

  constructor(private pi: ExtensionAPI, private execute: typeof runSweReplay = runSweReplay) {}

  isRunning(): boolean { return this.active !== undefined; }

  /** Useful to hosts/tests; slash-command handlers intentionally do not await this. */
  waitForCompletion(): Promise<void> { return this.task ?? Promise.resolve(); }

  show(ctx: ExtensionCommandContext): boolean {
    if (!this.active || this.active.sessionId !== ctx.sessionManager.getSessionId()) return false;
    this.active.open();
    return true;
  }

  start(ctx: ExtensionCommandContext, n: number, prompt: string, testCommand: string): void {
    if (this.active) throw new Error("A SWE-Replay run is already active.");
    if (!ctx.isIdle()) throw new Error("Wait for the agent to become idle before starting SWE-Replay.");
    const sessionId = ctx.sessionManager.getSessionId();
    const state = new ReplayLiveState(prompt, n);
    const lifetime = new AbortController();
    const cleanup: (() => void)[] = [];
    let valid = true;
    let expectedPrompt: string | undefined;
    let navigationTarget: string | undefined;
    let screen: ReturnType<typeof openLiveConsole> | undefined;
    let inspecting = false;

    const assertActive = () => {
      if (!valid || lifetime.signal.aborted || ctx.sessionManager.getSessionId() !== sessionId) {
        throw new Error("Replay execution invalidated by session shutdown or replacement.");
      }
    };
    const notify = (message: string, kind: "info" | "warning" | "error") => {
      if (!valid) return;
      try { ctx.ui.notify(safeDisplay(message), kind); } catch { /* terminal failure must not change execution */ }
    };
    const inspect = async () => {
      if (inspecting || !valid) return;
      inspecting = true;
      try {
        await showReplayView(ctx);
      } catch (error) {
        notify(`Replay inspection unavailable: ${String(error)}`, "warning");
      } finally {
        inspecting = false;
      }
    };
    const open = () => {
      if (!valid) return;
      if (screen) { screen.reveal(); return; }
      try {
        const current = openLiveConsole(ctx, state, inspect);
        screen = current;
        void current.settled.catch((error) => {
          notify(`Replay console unavailable: ${String(error)}`, "warning");
        }).finally(() => { if (screen === current) screen = undefined; });
      } catch (error) {
        notify(`Replay console unavailable: ${String(error)}`, "warning");
      }
    };

    // Only the controller's explicit calls may inject prompts or navigate while it owns the workspace.
    const runPi = new Proxy(this.pi, {
      get: (target, property, receiver) => {
        if (property === "appendEntry") return (...args: Parameters<ExtensionAPI["appendEntry"]>) => {
          assertActive();
          return target.appendEntry(...args);
        };
        if (property === "sendUserMessage") return (content: Parameters<ExtensionAPI["sendUserMessage"]>[0]) => {
          assertActive();
          if (typeof content !== "string") throw new Error("Replay requires a text prompt.");
          expectedPrompt = content;
          target.sendUserMessage(content);
        };
        if (property === "sendMessage") return (...args: Parameters<ExtensionAPI["sendMessage"]>) => {
          assertActive();
          target.sendMessage(...args);
        };
        return Reflect.get(target, property, receiver);
      },
    });
    const runCtx = new Proxy(ctx, {
      get: (target, property, receiver) => {
        if (property === "signal") return lifetime.signal;
        if (property === "navigateTree") return async (...args: Parameters<ExtensionCommandContext["navigateTree"]>) => {
          assertActive();
          navigationTarget = args[0];
          try {
            const result = await target.navigateTree(...args);
            assertActive();
            return result;
          } finally { navigationTarget = undefined; }
        };
        return Reflect.get(target, property, receiver);
      },
    });

    const blocked = () => {
      notify("SWE-Replay owns this workspace. Wait for it to finish before changing the session or submitting other work.", "warning");
      return { cancel: true };
    };
    // If mounting fails, do not fall back to an unrestricted core editor.
    cleanup.push(ctx.ui.onTerminalInput((data) => {
      if (screen || state.get().waitingForInput > 0) return;
      if (matchesKey(data, "escape") && !ctx.isIdle()) ctx.abort();
      return { consume: true };
    }));
    cleanup.push(this.pi.on("input", (event) => {
      if (event.source === "extension" && expectedPrompt !== undefined && event.text === expectedPrompt) {
        expectedPrompt = undefined;
        return { action: "continue" };
      }
      blocked();
      return { action: "handled" };
    }));
    cleanup.push(this.pi.on("user_bash", () => ({ result: { output: "SWE-Replay owns the workspace; user shell commands are disabled during replay.", exitCode: 1, cancelled: false, truncated: false } })));
    cleanup.push(this.pi.on("session_before_switch", blocked));
    cleanup.push(this.pi.on("session_before_fork", blocked));
    cleanup.push(this.pi.on("session_before_tree", (event) => {
      if (event.preparation.targetId === navigationTarget) { navigationTarget = undefined; return; }
      return blocked();
    }));
    cleanup.push(this.pi.on("session_before_compact", (event) => event.reason === "manual" ? blocked() : undefined));
    cleanup.push(this.pi.on("session_shutdown", async () => {
      valid = false;
      expectedPrompt = undefined;
      navigationTarget = undefined;
      ctx.abort();
      lifetime.abort();
      screen?.close();
      // Do not let a replacement runtime overlap an already-started Git mutation.
      // Disposable evaluation is not cancellable yet; shutdown may wait for its timeout.
      await this.task;
    }));
    cleanup.push(this.pi.on("turn_start", () => { state.report({ type: "phase", phase: "generating" }); state.activity("Waiting for model response"); }));
    cleanup.push(this.pi.on("message_start", (event) => {
      if (event.message.role === "assistant") state.activity("Receiving assistant response");
    }));
    cleanup.push(this.pi.on("tool_execution_start", (event) => {
      state.startTool({ id: event.toolCallId, name: event.toolName, summary: toolSummary(event.args), startedAt: Date.now() });
    }));
    cleanup.push(this.pi.on("tool_execution_end", (event) => state.endTool(event.toolCallId, event.isError)));
    // Pi reports only the outermost UI prompt. Third-party dialogs may be
    // obscured by the full-screen overlay; they are not supported during replay.
    cleanup.push(this.pi.on("ui_prompt_start", (event) => { if (event.kind !== "custom") state.inputPrompt(1); }));
    cleanup.push(this.pi.on("ui_prompt_end", (event) => { if (event.kind !== "custom") state.inputPrompt(-1); }));

    const job: ActiveReplay = { state, sessionId, open };
    this.active = job;
    open();
    this.task = (async () => {
      let failure: string | undefined;
      try {
        await this.execute(runPi, runCtx, n, prompt, testCommand, {
          signal: lifetime.signal, assertActive, report: (event) => state.report(event),
        });
      } catch (error) {
        failure = String(error);
      } finally {
        for (const stop of cleanup.splice(0)) stop();
        expectedPrompt = undefined;
        navigationTarget = undefined;
      }

      if (valid) {
        const root = state.get().rootEntryId;
        let result;
        try {
          if (root) result = buildReplayView(ctx.sessionManager.getEntries(), root, ctx.sessionManager.getBranch().map((entry) => entry.id));
        } catch { /* incomplete evidence is unavailable, not reconstructed */ }
        state.finish(result, failure);
        const headline = result?.overview.headline ?? "Captured outcome unavailable; inspect session evidence.";
        notify(failure ? `SWE-Replay failed: ${failure} ${headline}` : `SWE-Replay: ${headline} Regression passing is not proof of task correctness.`, failure ? "error" : "info");
      }
      if (this.active === job) this.active = undefined;
    })();
  }
}
