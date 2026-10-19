import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { runSweReplay } = await jiti.import("../extensions/swe-replay/run.ts");

function harness(withCandidates) {
  const entries = [];
  const listeners = new Map();
  const navigations = [];
  let leaf;
  let prompts = 0;
  const append = (entry) => {
    const value = { ...entry, id: `entry-${entries.length}`, parentId: leaf ?? null };
    entries.push(value);
    leaf = value.id;
    return value;
  };
  const emit = (name, event) => {
    for (const handler of listeners.get(name) ?? []) handler(event, ctx);
  };
  const ctx = {
    cwd: "/repo",
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
    sendUserMessage: (prompt) => {
      prompts++;
      append({ type: "message", message: { role: "user", content: prompt } });
      for (let turnIndex = 0; turnIndex < (withCandidates ? 2 : 1); turnIndex++) {
        const message = { role: "assistant", content: [{ type: "thinking", thinking: "Reasoning." }] };
        const step = append({ type: "message", message });
        if (withCandidates && turnIndex === 0) {
          emit("tool_result", { toolName: "read", input: { path: "a" }, isError: false });
        }
        emit("turn_end", { turnIndex, messageEntryId: step.id });
      }
      emit("agent_settled", {});
    },
  };
  return { pi, ctx, entries, navigations, listeners, promptCount: () => prompts };
}

test("exploitation persists its selection without navigating or sending a replacement yet", async (t) => {
  t.mock.method(Math, "random", () => 0.9);
  const h = harness(true);
  await runSweReplay(h.pi, h.ctx, 2, "task");
  const log = h.entries.find((entry) => entry.customType === "swe-replay-exploit-log").data;
  assert.equal(log.iteration, 2);
  assert.equal(log.rootEntryId, h.entries[0].id);
  assert.deepEqual(log.selection.state.files, ["/repo/a"]);
  assert.equal(log.selection.reasoningScore, 1);
  assert.equal(h.ctx.sessionManager.getEntry(log.selection.stepId).message.role, "assistant");
  assert.equal(log.fallbackReason, undefined);
  assert.equal(h.promptCount(), 1);
  assert.deepEqual(h.navigations, []);
  assert.ok([...h.listeners.values()].every((handlers) => handlers.size === 0));
});

test("an empty archive logs its fallback reason and explores from the root", async (t) => {
  t.mock.method(Math, "random", () => 0.9);
  const h = harness(false);
  await runSweReplay(h.pi, h.ctx, 2, "task");
  const log = h.entries.find((entry) => entry.customType === "swe-replay-exploit-log").data;
  assert.deepEqual(log.states, []);
  assert.equal(log.selection, null);
  assert.equal(log.fallbackReason, "no-eligible-states");
  assert.equal(h.promptCount(), 2);
  assert.deepEqual(h.navigations, [{ id: h.entries[0].id, options: { summarize: false } }]);
  assert.ok([...h.listeners.values()].every((handlers) => handlers.size === 0));
});

test("a normal exploration iteration bypasses exploitation selection", async (t) => {
  t.mock.method(Math, "random", () => 0.1);
  const h = harness(true);
  await runSweReplay(h.pi, h.ctx, 2, "task");
  assert.equal(h.promptCount(), 2);
  assert.equal(h.navigations.length, 1);
  assert.equal(h.entries.some((entry) => entry.customType === "swe-replay-exploit-log"), false);
});
