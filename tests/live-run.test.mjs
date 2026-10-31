import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { ReplayLiveState } = await jiti.import("../extensions/swe-replay/live-state.ts");
const { ReplayLiveConsole } = await jiti.import("../extensions/swe-replay/ui/live-console.ts");
const { ReplayRunController } = await jiti.import("../extensions/swe-replay/run-controller.ts");
const theme = { fg: (_token, text) => text };
const bindings = {
  "app.interrupt": "\x1b", "tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B", "tui.select.confirm": "\r",
};
const keys = { matches: (data, action) => data === bindings[action] };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function iteration(state, number, approach = "explore") {
  state.report({ type: "iteration", iteration: number, approach });
}

function consoleHarness(state, t) {
  let height = 30;
  let closed = 0;
  let inspected = 0;
  let interrupted = 0;
  const component = new ReplayLiveConsole(state, theme, keys, () => {}, () => { closed++; }, () => height,
    () => { inspected++; }, () => { interrupted++; });
  t.after(() => component.dispose());
  return { component, resize: (value) => { height = value; }, closed: () => closed, inspected: () => inspected, interrupted: () => interrupted };
}

test("live state separates capture from regression and bounds activity without leaking output", () => {
  const state = new ReplayLiveState("task", 2);
  iteration(state, 1);
  assert.equal(state.get().iterations[0].completed, false);
  state.report({ type: "candidate", iteration: 1 });
  assert.equal(state.get().iterations[0].completed, true);
  assert.equal(state.get().iterations[0].regression, undefined);
  state.report({ type: "evaluation", iteration: 1, status: "passed" });
  state.report({ type: "evaluation", iteration: 0, status: "passed" });
  assert.equal(state.get().baseline, "passed");
  assert.equal(state.get().iterations[0].regression, "passed");
  for (let i = 0; i < 200; i++) state.activity(`event ${i}`);
  assert.equal(state.get().activity.length, 80);
  assert.equal(state.get().activity.at(-1), "event 199");

  state.startTool({ id: "1", name: "read", summary: "a", startedAt: 0 });
  state.startTool({ id: "2", name: "bash", summary: "test", startedAt: 0 });
  assert.equal(state.get().tools.length, 2);
  state.endTool("1", false);
  assert.deepEqual(state.get().tools.map((tool) => tool.id), ["2"]);
  state.endTool("2", true);
  assert.match(state.get().activity.at(-1), /Tool failed/);
  assert.equal(state.get().tools.length, 0);
});

test("subscriber errors cannot determine execution outcome and unsubscribe is idempotent", () => {
  const state = new ReplayLiveState("task", 1);
  state.subscribe(() => { throw new Error("broken view"); });
  let notified = 0;
  const stop = state.subscribe(() => notified++);
  state.activity("first");
  stop();
  stop();
  state.activity("second");
  assert.equal(notified, 1);
  state.finish(undefined, "generation aborted; no final selection");
  assert.equal(state.get().status, "failed");
  state.report({ type: "phase", phase: "voting" });
  assert.equal(state.get().phase, "preparing");
});

