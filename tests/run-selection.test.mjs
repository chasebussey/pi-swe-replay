import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { runSweReplay } = await jiti.import("../extensions/swe-replay/run.ts");

function harness(withCandidates, t) {
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
      leaf = id;
      return { cancelled: false };
    },
  };
  const pi = {
    appendEntry: (customType, data) => append({ type: "custom", customType, data }),
    on: (name, handler) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
      return () => listeners.get(name).delete(handler);
    },
    sendUserMessage: async (prompt) => {
      prompts++;
      startingFiles.push(readFileSync(join(cwd, "a"), "utf8"));
      append({ type: "message", message: { role: "user", content: prompt } });
      for (let turnIndex = 0; turnIndex < (withCandidates ? 2 : 1); turnIndex++) {
        const message = { role: "assistant", content: [{ type: "thinking", thinking: "Reasoning." }] };
        const step = append({ type: "message", message });
        if (withCandidates && turnIndex === 0) {
          await emit("tool_result", { toolName: "read", input: { path: "a" }, isError: false });
        }
        writeFileSync(join(cwd, "a"), `turn-${turnIndex}`);
        await emit("turn_end", { turnIndex, messageEntryId: step.id });
      }
      await emit("agent_settled", {});
    },
  };
  return { pi, ctx, entries, navigations, listeners, startingFiles, promptCount: () => prompts };
}

test("exploitation persists its selection without navigating or sending a replacement yet", async (t) => {
  t.mock.method(Math, "random", () => 0.9);
  const h = harness(true, t);
  await runSweReplay(h.pi, h.ctx, 2, "task");
  assert.equal(readFileSync(join(h.ctx.cwd, "a"), "utf8"), "turn-0");
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
    files: [join(h.ctx.cwd, "a")], candidateStepIds: [persisted.selection.stepId], probability: 1,
  }]);
  assert.deepEqual(persisted.trace.candidates, [{
    stepId: persisted.selection.stepId, reasoningScore: 1, probability: 1,
  }]);
  assert.equal(persisted.selection.trace, undefined); // Stored once, alongside legacy fields.
  assert.equal(h.promptCount(), 1);
  const snapshots = h.entries.filter((entry) => entry.customType === "swe-replay-workspace");
  assert.equal(snapshots.length, 3); // Root plus both completed turns.
  assert.equal(snapshots[0].data.stepId, h.entries[0].id);
  assert.equal(h.ctx.sessionManager.getEntry(snapshots[1].data.stepId).message.role, "assistant");
  assert.equal(h.entries.filter((entry) => entry.customType === "swe-replay-workspace-backup").length, 1);
  assert.deepEqual(h.navigations, []);
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
  assert.deepEqual(h.navigations, [{ id: h.entries[0].id, options: { summarize: false } }]);
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
