import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { ReplayLiveState, type LiveActivity, type LiveIteration, type LiveReplaySnapshot } from "../live-state";
import { safeDisplay } from "./dashboard";
import { buildIterationLineage, type IterationLineage } from "./iteration-lineage";
import { layoutSearchShape, renderSearchShape, type SearchShape } from "./search-shape";

const line = (text: string) => safeDisplay(text).replace(/\n/g, " ");
const elapsed = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

type ActivityTone = "normal" | "accent" | "success" | "warning" | "error" | "muted";
interface ActivityRow { text: string; tone: ActivityTone }

const activityRow = (text: string, tone: ActivityTone = "normal"): ActivityRow => ({ text, tone });
const activityTones: Record<LiveActivity["kind"], ActivityTone> = {
  info: "normal", "tool-started": "accent", "tool-succeeded": "success", "tool-failed": "error",
};

function regressionTone(status: LiveIteration["regression"]): ActivityTone {
  switch (status) {
    case "passed": return "success";
    case "failed": return "error";
    case "inconclusive": return "warning";
    default: return "normal";
  }
}

export function liveStatus(state: LiveReplaySnapshot): string {
  if (state.status !== "running") return state.status.toUpperCase();
  if (state.waitingForInput) return "AWAITING INPUT";
  return state.phase.replace(/-/g, " ").toUpperCase();
}

function iterationLabel(row: LiveIteration, compact = false): string {
  let origin = "";
  if (row.approach === "exploit") {
    const source = row.sourceIteration ? `#${row.sourceIteration}` : "origin unavailable";
    origin = compact ? ` ← ${source}` : ` ← ${source} before ${row.targetStepId ?? "unknown step"}`;
  }
  const status = row.regression?.toUpperCase() ?? (row.completed ? "awaiting regression" : "in progress");
  return `#${row.iteration} ${row.approach} · ${status}${origin}`;
}

/** This component owns display only. Compact mode deliberately does not expose the core editor. */
export class ReplayLiveConsole implements Component {
  private compact = false;
  private follow = true;
  private selectedIteration?: number;
  private unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval>;
  private disposed = false;
  private lineageIterations?: readonly LiveIteration[];
  private lineage?: IterationLineage;
  private graph?: { signature: string; shape: SearchShape };

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
      const rows = this.getLineage(state).rows;
      if (rows.length === 0) return;
      const representative = state.result?.overview.iterations.find((row) => row.representative)?.iteration;
      const current = this.follow ? representative ?? state.iteration : this.selectedIteration;
      const index = Math.max(0, rows.findIndex((row) => row.node.iteration === current));
      const direction = this.keys.matches(data, "tui.select.up") ? -1 : 1;
      const next = Math.max(0, Math.min(rows.length - 1, index + direction));
      this.selectedIteration = rows[next].node.iteration;
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
    const lineage = this.getLineage(state);
    const selectedIndex = Math.max(0, lineage.rows.findIndex((item) => item.node.iteration === selected));
    const lineageHeight = width >= 110 ? available : available >= 10 ? Math.min(7, Math.floor(available * 0.45)) : 0;
    const visibleRows = Math.max(0, lineageHeight - 2);
    const centeredStart = selectedIndex - Math.floor(Math.max(0, visibleRows - 1) / 2);
    const start = Math.max(0, Math.min(centeredStart, lineage.rows.length - visibleRows));
    const byIteration = new Map(state.iterations.map((item) => [item.iteration, item]));
    const iterations = lineage.rows.slice(start, start + visibleRows).map(({ node, prefix }) => {
      const marker = `${node.iteration === selected ? "> " : "  "}${node.iteration === representative ? "★ " : ""}`;
      return `${marker}${prefix}${iterationLabel(byIteration.get(node.iteration)!, true)}`;
    });
    const left = ["ITERATION LINEAGE", `◆ Replay root${start ? ` · ↑ ${start} above` : ""}`, ...iterations];
    // Sanitize raw content before adding trusted theme escapes, never afterwards.
    const right = [activityRow("CURRENT ACTIVITY / OUTCOME"), ...details].map(({ text, tone }) => {
      const sanitized = line(text);
      return tone === "normal" ? sanitized : this.theme.fg(tone, sanitized);
    });
    const body: string[] = [];