test("inspection selection survives new iterations and f returns to live", (t) => {
  const state = new ReplayLiveState("task", 3);
  iteration(state, 1);
  iteration(state, 2);
  const h = consoleHarness(state, t);
  h.component.handleInput("\x1b[A");
  assert.match(h.component.render(100).join("\n"), /Inspecting #1/);
  iteration(state, 3);
  assert.match(h.component.render(100).join("\n"), /Inspecting #1 · live: #3/);
  h.component.handleInput("f");
  assert.match(h.component.render(100).join("\n"), /Following live · iteration 3/);
  h.component.handleInput("d");
  assert.equal(h.inspected(), 1);
});

test("compact inspection does not close the screen or accept unrelated input; completion does not reopen it", (t) => {
  const state = new ReplayLiveState("task", 1);
  const h = consoleHarness(state, t);
  h.component.handleInput("\x1b");
  assert.match(h.component.render(100).join("\n"), /Transcript inspection only/);
  assert.equal(h.closed(), 0);
  h.component.handleInput("/reload\r");
  assert.equal(h.closed(), 0);
  h.component.handleInput("\x1b");
  assert.equal(h.interrupted(), 1);
  h.component.handleInput("v");
  assert.match(h.component.render(100).join("\n"), /Following live/);
  h.component.handleInput("\x1b");
  state.finish();
  assert.equal(h.closed(), 1);
});

test("foreground completion remains until dismissed; captured restoration failure stays distinct", (t) => {
  const state = new ReplayLiveState("task", 1);
  const h = consoleHarness(state, t);
  state.finish({ overview: { headline: "Winner selected · restoration failed", iterations: [], groups: [], notes: ["Recovery failed"] } }, "restoration failed");
  assert.equal(h.closed(), 0);
  const text = h.component.render(100).join("\n");
  assert.match(text, /FAILED/);
  assert.match(text, /Winner selected · restoration failed/);
  assert.match(text, /Recovery failed/);
  assert.doesNotMatch(text, /COMPLETE/);
  h.component.handleInput("\r");
  assert.equal(h.closed(), 1);
});

test("live layout fits terminal size and sanitizes untrusted paths/messages", (t) => {
  const state = new ReplayLiveState("工程 🦀 é\x1b[31m\nunsafe", 20);
  for (let i = 1; i <= 20; i++) iteration(state, i);
  state.startTool({ id: "tool", name: "read", summary: "\x1b]8;;file://bad\x07工程.ts", startedAt: Date.now() });
  state.inputPrompt(1);
  const h = consoleHarness(state, t);
  for (const rows of [6, 10, 24, 60]) {
    h.resize(rows);
    for (const width of [1, 12, 40, 109, 110, 160]) {
      const lines = h.component.render(width);
      assert.ok(lines.length <= Math.max(1, rows - 5));
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.every((line) => !line.replaceAll("\x1b[0m", "").includes("\x1b") && !line.includes("\x07")));
    }
  }
  h.resize(30);
  assert.match(h.component.render(100).join("\n"), /AWAITING INPUT/);
  assert.deepEqual(h.component.render(0), []);
  h.component.invalidate();
  h.component.dispose();
  h.component.dispose();
});

test("wide console places a vertical graph below activity while the tree spans the left pane", (t) => {
  const state = new ReplayLiveState("task", 40);
  for (let index = 1; index <= 30; index++) iteration(state, index);
  const h = consoleHarness(state, t);
  h.resize(36);
  const lines = h.component.render(140);
  const activity = lines.findIndex((line) => line.includes("CURRENT ACTIVITY"));
  const graph = lines.findIndex((line) => line.includes("SEARCH SHAPE"));
  assert.match(lines.join("\n"), /ITERATION LINEAGE/);
  assert.ok(graph > activity);
  assert.ok(lines.slice(graph + 1).some((line) => line.includes("#30 explore")));
  assert.ok(lines.slice(graph + 1).some((line) => /◆|░|▒|▓/.test(sliceByColumn(line, 65, 75))));
  assert.ok(lines.every((line) => visibleWidth(line) <= 140));
});

test("narrow and short screens omit the graph before the readable lineage/activity", (t) => {
  const state = new ReplayLiveState("task", 2);
  iteration(state, 1);
  const h = consoleHarness(state, t);
  h.resize(24);
  const narrow = h.component.render(80).join("\n");
  assert.match(narrow, /ITERATION LINEAGE/);
  assert.match(narrow, /CURRENT ACTIVITY/);
  assert.doesNotMatch(narrow, /SEARCH SHAPE/);
  h.resize(18);
  const short = h.component.render(140).join("\n");
  assert.match(short, /ITERATION LINEAGE/);
  assert.match(short, /CURRENT ACTIVITY/);
  assert.doesNotMatch(short, /SEARCH SHAPE/);
});

test("tree navigation follows displayed lineage order and preserves selected identity as a new sibling arrives", (t) => {
  const state = new ReplayLiveState("task", 4);
  iteration(state, 1);
  iteration(state, 2);
  state.report({ type: "iteration", iteration: 3, approach: "exploit", sourceIteration: 1, targetStepId: "step-1" });
  const h = consoleHarness(state, t);
  const tree = h.component.render(140).join("\n");
  assert.ok(tree.indexOf("#1 explore") < tree.indexOf("#3 exploit"));
  assert.ok(tree.indexOf("#3 exploit") < tree.indexOf("#2 explore"));
  h.component.handleInput("\x1b[A"); // #3's predecessor in the tree is #1, not #2.
  assert.match(h.component.render(100).join("\n"), /Inspecting #1/);
  h.component.handleInput("\x1b[B");
  assert.match(h.component.render(100).join("\n"), /Inspecting #3/);
  h.component.handleInput("\x1b[B");
  assert.match(h.component.render(100).join("\n"), /Inspecting #2/);
  state.report({ type: "iteration", iteration: 4, approach: "exploit", sourceIteration: 1, targetStepId: "step-2" });
  assert.match(h.component.render(100).join("\n"), /Inspecting #2 · live: #4/);
  h.component.handleInput("f");
  assert.match(h.component.render(100).join("\n"), /Following live · iteration 4/);
});

test("graph shape is stable across tool/regression updates and selection; finalization alone supplies the winner", (t) => {
  t.mock.method(Date, "now", () => 1000);
  t.mock.method(Math, "random", () => { throw new Error("must not sample"); });
  const state = new ReplayLiveState("task", 3);
  iteration(state, 1);
  iteration(state, 2);
  state.report({ type: "iteration", iteration: 3, approach: "exploit", sourceIteration: 1, targetStepId: "step-1" });
  const h = consoleHarness(state, t);
  h.resize(36);
  const graph = () => {
    const lines = h.component.render(140);
    const start = lines.findIndex((line) => line.includes("SEARCH SHAPE"));
    return lines.slice(start + 1, -1).map((line) => sliceByColumn(line, 65, 75)).join("\n");
  };
  const before = graph();
  state.activity("read a.ts");
  state.report({ type: "candidate", iteration: 3 });
  state.report({ type: "evaluation", iteration: 3, status: "passed" });
  assert.equal(graph(), before);
  h.component.handleInput("\x1b[A");
  assert.equal(graph(), before);
  assert.doesNotMatch(graph(), /★/);
  state.finish({ overview: { headline: "Selected iteration 1", groups: [], notes: [], iterations: [{ iteration: 1, representative: true }] } });
  const finished = graph();
  assert.match(finished, /★/);
  assert.doesNotMatch(finished, /◉|◎/);
  assert.equal(graph(), finished);
});

function controllerHarness(execute, t) {
  const handlers = new Map();
  const notices = [];
  const components = [];
  const terminalHandlers = new Set();
  let sessionId = "session";
  let navigated = 0;
  let appends = 0;
  const emit = async (type, event = {}) => {
    const results = [];
    for (const handler of [...(handlers.get(type) ?? [])]) results.push(await handler({ type, ...event }, ctx));
    return results;
  };
  const pi = {
    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(handler);
      return () => handlers.get(type).delete(handler);
    },
    appendEntry() { appends++; },
    sendUserMessage(text) { void emit("input", { text, source: "extension" }); },
    sendMessage() {},
  };
  const ctx = {
    mode: "tui", cwd: "/tmp", isIdle: () => true, abort() {},
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [], getBranch: () => [] },
    async navigateTree(targetId) {
      const [result] = await emit("session_before_tree", { preparation: { targetId } });
      if (result?.cancel) return { cancelled: true };
      navigated++;
      return { cancelled: false };
    },
    ui: {
      notify(message, kind) { notices.push({ message, kind }); },
      onTerminalInput(handler) { terminalHandlers.add(handler); return () => terminalHandlers.delete(handler); },
      custom(factory) {
        return new Promise((resolve) => {
          let component;
          component = factory({ requestRender() {}, terminal: { rows: 30 } }, theme, keys, () => { component.dispose(); resolve(); });
          components.push(component);
        });
      },
    },
  };
  const controller = new ReplayRunController(pi, execute);
  t.after(() => { for (const component of components) component.dispose(); });
  return { controller, ctx, pi, emit, notices, components, handlers, terminalHandlers, navigated: () => navigated, appends: () => appends,
    replaceSession: () => { sessionId = "replacement"; } };
}

test("background controller returns immediately, owns prompts/navigation, and releases all guards", async (t) => {
  const gate = deferred();
  const started = deferred();
  const h = controllerHarness(async (pi, ctx, n, prompt, command, execution) => {
    execution.report({ type: "iteration", iteration: 1, approach: "explore" });
    pi.sendUserMessage(prompt);
    started.resolve();
    await gate.promise;
    execution.assertActive();
    assert.deepEqual(await ctx.navigateTree("authorized"), { cancelled: false });
  }, t);
  assert.equal(h.controller.start(h.ctx, 2, "task", "true"), undefined);
  await started.promise;
  assert.equal(h.controller.isRunning(), true);
  assert.throws(() => h.controller.start(h.ctx, 2, "task", "true"), /already active/);
  assert.deepEqual(await h.emit("input", { text: "unrelated", source: "interactive" }), [{ action: "handled" }]);
  assert.deepEqual(await h.emit("input", { text: "task", source: "extension" }), [{ action: "handled" }]); // permit consumed once
  assert.deepEqual(await h.emit("input", { text: "unrelated", source: "rpc" }), [{ action: "handled" }]);
  assert.deepEqual(await h.emit("session_before_tree", { preparation: { targetId: "other" } }), [{ cancel: true }]);
  for (const event of ["session_before_switch", "session_before_fork"]) {
    assert.deepEqual(await h.emit(event), [{ cancel: true }]);
  }
  assert.deepEqual(await h.emit("session_before_compact", { reason: "manual" }), [{ cancel: true }]);
  assert.deepEqual(await h.emit("session_before_compact", { reason: "overflow" }), [undefined]);
  assert.equal((await h.emit("user_bash"))[0].result.exitCode, 1);

  h.components[0].handleInput("\x1b");
  assert.equal(h.controller.show(h.ctx), true);
  assert.match(h.components[0].render(100).join("\n"), /Following live/);
  gate.resolve();
  await h.controller.waitForCompletion();
  assert.equal(h.navigated(), 1);
  assert.equal(h.controller.isRunning(), false);
  assert.ok([...h.handlers.values()].every((set) => set.size === 0));
  assert.equal(h.notices.filter((notice) => notice.message.startsWith("SWE-Replay:")).length, 1);
});

test("shutdown invalidates detached work before persistence or navigation and disposes UI", async (t) => {
  const gate = deferred();
  let caught;
  const h = controllerHarness(async (pi, ctx, _n, _prompt, _command, execution) => {
    await gate.promise;
    assert.equal(execution.signal.aborted, true);
    try { pi.appendEntry("unexpected", {}); } catch (error) { caught = error; }
    await ctx.navigateTree("stale");
  }, t);
  h.controller.start(h.ctx, 1, "task", "true");
  const shutdown = h.emit("session_shutdown", { reason: "reload" });
  gate.resolve();
  await shutdown;
  h.replaceSession();
  await h.controller.waitForCompletion();
  assert.match(String(caught), /invalidated/);
  assert.equal(h.appends(), 0);
  assert.equal(h.navigated(), 0);
  assert.equal(h.notices.length, 0);
  assert.ok([...h.handlers.values()].every((set) => set.size === 0));
});

test("a console mount failure does not expose unrestricted terminal input during execution", async (t) => {
  const gate = deferred();
  const h = controllerHarness(async () => { await gate.promise; }, t);
  h.ctx.ui.custom = () => { throw new Error("mount failed"); };
  h.controller.start(h.ctx, 1, "task", "true");
  assert.equal(h.controller.isRunning(), true);
  assert.match(h.notices[0].message, /console unavailable/);
  for (const handler of h.terminalHandlers) assert.deepEqual(handler("/reload\r"), { consume: true });
  gate.resolve();
  await h.controller.waitForCompletion();
  assert.equal(h.terminalHandlers.size, 0);
});

test("controller reports executor failures once and restores prompt access", async (t) => {
  const h = controllerHarness(async () => { throw new Error("baseline failed"); }, t);
  h.controller.start(h.ctx, 1, "task", "false");
  await h.controller.waitForCompletion();
  assert.equal(h.controller.isRunning(), false);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].kind, "error");
  assert.match(h.components[0].render(100).join("\n"), /baseline failed/);
  assert.ok([...h.handlers.values()].every((set) => set.size === 0));
  assert.deepEqual(await h.emit("input", { text: "new task", source: "interactive" }), []);
});
