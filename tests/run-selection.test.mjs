import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { runSweReplay: run } = await jiti.import("../extensions/swe-replay/run.ts");
const runSweReplay = (pi, ctx, n, prompt, command = "true") => run(pi, ctx, n, prompt, command);

function harness(withCandidates, t, { cancelNavigation = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "replay-run-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(cwd, "a"), "initial");
  git("add", ".");
  git("commit", "-m", "initial");
  const entries = [];
  const listeners = new Map();
  const navigations = [];
  let leaf;
  let prompts = 0;
  const startingFiles = [];
  const continuations = [];
  const append = (entry) => {
    const value = { ...entry, id: `entry-${entries.length}`, parentId: leaf ?? null };
    entries.push(value);
    leaf = value.id;
    return value;
  };
  const emit = async (name, event) => {
    for (const handler of listeners.get(name) ?? []) await handler(event, ctx);
  };
  const ctx = {
    cwd,
    ui: { notify: () => {} },
    sessionManager: {
      getEntries: () => [...entries],
      getEntry: (id) => entries.find((entry) => entry.id === id),
      getLeafEntry: () => entries.find((entry) => entry.id === leaf),
      getBranch: () => {
        const branch = [];
        let entry = entries.find((entry) => entry.id === leaf);
        while (entry) {
          branch.unshift(entry);
          entry = entries.find((parent) => parent.id === entry.parentId);
        }
        return branch;
      },
    },
    navigateTree: async (id, options) => {
      navigations.push({ id, options });
      if (cancelNavigation) return { cancelled: true };
      const target = entries.find((entry) => entry.id === id);
      // Match Pi's special navigation behavior for custom/user messages.
      leaf = target.type === "custom_message" || target.message?.role === "user" ? target.parentId : id;
      return { cancelled: false };
    },
  };
  const pi = {
    exec: async (command, args, options) => {
      try {
        return { stdout: execFileSync(command, args, { ...options, encoding: "utf8", stdio: "pipe" }), stderr: "", code: 0, killed: false };
      } catch (error) {
        return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.status ?? 1, killed: Boolean(error.signal) };
      }
    },
    appendEntry: (customType, data) => append({ type: "custom", customType, data }),
    on: (name, handler) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
      return () => listeners.get(name).delete(handler);
    },
    sendMessage: async (message, options) => {
      assert.ok(listeners.get("turn_end")?.size > 0);
      assert.ok(listeners.get("agent_settled")?.size > 0);
      continuations.push({ message, options, branch: ctx.sessionManager.getBranch(), file: readFileSync(join(cwd, "a"), "utf8") });
      append({ type: "custom_message", ...message });
      // Model work is asynchronous; replay must wait, not observe pre-start idle.
      await new Promise((resolve) => setImmediate(resolve));
      const replacement = { role: "assistant", content: [{ type: "thinking", thinking: "Replacement reasoning." }] };
      await emit("message_start", { message: replacement });
      const step = append({ type: "message", message: replacement });
      await emit("tool_result", { toolName: "read", input: { path: "b" }, isError: false });
      append({ type: "message", message: { role: "toolResult", toolCallId: "replacement-tool", content: [{ type: "text", text: "replacement result" }] } });
      writeFileSync(join(cwd, "a"), "replacement");
      await emit("turn_end", { turnIndex: 0, messageEntryId: step.id });
      await emit("agent_end", {});
      await new Promise((resolve) => setImmediate(resolve));
      await emit("agent_settled", {});
    },
    sendUserMessage: async (prompt) => {
      prompts++;
      startingFiles.push(readFileSync(join(cwd, "a"), "utf8"));
      append({ type: "message", message: { role: "user", content: prompt } });
      for (let turnIndex = 0; turnIndex < (withCandidates ? 2 : 1); turnIndex++) {
        const message = { role: "assistant", content: [{ type: "thinking", thinking: "Reasoning." }] };
        await emit("message_start", { message });
        const step = append({ type: "message", message });
        if (withCandidates && turnIndex === 0) {
          await emit("tool_result", { toolName: "read", input: { path: "a" }, isError: false });
        }
        append({ type: "message", message: { role: "toolResult", toolCallId: `tool-${turnIndex}`, content: [{ type: "text", text: `result-${turnIndex}` }] } });
        writeFileSync(join(cwd, "a"), `turn-${turnIndex}`);
        await emit("turn_end", { turnIndex, messageEntryId: step.id });
      }
      await emit("agent_settled", {});
    },
  };
  return { pi, ctx, entries, navigations, listeners, startingFiles, continuations, promptCount: () => prompts };
}

