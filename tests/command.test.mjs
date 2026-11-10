import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { default: extension } = await jiti.import("../extensions/index.ts");
const { ReplayRunController } = await jiti.import("../extensions/swe-replay/run-controller.ts");

function harness() {
  const commands = new Map();
  const notices = [];
  const dialogs = [];
  const pi = {
    on() { return () => {}; },
    registerCommand(name, command) { commands.set(name, command); },
    appendEntry() { assert.fail("must not create a run"); },
    sendUserMessage() { assert.fail("must not send a prompt"); },
  };
  const ctx = {
    mode: "tui", hasUI: true, isIdle: () => true,
    ui: {
      notify(message) { notices.push(message); },
      async select(title, options) { dialogs.push({ title, options }); return options[0]; },
      async input() { dialogs.push("input"); return "  true  "; },
    },
  };
  extension(pi);
  return { ctx, notices, dialogs, run: (args = "1 task") => commands.get("swe-replay").handler(args, ctx) };
}

test("command offers TSC first/default and passes either resolved immutable choice to the TUI controller", async (t) => {
  const calls = [];
  t.mock.method(ReplayRunController.prototype, "start", (...args) => calls.push(args));
  for (const backend of ["tsc", "agentless"]) {
    const h = harness();
    if (backend === "agentless") h.ctx.ui.select = async (_title, options) => options[1];
    await h.run();
    const [ctx, count, prompt, command, options] = calls.at(-1);
    assert.equal(ctx, h.ctx);
    assert.equal(count, 1);
    assert.equal(prompt, "task");
    assert.equal(command, "true");
    assert.equal(options.normalizationContract.backend, backend);
    assert.ok(Object.isFrozen(options.normalizationContract));
    if (backend === "tsc") assert.match(h.dialogs[0].options[0], /TSC \(default\).*\.py\/\.ts/);
  }
});

test("invalid/busy/nonidle/noUI paths do not show dialogs or start a run", async (t) => {
  t.mock.method(ReplayRunController.prototype, "start", () => assert.fail("must not start"));
  for (const scenario of ["invalid", "busy", "nonidle", "noUI"]) {
    const h = harness();
    const busy = t.mock.method(ReplayRunController.prototype, "isRunning", () => scenario === "busy");
    h.ctx.isIdle = () => scenario !== "nonidle";
    h.ctx.hasUI = scenario !== "noUI";
    await h.run(scenario === "invalid" ? "0 task" : undefined);
    assert.equal(h.dialogs.length, 0, scenario);
    assert.equal(h.notices.length, 1, scenario);
    busy.mock.restore();
  }
});

test("canceled/unknown choice, empty regression, and input errors release preparation without starting", async (t) => {
  let started = 0;
  t.mock.method(ReplayRunController.prototype, "start", () => { started++; });
  for (const scenario of ["cancel-choice", "unknown-choice", "cancel-input", "empty-input", "error"]) {
    const h = harness();
    const select = h.ctx.ui.select;
    const input = h.ctx.ui.input;
    if (scenario === "cancel-choice") h.ctx.ui.select = async () => undefined;
    if (scenario === "unknown-choice") h.ctx.ui.select = async () => "future";
    if (scenario === "cancel-input") h.ctx.ui.input = async () => undefined;
    if (scenario === "empty-input") h.ctx.ui.input = async () => "  ";
    if (scenario === "error") h.ctx.ui.select = async () => { throw new Error("dialog failed"); };
    const before = started;
    if (scenario === "error") await assert.rejects(h.run(), /dialog failed/);
    else await h.run();
    assert.equal(started, before, scenario);
    h.ctx.ui.select = select;
    h.ctx.ui.input = input;
    await h.run();
    assert.equal(started, before + 1, "preparation guard released");
  }
});

test("pending dialogs reject concurrent commands and readiness is rechecked after input", async (t) => {
  t.mock.method(ReplayRunController.prototype, "start", () => assert.fail("must not start"));
  const h = harness();
  let release;
  h.ctx.ui.select = (_title, options) => new Promise((resolve) => { release = () => resolve(options[0]); });
  const pending = h.run();
  await h.run();
  assert.match(h.notices.at(-1), /already active/);
  h.ctx.ui.input = async () => { h.ctx.isIdle = () => false; return "true"; };
  release();
  await pending;
  assert.match(h.notices.at(-1), /became active/);
});
