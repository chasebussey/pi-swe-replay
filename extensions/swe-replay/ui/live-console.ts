import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { ReplayLiveState, type LiveIteration, type LiveReplaySnapshot } from "../live-state";
import { safeDisplay } from "./dashboard";

const line = (text: string) => safeDisplay(text).replace(/\n/g, " ");
const elapsed = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export function liveStatus(state: LiveReplaySnapshot): string {
  if (state.status !== "running") return state.status.toUpperCase();
  if (state.waitingForInput) return "AWAITING INPUT";
  return state.phase.replace(/-/g, " ").toUpperCase();
}

function iterationLabel(row: LiveIteration): string {
  const origin = row.targetStepId ? ` ← ${row.sourceIteration ? `#${row.sourceIteration} ` : ""}before ${row.targetStepId}` : "";
  const status = row.regression?.toUpperCase() ?? (row.completed ? "awaiting regression" : "in progress");
  return `#${row.iteration} ${row.approach}${origin} · ${status}`;
}

/** This component owns display only. Compact mode deliberately does not expose the core editor. */
export class ReplayLiveConsole implements Component {
  private compact = false;
  private follow = true;
  private selectedIteration?: number;
  private unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(
    private state: ReplayLiveState,
    private theme: Theme,
    private keys: KeybindingsManager,
    private requestRender: () => void,
    private close: () => void,
    private rows: () => number,
    private inspect: () => void,
    private interruptAgent: () => void,
  ) {
    this.unsubscribe = state.subscribe(() => {
      if (this.compact && state.get().status !== "running") this.close();
      else this.requestRender();
    });
    this.timer = setInterval(() => {
      if (state.get().status === "running") this.requestRender();
    }, 1000);
  }

  reveal(): void {
    this.compact = false;
    this.requestRender();
  }

  handleInput(data: string): void {
    const state = this.state.get();
    if (this.keys.matches(data, "app.interrupt")) {
      if (state.status !== "running") this.close();
      else if (this.compact) this.interruptAgent();
      else { this.compact = true; this.requestRender(); }
      return;
    }
    if (this.compact) {
      if (data === "v") { this.compact = false; this.requestRender(); }
      else if (data === "d") this.inspect();
      return;
    }
    if (data === "a" && state.status === "running") this.interruptAgent();
    else if (data === "d") this.inspect();
    else if (data === "f") { this.follow = true; this.selectedIteration = undefined; }
    else if (this.keys.matches(data, "tui.select.confirm") && state.status !== "running") { this.close(); return; }
    else if (this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.select.down")) {
      const current = this.selectedIteration ?? state.iteration;
      const direction = this.keys.matches(data, "tui.select.up") ? -1 : 1;
      this.selectedIteration = Math.max(1, Math.min(state.iterations.length, current + direction));
      this.follow = false;
    }
    this.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const state = this.state.get();
    const height = Math.max(1, this.rows() - 5);
    const duration = elapsed((state.endedAt ?? Date.now()) - state.startedAt);
    const status = liveStatus(state);
    if (this.compact) {
      return [
        `SWE-Replay · ${state.iteration}/${state.requestedCount} · ${status} · ${duration}`,
        "Transcript inspection only · v reopen · d recorded details · Esc interrupt agent",
      ].slice(0, height).map((text) => truncateToWidth(line(text), width));
    }

    const completed = state.iterations.filter((row) => row.completed).length;
    const passed = state.iterations.filter((row) => row.regression === "passed").length;
    const failed = state.iterations.filter((row) => row.regression === "failed").length;
    const inconclusive = state.iterations.filter((row) => row.regression === "inconclusive").length;
    const representative = state.result?.overview.iterations.find((row) => row.representative)?.iteration;
    const selected = this.follow ? representative ?? state.iteration : this.selectedIteration;
    const row = state.iterations.find((item) => item.iteration === selected);
    const header = [
      this.theme.fg("accent", `SWE-REPLAY · ${status} · ${duration}`),
      line(state.prompt),
      `Completed ${completed}/${state.requestedCount} · baseline ${state.baseline ?? "pending"} · regression ${passed} passed / ${failed} failed / ${inconclusive} inconclusive`,
      state.status !== "running" ? `Captured outcome${representative ? ` · selected iteration #${representative}` : ""}`
        : this.follow ? `Following live · iteration ${state.iteration || "—"}` : `Inspecting #${selected} · live: #${state.iteration} ${status}`,
    ];
    const details = this.details(state, row);
    const footer = state.status === "running"
      ? "↑↓ inspect · f follow · d recorded details · Esc hide · a interrupt agent"
      : "Enter / Esc return to chat · d captured outcome details";
    const available = Math.max(0, height - header.length - 1);
    const selectedIndex = Math.max(0, state.iterations.findIndex((item) => item.iteration === selected));
    const start = Math.max(0, selectedIndex - Math.floor(Math.max(1, available - 2) / 2));
    const iterations = state.iterations.slice(start).map((item) => `${item.iteration === selected ? "> " : "  "}${item.iteration === representative ? "★ " : ""}${iterationLabel(item)}`);
    const left = ["ITERATIONS", ...iterations];
    const right = ["CURRENT ACTIVITY / OUTCOME", ...details];
    const body: string[] = [];

    if (width >= 110) {
      const leftWidth = Math.floor(width * 0.45);
      for (let index = 0; index < available; index++) {
        const leftLine = truncateToWidth(line(left[index] ?? ""), leftWidth - 2);
        body.push(`${leftLine}${" ".repeat(Math.max(0, leftWidth - visibleWidth(leftLine)))}│ ${line(right[index] ?? "")}`);
      }
    } else {
      // Short/narrow layouts favor current activity; the selected iteration remains explicit.
      body.push(...[...(row ? [iterationLabel(row)] : []), ...right].map(line));
    }
    return [...header, ...body.slice(0, available), footer].slice(0, height)
      .map((text) => truncateToWidth(text, width));
  }