test("exploitation restores pre-step context and continues via an empty custom message", async (t) => {
  t.mock.method(Math, "random", () => 0.9);
  const h = harness(true, t);
  await runSweReplay(h.pi, h.ctx, 2, "task");
  assert.equal(h.continuations.length, 1);
  assert.deepEqual(h.continuations[0].message, { customType: "swe-replay-continue", content: "", display: false });
  assert.deepEqual(h.continuations[0].options, { triggerTurn: true });
  assert.equal(h.continuations[0].file, "turn-0");
  assert.equal(readFileSync(join(h.ctx.cwd, "a"), "utf8"), "replacement");
  const log = h.entries.find((entry) => entry.customType === "swe-replay-exploit-log").data;
  assert.equal(log.iteration, 2);
  assert.equal(log.rootEntryId, h.entries[0].id);
  assert.deepEqual(log.selection.state.files, [join(h.ctx.cwd, "a")]);
  assert.equal(log.selection.reasoningScore, 1);
  assert.equal(h.ctx.sessionManager.getEntry(log.selection.stepId).message.role, "assistant");
  assert.equal(log.fallbackReason, undefined);
  const persisted = JSON.parse(JSON.stringify(log));
  assert.equal(persisted.trace.policyVersion, 1);
  assert.equal(persisted.trace.selectedStepId, persisted.selection.stepId);
  assert.deepEqual(persisted.trace.states, [{
    files: [join(h.ctx.cwd, "a")],
    candidates: [{ stepId: persisted.selection.stepId, multiplicity: 1 }],
    probability: 1,
  }]);
  assert.deepEqual(persisted.trace.candidates, [{
    stepId: persisted.selection.stepId, reasoningScore: 1, probability: 1,
  }]);
  assert.equal(persisted.selection.trace, undefined); // Stored once, alongside legacy fields.
  assert.equal(h.promptCount(), 1);
  const snapshots = h.entries.filter((entry) => entry.customType === "swe-replay-workspace");
  assert.equal(snapshots.length, 4); // Root, original turns, and replacement.
  const replacementFiles = h.entries.filter((entry) => entry.customType === "swe-replay-turn-files" && entry.data.iteration === 2);
  assert.equal(replacementFiles.length, 1);
  assert.deepEqual(replacementFiles[0].data.files, [join(h.ctx.cwd, "a"), join(h.ctx.cwd, "b")].sort());
  assert.equal(snapshots[3].data.stepId, replacementFiles[0].data.messageEntryId);
  assert.equal(snapshots[0].data.stepId, h.entries[0].id);
  assert.equal(h.ctx.sessionManager.getEntry(snapshots[1].data.stepId).message.role, "assistant");
  assert.equal(h.entries.filter((entry) => entry.customType === "swe-replay-workspace-backup").length, 1);
  const selected = h.ctx.sessionManager.getEntry(log.selection.stepId);
  assert.deepEqual(h.navigations, [{ id: selected.parentId, options: { summarize: false } }]);
  const branch = h.ctx.sessionManager.getBranch();
  assert.equal(branch.some((entry) => entry.id === selected.id), false);
  assert.equal(branch.some((entry) => entry.message?.toolCallId === "tool-1"), false);
  assert.equal(branch.some((entry) => entry.message?.toolCallId === "tool-0"), true);
  assert.equal(branch.some((entry) => entry.id === snapshots[1].data.stepId), true);
  assert.equal(branch.some((entry) => entry.id === snapshots[1].id), true);
  // Navigating does not delete the original step, tool results, or decision log.
  assert.equal(h.entries.some((entry) => entry.id === selected.id), true);
  assert.equal(h.entries.some((entry) => entry.message?.toolCallId === "tool-1"), true);
  assert.ok([...h.listeners.values()].every((handlers) => handlers.size === 0));
});

test("persisted selection traces identify the passed-trajectory-occurrences eligibility policy", async (t) => {
  t.mock.method(Math, "random", () => 0.9);
  const h = harness(true, t);
  await runSweReplay(h.pi, h.ctx, 2, "task");

  const log = h.entries.find((entry) => entry.customType === "swe-replay-exploit-log").data;
  assert.equal(log.trace.eligibilityPolicy, "passed-trajectory-occurrences");
});

test("later exploitation can replace a generated step while retaining its empty trigger", async (t) => {
  t.mock.method(Math, "random", () => 0.9);
  const h = harness(true, t);
  await runSweReplay(h.pi, h.ctx, 3, "task");
  assert.equal(h.promptCount(), 1);
  assert.equal(h.continuations.length, 2);
  const decisions = h.entries.filter((entry) => entry.customType === "swe-replay-exploit-log");
  const selected = h.ctx.sessionManager.getEntry(decisions[1].data.selection.stepId);
  const boundary = h.ctx.sessionManager.getEntry(selected.parentId);
  assert.equal(boundary.customType, "swe-replay-step-boundary");
  assert.equal(boundary.data.iteration, 2);
  assert.equal(h.continuations[1].branch.some((entry) => entry.id === selected.id), false);
  assert.equal(h.continuations[1].branch.some((entry) => entry.customType === "swe-replay-continue"), true);
  assert.equal(h.continuations[1].file, "turn-0");
  assert.ok([...h.listeners.values()].every((handlers) => handlers.size === 0));
});