    if (width >= 110) {
      const leftWidth = Math.floor(width * 0.45);
      const rightWidth = width - leftWidth - 2;
      let rightPane = right;
      if (available >= 14 && rightWidth >= 32) {
        // Split evenly around the divider; the lower pane includes its heading.
        const activityHeight = Math.floor((available - 1) / 2);
        const graphHeight = available - activityHeight - 2;
        const shape = this.getShape(lineage, rightWidth, graphHeight);
        const activity = Array.from({ length: activityHeight }, (_, index) => right[index] ?? "");
        const graph = renderSearchShape(shape, lineage, {
          selectedIteration: selected,
          activeIteration: state.status === "running" ? state.iteration : undefined,
          representativeIteration: representative,
          pulse: state.status === "running" && Math.floor(Date.now() / 1000) % 2 === 0,
        }, (tone, text) => this.theme.fg(tone, text));
        rightPane = [...activity, "─".repeat(rightWidth), `SEARCH SHAPE${shape.bundled ? " · bundled" : ""}`, ...graph];
      }
      for (let index = 0; index < available; index++) {
        const leftLine = truncateToWidth(line(left[index] ?? ""), leftWidth - 2);
        body.push(`${leftLine}${" ".repeat(Math.max(0, leftWidth - visibleWidth(leftLine)))}│ ${rightPane[index] ?? ""}`);
      }
    } else {
      // Stack the tree above activity on narrow screens; omit the decorative graph first.
      if (lineageHeight > 0) body.push(...left.slice(0, lineageHeight).map(line), "─".repeat(width), ...right);
      else body.push(...(row ? [line(iterationLabel(row))] : []), ...right);
    }
    return [...header, ...body.slice(0, available), footer].slice(0, height)
      .map((text) => truncateToWidth(text, width));
  }

  private getLineage(state: LiveReplaySnapshot): IterationLineage {
    if (!this.lineage || this.lineageIterations !== state.iterations) {
      this.lineage = buildIterationLineage(state.iterations);
      this.lineageIterations = state.iterations;
    }
    return this.lineage;
  }

  private getShape(lineage: IterationLineage, width: number, height: number): SearchShape {
    const cached = this.graph;
    if (!cached || cached.signature !== lineage.signature || cached.shape.width !== width || cached.shape.height !== height) {
      this.graph = { signature: lineage.signature, shape: layoutSearchShape(lineage, width, height) };
    }
    return this.graph!.shape;
  }

  private details(state: LiveReplaySnapshot, row?: LiveIteration): ActivityRow[] {
    if (state.status !== "running") {
      const overview = state.result?.overview;
      return [
        ...(state.error ? [activityRow(`Execution failed: ${state.error}`, "error")] : []),
        activityRow(overview?.headline ?? "Captured outcome unavailable; inspect session evidence."),
        ...(overview?.groups.map((group) => activityRow(`${group.label}: ${group.votes} votes · representative #${group.representativeIteration}${group.selected ? " · selected" : ""}`)) ?? []),
        ...(overview?.notes.map((note) => activityRow(note)) ?? []),
        activityRow("Regression passing is not proof of task correctness.", "muted"),
      ];
    }
    if (!this.follow && row) {
      return [
        activityRow(iterationLabel(row), regressionTone(row.regression)),
        activityRow(row.approach === "exploit" ? `Replaced step: ${row.targetStepId ?? "unavailable"}` : "Started from replay root."),
        activityRow("d opens captured trajectories, decisions and regression evidence.", "muted"),
        activityRow("Live activity continues without moving your selection.", "muted"),
      ];
    }
    return [
      state.waitingForInput
        ? activityRow("Awaiting an extension dialog; answer it above this console.", "warning")
        : activityRow(`Phase: ${liveStatus(state)}`, "accent"),
      ...state.tools.slice(0, 5).map((tool) => activityRow(`${tool.name} ${tool.summary} · ${elapsed(Date.now() - tool.startedAt)}`, "accent")),
      ...(state.tools.length > 5 ? [activityRow(`+ ${state.tools.length - 5} other active tools`)] : []),
      activityRow("Recent activity"),
      ...state.activity.slice(-8).reverse().map((entry) => activityRow(entry.text, activityTones[entry.kind])),
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
