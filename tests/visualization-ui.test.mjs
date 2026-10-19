import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";
import { archive, root } from "./fixtures/replay.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { buildReplayView } = await jiti.import("../extensions/swe-replay/visualization-model.ts");
const { ReplayDashboard, safeDisplay } = await jiti.import("../extensions/swe-replay/ui/dashboard.ts");
const { showReplayView } = await jiti.import("../extensions/swe-replay/ui/show-view.ts");
const { default: extension } = await jiti.import("../extensions/index.ts");
const theme = { fg: (_token, text) => text };

function dashboard() {
  const entries = archive();
  const views = [buildReplayView(entries, "root", ["root", "b1", "b2"])];
  let closed = false;
  let renders = 0;
  let reveals = 0;
  let height = 24;
  const component = new ReplayDashboard(
    views, theme, () => renders++, () => { closed = true; }, () => height,
    () => { reveals++; return "SECRET reasoning\n".repeat(40); },
  );
  return { component, closed: () => closed, renders: () => renders, reveals: () => reveals, resize: (rows) => { height = rows; } };
}

test("dashboard supports selection, views, detail paging, opt-in reveal, and close", () => {
  const h = dashboard();
  assert.match(h.component.render(120).join("\n"), /\[Trajectories\]/);
  assert.equal(h.reveals(), 0);
  h.component.handleInput("\x1b[B"); // down to a2
  assert.match(h.component.render(120).join("\n"), /Step a2/);
  h.component.handleInput("r");
  assert.equal(h.reveals(), 1);
  assert.match(h.component.render(120).join("\n"), /SECRET/);
  h.component.handleInput("r");
  assert.ok(!h.component.render(120).join("\n").includes("SECRET"));
  h.component.handleInput("\t");
  assert.match(h.component.render(120).join("\n"), /\[Decisions\]/);
  assert.match(h.component.render(120).join("\n"), /recorded at selection time/);
  h.component.handleInput("\x1b[6~"); // PageDown
  assert.ok(h.renders() > 0);
  h.component.handleInput("\t");
  assert.match(h.component.render(120).join("\n"), /\[Runs\]/);
  h.component.handleInput("\r");
  assert.match(h.component.render(120).join("\n"), /\[Trajectories\]/);
  h.component.handleInput("\r"); // focus details
  h.component.handleInput("\x1b"); // back, not close
  assert.equal(h.closed(), false);
  h.component.handleInput("\x1b");
  assert.equal(h.closed(), true);
});

test("layout fits narrow/wide widths, resize, Unicode paths, and theme invalidation", () => {
  const h = dashboard();
  for (const height of [4, 8, 12, 24, 50]) {
    h.resize(height);
    for (const width of [1, 12, 40, 99, 100, 160]) {
      const lines = h.component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.length <= height, `${lines.length} lines for height ${height}`);
    }
  }
  const entries = archive();
  entries[0].data.prompt = "工程 🦀 e\u0301";
  const view = buildReplayView(entries, "root");
  view.steps[0].filesBefore = ["/repo/工程/🦀.ts"];
  const component = new ReplayDashboard([view], theme, () => {}, () => {}, () => 24, () => "");
  assert.ok(component.render(40).every((line) => visibleWidth(line) <= 40));
  component.invalidate();
  assert.ok(component.render(100).every((line) => visibleWidth(line) <= 100));
  assert.deepEqual(component.render(0), []);
  assert.ok(!safeDisplay("\x1b[31munsafe\x07\x9b").includes("\x1b"));
});

test("run picker changes runs, scrolling reaches later steps, and resizing preserves selection", () => {
  const first = buildReplayView(archive(), "root", ["root"]);
  const second = { ...buildReplayView([root("second")], "second"), steps: Array.from({ length: 30 }, (_, index) => ({
    id: `step-${index}`, iterations: [1], filesBefore: [], reasoningScore: 0, active: false, selectedIn: [],
  })) };
  let height = 16;
  const component = new ReplayDashboard([first, second], theme, () => {}, () => {}, () => height, () => "");
  component.render(80);
  component.handleInput("\t"); component.render(80);
  component.handleInput("\t"); component.render(80);
  component.handleInput("\x1b[B");
  component.handleInput("\r");
  assert.match(component.render(80).join("\n"), /second/);
  for (let index = 0; index < 20; index++) component.handleInput("\x1b[B");
  assert.match(component.render(120).join("\n"), /Step step-20/);
  height = 30;
  assert.match(component.render(120).join("\n"), /Step step-20/);
});

test("empty dashboard tabs do not crash", () => {
  const component = new ReplayDashboard([buildReplayView([root()], "root")], theme, () => {}, () => {}, () => 20, () => "");
  for (let index = 0; index < 4; index++) {
    assert.ok(component.render(60).length > 0);
    component.handleInput("\t");
    component.handleInput("r");
  }
});

function context(mode, entries = archive()) {
  const notices = [];
  let customs = 0;
  const ctx = {
    mode,
    sessionManager: { getEntries: () => entries, getBranch: () => entries.filter((entry) => ["root", "b1", "b2"].includes(entry.id)) },
    ui: {
      notify: (message) => notices.push(message),
      custom: async (factory) => {
        customs++;
        const component = factory({ requestRender() {}, terminal: { rows: 24 } }, theme, {}, () => {});
        assert.ok(component.render(100).length > 0);
        component.handleInput("\x1b");
      },
    },
    navigateTree: () => { throw new Error("must not navigate"); },
  };
  return { ctx, notices, customs: () => customs };
}

test("command registers and inspecting in every mode does not write or sample", async (t) => {
  t.mock.method(Math, "random", () => { throw new Error("must not sample"); });
  const commands = new Map();
  extension({ registerCommand: (name, command) => commands.set(name, command) });
  assert.ok(commands.has("swe-replay-view"));
  for (const mode of ["tui", "rpc", "print", "json"]) {
    const h = context(mode);
    const before = structuredClone(h.ctx.sessionManager.getEntries());
    await commands.get("swe-replay-view").handler("", h.ctx);
    assert.deepEqual(h.ctx.sessionManager.getEntries(), before);
    assert.equal(h.customs(), mode === "tui" ? 1 : 0);
    if (mode !== "tui") {
      assert.match(h.notices[0], /selected-only/);
      assert.ok(!h.notices[0].includes("Private reasoning"));
    }
  }
  const empty = context("tui", []);
  await showReplayView(empty.ctx);
  assert.equal(empty.customs(), 0);
  assert.match(empty.notices[0], /No SWE-Replay runs/);
});
