import type { ReplayProgress, ReplayPhase } from "./run-progress";
import type { ReplayView } from "./visualization-model";

export interface LiveIteration {
  iteration: number;
  approach: "explore" | "exploit" | "fallback";
  targetStepId?: string;
  sourceIteration?: number;
  completed: boolean;
  regression?: "passed" | "failed" | "inconclusive";
}

export interface LiveTool {
  id: string;
  name: string;
  summary: string;
  startedAt: number;
}

export interface LiveReplaySnapshot {
  prompt: string;
  requestedCount: number;
  startedAt: number;
  endedAt?: number;
  rootEntryId?: string;
  status: "running" | "complete" | "failed";
  phase: ReplayPhase;
  iteration: number;
  iterations: readonly LiveIteration[];
  baseline?: "passed" | "failed" | "inconclusive";
  activity: readonly string[];
  tools: readonly LiveTool[];
  waitingForInput: number;
  error?: string;
  /** Captured outcome projection, populated at settlement, never recomputed by rendering. */
  result?: ReplayView;
}

/** Ephemeral liveness only. Historical records never instantiate a running job. */
export class ReplayLiveState {
  private value: LiveReplaySnapshot;
  private listeners = new Set<() => void>();

  constructor(prompt: string, requestedCount: number, now = Date.now()) {
    this.value = {
      prompt, requestedCount, startedAt: now, status: "running", phase: "preparing",
      iteration: 0, iterations: [], activity: [], tools: [], waitingForInput: 0,
    };
  }

  get(): LiveReplaySnapshot { return this.value; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private update(patch: Partial<LiveReplaySnapshot>): void {
    this.value = { ...this.value, ...patch };
    // Presentation errors must not decide replay outcome or prevent other subscribers.
    for (const listener of this.listeners) {
      try { listener(); } catch { /* view owns its errors */ }
    }
  }

  report(event: ReplayProgress): void {
    if (this.value.status !== "running") return;
    switch (event.type) {
      case "root": this.update({ rootEntryId: event.rootEntryId }); break;
      case "phase": this.update({ phase: event.phase }); break;
      case "iteration":
        this.update({
          iteration: event.iteration, tools: [],
          iterations: [...this.value.iterations, { ...event, completed: false }],
        });
        break;
      case "candidate":
        this.update({ iterations: this.value.iterations.map((row) => row.iteration === event.iteration ? { ...row, completed: true } : row) });
        break;
      case "evaluation":
        if (event.iteration === 0) this.update({ baseline: event.status });
        else this.update({ iterations: this.value.iterations.map((row) => row.iteration === event.iteration ? { ...row, regression: event.status } : row) });
        break;
    }
  }

  activity(text: string): void {
    if (this.value.status !== "running") return;
    this.update({ activity: [...this.value.activity.slice(-79), text.slice(0, 1000)] });
  }

  startTool(tool: LiveTool): void {
    this.update({ tools: [...this.value.tools.filter((row) => row.id !== tool.id), tool] });
    this.activity(`${tool.name} · ${tool.summary}`);
  }

  endTool(id: string, failed: boolean): void {
    const tool = this.value.tools.find((row) => row.id === id);
    this.update({ tools: this.value.tools.filter((row) => row.id !== id) });
    if (tool) this.activity(`${failed ? "Tool failed" : "Tool finished"}: ${tool.name} · ${tool.summary}`);
  }

  inputPrompt(delta: 1 | -1): void {
    this.update({ waitingForInput: Math.max(0, this.value.waitingForInput + delta) });
  }

  finish(result?: ReplayView, error?: string): void {
    this.update({ status: error === undefined ? "complete" : "failed", endedAt: Date.now(), tools: [], waitingForInput: 0, result, error });
  }
}