  private details(state: LiveReplaySnapshot, row?: LiveIteration): string[] {
    if (state.status !== "running") {
      const overview = state.result?.overview;
      return [
        ...(state.error ? [`Execution failed: ${state.error}`] : []),
        overview?.headline ?? "Captured outcome unavailable; inspect session evidence.",
        ...(overview?.groups.map((group) => `${group.label}: ${group.votes} votes · representative #${group.representativeIteration}${group.selected ? " · selected" : ""}`) ?? []),
        ...(overview?.notes ?? []),
        "Regression passing is not proof of task correctness.",
      ];
    }
    if (!this.follow && row) {
      return [iterationLabel(row), row.targetStepId ? `Replaced step: ${row.targetStepId}` : "Started from replay root.",
        "d opens captured trajectories, decisions and regression evidence.", "Live activity continues without moving your selection."];
    }
    return [
      state.waitingForInput ? "Awaiting an extension dialog; answer it above this console." : `Phase: ${liveStatus(state)}`,
      ...state.tools.slice(0, 5).map((tool) => `${tool.name} ${tool.summary} · ${elapsed(Date.now() - tool.startedAt)}`),
      ...(state.tools.length > 5 ? [`+ ${state.tools.length - 5} other active tools`] : []),
      "Recent activity", ...state.activity.slice(-8).reverse(),
    ];
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.unsubscribe();
  }
}

export function openLiveConsole(ctx: ExtensionCommandContext, state: ReplayLiveState, inspect: () => void): { close(): void; reveal(): void; settled: Promise<void> } {
  let done: (() => void) | undefined;
  let closed = false;
  let component: ReplayLiveConsole | undefined;
  const close = () => {
    closed = true;
    done?.();
  };
  const settled = ctx.ui.custom<void>((tui, theme, keys, finish) => {
    done = () => finish();
    component = new ReplayLiveConsole(state, theme, keys, () => tui.requestRender(), close, () => tui.terminal.rows, inspect, () => {
      if (!ctx.isIdle()) ctx.abort();
      else state.activity("No active agent turn to interrupt. Evaluation/finalization is not cancelled by this action.");
    });
    if (closed) { component.dispose(); finish(); }
    return component;
  });
  return { close, reveal: () => component?.reveal(), settled };
}
