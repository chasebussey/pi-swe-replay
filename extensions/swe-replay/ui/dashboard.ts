import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, SelectItem } from "@earendil-works/pi-tui";
import type { ReplayStepView, ReplayView } from "../visualization-model";

/** Keep untrusted paths/messages from emitting terminal control sequences. */
export function safeDisplay(text: string): string {
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "?");
}
const percent = (value?: number) => value === undefined ? "unavailable" : `${(value * 100).toFixed(2)}%`;

interface Row extends SelectItem { details: string; stepId?: string }

function trajectoryRows(view: ReplayView): Row[] {
  const children = new Map<string | undefined, ReplayStepView[]>();
  for (const step of view.steps) {
    const key = step.parentStepId;
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(step);
  }
  const rows: Row[] = [];
  const pending = (children.get(undefined) ?? []).map((step) => ({ step, depth: 0 })).reverse();
  while (pending.length > 0) {
    const { step, depth } = pending.pop()!;
    rows.push({
      value: step.id, stepId: step.id,
      label: `${"  ".repeat(Math.min(depth, 6))}${depth ? "└─ " : ""}${step.active ? "* " : ""}${step.id} #${step.iterations.join(",") || "?"} f:${step.filesBefore?.length ?? "?"} r:${step.reasoningScore ?? "?"}${step.selectedIn.length ? " ← selected" : ""}`,
      details: [
        `Step ${step.id}`,
        `Iterations: ${step.iterations.join(", ") || "unknown"} · ${step.active ? "active branch" : "archived branch"}`,
        `Parent step: ${step.parentStepId ?? "run root"}`,
        `Reasoning paragraphs (current): ${step.reasoningScore ?? "unavailable"}`,
        `Selected in: ${step.selectedIn.join(", ") || "none"}`,
        `Files BEFORE step (${step.filesBefore?.length ?? "unknown"}):`,
        ...(step.filesBefore ?? ["unavailable"]),
        ...(step.filesBefore?.length === 0 ? ["(empty; excluded from selection)"] : []),
        "", "Press r to reveal message text and visible reasoning.",
      ].join("\n"),
    });
    for (const child of [...(children.get(step.id) ?? [])].reverse()) pending.push({ step: child, depth: depth + 1 });
  }
  return rows;
}

function decisionRows(view: ReplayView): Row[] {
  return view.decisions.map((decision) => ({
    value: decision.id,
    label: `#${decision.iteration ?? "?"} ${decision.outcome}`,
    details: [
      `Decision ${decision.id}`,
      `Iteration: ${decision.iteration ?? "unknown"} · ${decision.outcome}`,
      `Selected step: ${decision.selectedStepId ?? "none recorded"}`,
      `Recorded score: ${decision.recordedScore ?? "unavailable"}`,
      ...(decision.fallbackReason ? [`Fallback: ${decision.fallbackReason}`] : []),
      decision.traceNote,
      "Candidates and multiplicities reflect the archive at selection time.",
      ...decision.states.flatMap((state, index) => {
        const occurrenceCount = state.candidates.reduce((sum, candidate) => sum + candidate.multiplicity, 0);

        return [
          "", `State ${index + 1}${state.selected ? " ← selected" : ""}: ${state.candidates.length} unique candidates · ${occurrenceCount} trajectory occurrences · P(state) ${percent(state.probability)}`,
          ...state.files,
          ...(decision.probabilitySource === "recorded" && !state.selected ? ["Conditional scores/probabilities not evaluated for this state."] : []),
          ...state.candidates.map((candidate) => decision.probabilitySource === "recorded" && !state.selected
            ? `  ${candidate.id} · multiplicity ${candidate.multiplicity}`
            : `${candidate.id === decision.selectedStepId ? "→ " : "  "}${candidate.id}: multiplicity ${candidate.multiplicity} · recorded paragraphs ${candidate.score ?? "?"} · P(step | state) ${percent(candidate.probability)}`),
        ];
      }),
      ...(decision.states.length === 0 ? ["No candidate groups recorded."] : []),
      ...(decision.outcome === "step-selected" ? ["Replacement target selected; this decision does not record generation completion."] : []),
    ].join("\n"),
  }));
}

/** A snapshot inspector: no session navigation, subscriptions, or replay actions. */
export class ReplayDashboard implements Component {
  private tab = 1;
  private runIndex: number;
  private rows: Row[] = [];
  private list?: SelectList;
  private listHeight = 0;
  private detailFocus = false;
  private offset = 0;
  private revealed?: string;

  constructor(
    private views: ReplayView[],
    private theme: Theme,
    private requestRender: () => void,
    private close: () => void,
    private terminalRows: () => number,
    private loadMessage: (stepId: string) => string,
  ) {
    this.runIndex = Math.max(0, views.length - 1);
    for (let index = 0; index < views.length; index++) {
      if (views[index].active) this.runIndex = index;
    }
    this.resetRows();
  }