test("a synchronous continuation-trigger error still removes all replay listeners", async (t) => {
  t.mock.method(Math, "random", () => 0.9);
  const h = harness(true, t);
  h.pi.sendMessage = () => { throw new Error("Trigger failed"); };
  await assert.rejects(runSweReplay(h.pi, h.ctx, 2, "task"), /Trigger failed/);
  assert.ok([...h.listeners.values()].every((handlers) => handlers.size === 0));
});

test("cancelled exploitation navigation leaves files untouched and does not send a replacement", async (t) => {
  t.mock.method(Math, "random", () => 0.9);
  const h = harness(true, t, { cancelNavigation: true });
  await assert.rejects(runSweReplay(h.pi, h.ctx, 2, "task"), /Exploit iteration 2 was cancelled/);
  assert.equal(readFileSync(join(h.ctx.cwd, "a"), "utf8"), "turn-1");
  assert.equal(h.promptCount(), 1);
  assert.equal(h.entries.some((entry) => entry.customType === "swe-replay-workspace-backup"), false);
  assert.equal(h.continuations.length, 0);
  assert.ok([...h.listeners.values()].every((handlers) => handlers.size === 0));
});

test("an empty archive logs its fallback reason and explores from the root", async (t) => {
  t.mock.method(Math, "random", () => 0.9);
  const h = harness(false, t);
  await runSweReplay(h.pi, h.ctx, 2, "task");
  const log = h.entries.find((entry) => entry.customType === "swe-replay-exploit-log").data;
  assert.deepEqual(log.states, []);
  assert.equal(log.selection, null);
  assert.equal(log.trace, null);
  assert.equal(log.fallbackReason, "no-eligible-states");
  assert.equal(h.promptCount(), 2);
  assert.equal(h.continuations.length, 0);
  assert.deepEqual(h.navigations, [{ id: h.entries[0].id, options: { summarize: false } }]);
  assert.ok([...h.listeners.values()].every((handlers) => handlers.size === 0));
});

test("a failing baseline stops before any prompt and persists the frozen command", async (t) => {
  const h = harness(true, t);
  await assert.rejects(runSweReplay(h.pi, h.ctx, 2, "task", "exit 1"), /baseline failed/);
  assert.equal(h.promptCount(), 0);
  assert.equal(h.entries[0].data.testCommand, "exit 1");
  assert.equal(h.entries[0].data.prompt, "task");
  const evaluation = h.entries.find((entry) => entry.customType === "swe-replay-evaluation").data;
  assert.equal(evaluation.iteration, 0);
  assert.equal(evaluation.status, "failed");
});

test("failed trajectories are excluded before grouping and fall back to exploration", async (t) => {
  t.mock.method(Math, "random", () => 0.9);
  const h = harness(true, t);
  // Baseline passes; both generated candidates fail. Tests mutate only the evaluator's copy.
  await runSweReplay(h.pi, h.ctx, 2, "task", 'test "$(cat a)" = initial');
  assert.equal(h.promptCount(), 2);
  assert.equal(h.continuations.length, 0);
  const evaluations = h.entries.filter((entry) => entry.customType === "swe-replay-evaluation");
  assert.deepEqual(evaluations.map((entry) => entry.data.status), ["passed", "failed", "failed"]);
  const log = h.entries.find((entry) => entry.customType === "swe-replay-exploit-log").data;
  assert.deepEqual(log.states, []);
  assert.equal(log.fallbackReason, "no-eligible-states");
});

test("inconclusive candidate evaluation persists evidence and stops replay", async (t) => {
  const h = harness(true, t);
  let calls = 0;
  h.pi.exec = async () => ({ code: 0, killed: calls++ > 0, stdout: "", stderr: "" });
  await assert.rejects(runSweReplay(h.pi, h.ctx, 3, "task"), /iteration 1.*inconclusive/);
  assert.equal(h.promptCount(), 1);
  assert.equal(h.entries.at(-1).data.status, "inconclusive");
  assert.ok([...h.listeners.values()].every((handlers) => handlers.size === 0));
});

test("a normal exploration iteration bypasses exploitation selection", async (t) => {
  t.mock.method(Math, "random", () => 0.1);
  const h = harness(true, t);
  await runSweReplay(h.pi, h.ctx, 2, "task");
  assert.equal(h.promptCount(), 2);
  assert.equal(h.navigations.length, 1);
  assert.deepEqual(h.startingFiles, ["initial", "initial"]);
  assert.equal(h.entries.some((entry) => entry.customType === "swe-replay-exploit-log"), false);
});