  private resetRows(): void {
    const view = this.views[this.runIndex];
    this.rows = this.tab === 0 ? this.views.map((run, index) => ({
      value: String(index), label: `${run.active ? "* " : ""}${run.rootEntryId} ${run.timestamp ?? ""}`,
      details: [
        `Replay ${run.rootEntryId}`, `Prompt: ${run.prompt ?? "unknown"}`,
        `Requested iterations: ${run.requestedCount ?? "unknown"}`,
        `${run.steps.length} recorded steps; ${run.decisions.length} decisions`,
        "Enter to inspect this run.", ...run.diagnostics.map((message) => `Warning: ${message}`),
      ].join("\n"),
    })) : !view ? [] : this.tab === 1 ? trajectoryRows(view) : decisionRows(view);
    this.list = undefined;
    this.offset = 0;
    this.revealed = undefined;
    this.detailFocus = false;
  }

  private makeList(height: number): void {
    const selected = this.list?.getSelectedItem()?.value;
    this.listHeight = height;
    this.list = new SelectList(this.rows.map((row) => ({ ...row, label: safeDisplay(row.label).replace(/\n/g, " ") })), height, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("dim", text),
    });
    const index = this.rows.findIndex((row) => row.value === selected);
    this.list.setSelectedIndex(index >= 0 ? index : this.tab === 0 ? this.runIndex : 0);
    this.list.onSelectionChange = () => { this.offset = 0; this.revealed = undefined; };
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.detailFocus && !matchesKey(data, "ctrl+c")) this.detailFocus = false;
      else { this.close(); return; }
    } else if (matchesKey(data, "tab")) {
      this.tab = (this.tab + 1) % 3;
      this.resetRows();
    } else if (matchesKey(data, "enter")) {
      if (this.tab === 0 && this.list?.getSelectedItem()) {
        this.runIndex = Number(this.list.getSelectedItem()!.value);
        this.tab = 1;
        this.resetRows();
      } else this.detailFocus = !this.detailFocus;
    } else if (matchesKey(data, "right")) this.detailFocus = true;
    else if (matchesKey(data, "left")) this.detailFocus = false;
    else if (data === "r" && this.tab === 1) {
      const row = this.rows.find((item) => item.value === this.list?.getSelectedItem()?.value);
      if (row?.stepId) {
        this.revealed = this.revealed === undefined ? this.loadMessage(row.stepId) : undefined;
        this.offset = 0;
      }
    } else if (matchesKey(data, "pageDown")) this.offset += 5;
    else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - 5);
    else if (this.detailFocus && matchesKey(data, "down")) this.offset++;
    else if (this.detailFocus && matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
    else this.list?.handleInput(data);
    this.requestRender();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const height = Math.max(3, Math.min(30, this.terminalRows() - 5));
    const wide = width >= 100;
    const listHeight = wide ? Math.max(1, height - 1) : Math.min(5, Math.max(1, Math.floor(height / 3)));
    if (!this.list || this.listHeight !== listHeight) this.makeList(listHeight);
    const view = this.views[this.runIndex];
    const row = this.rows.find((item) => item.value === this.list?.getSelectedItem()?.value);
    const detail = safeDisplay([
      row?.details ?? "No entries in this view.",
      ...(this.revealed === undefined ? [] : ["", "Message (explicitly revealed):", this.revealed]),
    ].join("\n"));
    const listWidth = wide ? Math.floor(width * 0.4) : width;
    const detailWidth = wide ? width - listWidth - 3 : width;
    const detailHeight = wide ? height : Math.max(1, height - listHeight - 2);
    const detailLines = new Text(detail, 0, 0).render(detailWidth);
    this.offset = Math.min(this.offset, Math.max(0, detailLines.length - detailHeight));
    const visible = detailLines.slice(this.offset, this.offset + detailHeight);
    const listLines = this.list!.render(listWidth).map((line) => truncateToWidth(line, listWidth));
    const body = wide ? Array.from({ length: height }, (_, index) => {
      const left = listLines[index] ?? "";
      return left + " ".repeat(Math.max(0, listWidth - visibleWidth(left))) + " │ " + (visible[index] ?? "");
    }) : [...listLines, this.theme.fg("dim", "─".repeat(width)), ...visible];
    return [
      this.theme.fg("accent", `SWE-Replay · ${view?.rootEntryId ?? "no runs"} · read-only snapshot`),
      ["Runs", "Trajectories", "Decisions"].map((name, index) => index === this.tab ? `[${name}]` : name).join("  "),
      ...body,
      this.theme.fg("dim", `Tab views · ↑↓ ${this.detailFocus ? "details" : "select"} · Enter ${this.tab === 0 ? "open run" : "focus"} · PgUp/PgDn details · r reveal · Esc back/close`),
      this.theme.fg("dim", `${view?.diagnostics.length ?? 0} warnings (Runs view) · * active · f:pre-step files r:paragraphs · completion not recorded; no evaluation`),
    ].map((line) => truncateToWidth(line, width)).slice(0, Math.max(1, this.terminalRows()));
  }

  invalidate(): void { this.list?.invalidate(); }
}
