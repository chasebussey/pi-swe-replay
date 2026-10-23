import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { runSweReplay: run } = await jiti.import("../extensions/swe-replay/run.ts");
const { readReplayArchive, completedSelectionInputs } = await jiti.import("../extensions/swe-replay/replay-records.ts");
const { ReplayWorkspace } = await jiti.import("../extensions/swe-replay/workspace.ts");
const runSweReplay = (pi, ctx, n, prompt, command = "true") => run(pi, ctx, n, prompt, command);

function harness(withCandidates, t, { cancelNavigation = false, abortIteration, contents, stopReason = "stop", onTurn } = {}) {
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
    isIdle: () => true,
    waitForIdle: async () => {},
    abort: () => {},
    ui: { notify: () => {} },
    sessionManager: {
      getEntries: () => [...entries],
      getEntry: (id) => entries.find((entry) => entry.id === id),
      getLeafEntry: () => entries.find((entry) => entry.id === leaf),
      getBranch: (fromId = leaf) => {
        const branch = [];
        let entry = entries.find((entry) => entry.id === fromId);
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
      const replacement = { role: "assistant", stopReason, content: [{ type: "thinking", thinking: "Replacement reasoning." }] };
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
        const message = { role: "assistant", stopReason, content: [{ type: "thinking", thinking: "Reasoning." }] };
        await emit("message_start", { message });
        const step = append({ type: "message", message });
        if (withCandidates && turnIndex === 0) {
          await emit("tool_result", { toolName: "read", input: { path: "a" }, isError: false });
        }
        append({ type: "message", message: { role: "toolResult", toolCallId: `tool-${turnIndex}`, content: [{ type: "text", text: `result-${turnIndex}` }] } });
        writeFileSync(join(cwd, "a"), contents?.[prompts - 1] ?? `turn-${turnIndex}`);
        await onTurn?.({ cwd, prompts, turnIndex });
        await emit("turn_end", { turnIndex, messageEntryId: step.id });
      }
      await emit("agent_settled", { aborted: prompts === abortIteration });
    },
  };
  return { pi, ctx, entries, navigations, listeners, startingFiles, continuations, emit, append, git, promptCount: () => prompts };
}

test("exploitation restores pre-step context and continues via an empty custom message", async (t) => {
  t.mock.method(Math, "random", () => 0.9);
  const h = harness(true, t);
  await runSweReplay(h.pi, h.ctx, 2, "task");
  assert.equal(h.continuations.length, 1);
  assert.deepEqual(h.continuations[0].message, { customType: "swe-replay-continue", content: "", display: false });
  assert.deepEqual(h.continuations[0].options, { triggerTurn: true });
  assert.equal(h.continuations[0].file, "turn-0");
  assert.equal(readFileSync(join(h.ctx.cwd, "a"), "utf8"), "turn-1"); // Earliest passing patch wins the tie.
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
  assert.equal(snapshots.length, 5); // Root, original turns, replacement, and selected final state.
  const replacementFiles = h.entries.filter((entry) => entry.customType === "swe-replay-turn-files" && entry.data.iteration === 2);
  assert.equal(replacementFiles.length, 1);
  assert.deepEqual(replacementFiles[0].data.files, [join(h.ctx.cwd, "a"), join(h.ctx.cwd, "b")].sort());
  assert.equal(snapshots[3].data.stepId, replacementFiles[0].data.messageEntryId);
  assert.equal(snapshots[0].data.stepId, h.entries[0].id);
  assert.equal(h.ctx.sessionManager.getEntry(snapshots[1].data.stepId).message.role, "assistant");
  assert.equal(h.entries.filter((entry) => entry.customType === "swe-replay-workspace-backup").length, 2);
  const selected = h.ctx.sessionManager.getEntry(log.selection.stepId);
  const candidates = h.entries.filter((entry) => entry.customType === "swe-replay-candidate");
  assert.deepEqual(h.navigations, [
    { id: selected.parentId, options: { summarize: false } },
    { id: candidates[0].id, options: { summarize: false } },
  ]);
  const branch = h.ctx.sessionManager.getBranch(candidates[1].id); // The exploitation branch remains archived.
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
  const firstCandidate = h.entries.find((entry) => entry.customType === "swe-replay-candidate");
  assert.deepEqual(h.navigations, [
    { id: h.entries[0].id, options: { summarize: false } },
    { id: firstCandidate.id, options: { summarize: false } },
  ]);
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
  assert.equal(h.navigations.length, 2); // Explore, then align to the selected first occurrence.
  assert.deepEqual(h.startingFiles, ["initial", "initial"]);
  assert.equal(h.entries.some((entry) => entry.customType === "swe-replay-exploit-log"), false);
});

const records = (h, type) => h.entries.filter((entry) => entry.customType === type);

test("durable candidates precede evaluation; plurality restores an archived winner and its completed conversation", async (t) => {
  t.mock.method(Math, "random", () => 0.1);
  const h = harness(false, t, { contents: ["A", "B", "A", "failing final"] });
  writeFileSync(join(h.ctx.cwd, "staged-user"), "staged");
  h.git("add", "staged-user");
  writeFileSync(join(h.ctx.cwd, "staged-user"), "unstaged");
  writeFileSync(join(h.ctx.cwd, "untracked-user"), "keep me");
  const indexBefore = h.git("write-tree").toString().trim();
  let calls = 0;
  h.pi.exec = async () => {
    const candidates = records(h, "swe-replay-candidate");
    if (calls > 0) {
      assert.equal(candidates.length, calls);
      assert.equal(candidates.at(-1).data.iteration, calls);
      assert.ok(candidates.at(-1).data.snapshot.oid);
    }
    return { code: calls++ === 4 ? 1 : 0, killed: false, stdout: "private evidence", stderr: "" };
  };
  const result = await runSweReplay(h.pi, h.ctx, 4, "task");
  const candidates = records(h, "swe-replay-candidate");
  const selection = records(h, "swe-replay-final-selection")[0];
  assert.equal(result.selection.selectedCandidateEntryId, candidates[0].id);
  assert.equal(result.selection.groups[0].votes, 2);
  assert.equal(result.selection.eligibleCount, 3);
  assert.equal(result.restoration.status, "restored");
  assert.equal(readFileSync(join(h.ctx.cwd, "a"), "utf8"), "A");
  assert.equal(readFileSync(join(h.ctx.cwd, "staged-user"), "utf8"), "unstaged");
  assert.equal(readFileSync(join(h.ctx.cwd, "untracked-user"), "utf8"), "keep me");
  assert.equal(h.git("write-tree").toString().trim(), indexBefore);
  const active = new Set(h.ctx.sessionManager.getBranch().map((entry) => entry.id));
  assert.ok(active.has(candidates[0].id));
  assert.ok(!active.has(candidates[3].id));
  assert.ok(!active.has(selection.id)); // Selection remains durable on the archived final branch.
  const archive = readReplayArchive(JSON.parse(JSON.stringify(h.entries)), h.entries[0].id);
  assert.equal(archive.status, "available");
  assert.equal(completedSelectionInputs(archive.archive).length, 4);
  assert.deepEqual(selection.data.decision, result.selection);
  const restoration = records(h, "swe-replay-restoration").at(-1);
  assert.equal(restoration.data.selectionEntryId, selection.id);
  assert.ok(active.has(restoration.id));
  const evaluations = records(h, "swe-replay-evaluation");
  assert.equal(evaluations.length, 5); // Reused evaluations, no retesting.
  for (const [index, c] of candidates.entries()) {
    const evaluation = evaluations.find((e) => e.data.candidateEntryId === c.id);
    assert.equal(evaluation.data.snapshotOid, c.data.snapshot.oid);
    assert.equal(evaluation.data.iteration, index + 1);
    assert.ok(h.entries.indexOf(c) < h.entries.indexOf(evaluation));
  }
  assert.ok(h.entries.filter((e) => e.type === "custom_message").every((e) => e.customType === "swe-replay-continue"));
  assert.ok([...h.listeners.values()].every((handlers) => handlers.size === 0));
});

test("all failures and all raw-empty outcomes persist no-winner decisions without final restoration", async (t) => {
  t.mock.method(Math, "random", () => 0.1);
  for (const empty of [false, true]) {
    const h = harness(false, t, { contents: empty ? ["initial", "initial"] : ["A", "B"] });
    let calls = 0;
    h.pi.exec = async () => ({ code: empty || calls++ === 0 ? 0 : 1, killed: false, stdout: "", stderr: "" });
    const result = await runSweReplay(h.pi, h.ctx, 2, "task");
    assert.equal(result.selection.status, "no-valid-candidates");
    assert.equal(result.restoration, undefined);
    assert.equal(records(h, "swe-replay-final-selection").length, 1);
    assert.equal(records(h, "swe-replay-restoration").length, 0);
    assert.equal(h.navigations.length, 1); // Exploration only.
    assert.equal(readFileSync(join(h.ctx.cwd, "a"), "utf8"), empty ? "initial" : "B");
    assert.ok(result.selection.candidates.every((c) => c.exclusionReasons.includes(empty ? "raw-empty" : "regression-failed")));
  }
});

test("an aborted or errored generation stops without candidate evaluation, selection or winner restoration", async (t) => {
  for (const options of [{ abortIteration: 1 }, { stopReason: "error" }]) {
    const h = harness(false, t, options);
    await assert.rejects(runSweReplay(h.pi, h.ctx, 2, "task"), /aborted|did not complete/);
    assert.equal(records(h, "swe-replay-candidate").length, 0);
    assert.equal(records(h, "swe-replay-evaluation").length, 1);
    assert.equal(records(h, "swe-replay-final-selection").length, 0);
    assert.equal(records(h, "swe-replay-restoration").length, 0);
    assert.ok([...h.listeners.values()].every((handlers) => handlers.size === 0));
  }
});

test("normalization infrastructure errors preserve candidates and evaluations but never a partial selection", async (t) => {
  const h = harness(false, t);
  t.mock.method(ReplayWorkspace.prototype, "treeChanges", async () => { throw new Error("Git read failed"); });
  await assert.rejects(runSweReplay(h.pi, h.ctx, 1, "task"), /Git read failed/);
  assert.equal(records(h, "swe-replay-candidate").length, 1);
  assert.equal(records(h, "swe-replay-evaluation").length, 2);
  assert.equal(records(h, "swe-replay-patch-identity").length, 0);
  assert.equal(records(h, "swe-replay-final-selection").length, 0);
  assert.equal(records(h, "swe-replay-restoration").length, 0);
  assert.equal(records(h, "swe-replay-finalization-error")[0].data.phase, "normalization");
});

test("cancelled or redirected winner navigation cannot replace workspace files", async (t) => {
  t.mock.method(Math, "random", () => 0.1);
  for (const redirect of [false, true]) {
    const h = harness(false, t, { contents: ["A", "B"] });
    const navigate = h.ctx.navigateTree;
    h.ctx.navigateTree = async (id, options) => {
      if (h.ctx.sessionManager.getEntry(id)?.customType !== "swe-replay-candidate") return navigate(id, options);
      if (!redirect) return { cancelled: true };
      await navigate(id, options);
      h.append({ type: "custom", customType: "navigation-side-effect", data: {} });
      return { cancelled: false };
    };
    await assert.rejects(runSweReplay(h.pi, h.ctx, 2, "task"), /selected, but restoration failed/);
    assert.equal(readFileSync(join(h.ctx.cwd, "a"), "utf8"), "B");
    assert.equal(records(h, "swe-replay-final-selection").length, 1);
    const result = records(h, "swe-replay-restoration").at(-1).data;
    assert.equal(result.status, "failed");
    assert.equal(result.workspaceRecovery, "not-needed");
    assert.equal(result.contextRecovery, redirect ? "restored" : "not-needed");
    const attempt = records(h, "swe-replay-restoration")[0].data;
    assert.ok(attempt.backup.oid);
    assert.equal(attempt.status, "started");
  }
});

test("partial winner apply failure recovers both original workspace and conversation, without losing selection", async (t) => {
  t.mock.method(Math, "random", () => 0.1);
  const h = harness(false, t, { contents: ["A", "B"] });
  const restore = ReplayWorkspace.prototype.restore;
  t.mock.method(ReplayWorkspace.prototype, "restore", async function (snapshot, beforeMutation) {
    await restore.call(this, snapshot, beforeMutation);
    if (beforeMutation) throw new Error("Apply failed after mutation");
  });
  await assert.rejects(runSweReplay(h.pi, h.ctx, 2, "task"), /Apply failed after mutation/);
  assert.equal(readFileSync(join(h.ctx.cwd, "a"), "utf8"), "B");
  const selection = records(h, "swe-replay-final-selection")[0];
  assert.equal(selection.data.decision.status, "selected");
  const outcome = records(h, "swe-replay-restoration").at(-1).data;
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.workspaceRecovery, "restored");
  assert.equal(outcome.contextRecovery, "restored");
  assert.ok(h.ctx.sessionManager.getBranch().some((entry) => entry.id === selection.id));
});

test("failed recovery is recorded explicitly and never reported as successful restoration", async (t) => {
  const h = harness(false, t);
  const restore = ReplayWorkspace.prototype.restore;
  let recovery = false;
  t.mock.method(ReplayWorkspace.prototype, "restore", async function (snapshot, beforeMutation) {
    if (recovery) throw new Error("Recovery refused");
    await restore.call(this, snapshot, beforeMutation);
    if (beforeMutation) {
      recovery = true;
      throw new Error("Partial apply");
    }
  });
  await assert.rejects(runSweReplay(h.pi, h.ctx, 1, "task"), /Recovery failed.*Recovery refused/);
  const outcome = records(h, "swe-replay-restoration").at(-1).data;
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.workspaceRecovery, "failed");
  assert.equal(outcome.recoveryErrors.length, 1);
  assert.ok(outcome.backupEntryId);
});

test("changed HEAD refuses winner restoration before mutation and retains recovery evidence", async (t) => {
  const h = harness(false, t);
  const navigate = h.ctx.navigateTree;
  h.ctx.navigateTree = async (id, options) => {
    const result = await navigate(id, options);
    if (h.ctx.sessionManager.getEntry(id)?.customType === "swe-replay-candidate") h.git("commit", "--allow-empty", "-m", "external head change");
    return result;
  };
  await assert.rejects(runSweReplay(h.pi, h.ctx, 1, "task"), /HEAD has changed/);
  const outcome = records(h, "swe-replay-restoration").at(-1).data;
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.workspaceRecovery, "not-needed");
  assert.equal(readFileSync(join(h.ctx.cwd, "a"), "utf8"), "turn-0");
});

test("failed backup cannot navigate or apply a selected winner", async (t) => {
  const h = harness(false, t);
  const capture = ReplayWorkspace.prototype.capture;
  t.mock.method(ReplayWorkspace.prototype, "capture", async function (...args) {
    if (h.ctx.sessionManager.getLeafEntry()?.customType === "swe-replay-final-selection") throw new Error("Backup failed");
    return capture.apply(this, args);
  });
  await assert.rejects(runSweReplay(h.pi, h.ctx, 1, "task"), /Backup failed/);
  assert.equal(h.navigations.length, 0);
  assert.equal(records(h, "swe-replay-restoration").at(-1).data.status, "failed");
  assert.equal(records(h, "swe-replay-restoration").at(-1).data.backupEntryId, undefined);
});

test("overlapping runs and busy agents are rejected; aborted runs release their session lock", async (t) => {
  const h = harness(false, t, { abortIteration: 1 });
  const exec = h.pi.exec;
  let nested = false;
  h.pi.exec = async (...args) => {
    if (!nested) {
      nested = true;
      await assert.rejects(runSweReplay(h.pi, h.ctx, 1, "nested"), /already active/);
    }
    return exec(...args);
  };
  await assert.rejects(runSweReplay(h.pi, h.ctx, 1, "task"), /aborted/);
  await runSweReplay(h.pi, h.ctx, 1, "retry after interruption");
  assert.equal(records(h, "swe-replay-root").length, 2);
  h.ctx.isIdle = () => false;
  await assert.rejects(runSweReplay(h.pi, h.ctx, 1, "busy"), /become idle/);
  await assert.rejects(runSweReplay(h.pi, h.ctx, 0, "bad"), /positive iteration count/);
});

test("normalization-empty Python changes produce no winner and are not automatically rewritten", async (t) => {
  const h = harness(false, t, { contents: ["initial"], onTurn: ({ cwd }) => writeFileSync(join(cwd, "b.py"), "# cosmetic\nx=1\n") });
  writeFileSync(join(h.ctx.cwd, "b.py"), "x = 1\n");
  const result = await runSweReplay(h.pi, h.ctx, 1, "task");
  assert.equal(result.selection.status, "no-valid-candidates");
  assert.deepEqual(result.selection.candidates[0].exclusionReasons, ["normalization-empty"]);
  assert.equal(readFileSync(join(h.ctx.cwd, "b.py"), "utf8"), "# cosmetic\nx=1\n");
  assert.equal(records(h, "swe-replay-restoration").length, 0);
});

test("a candidate captured after an agent-created commit cannot bypass the initial run's HEAD guard", async (t) => {
  let h;
  h = harness(false, t, { onTurn: () => h.git("commit", "--allow-empty", "-m", "agent created commit") });
  await assert.rejects(runSweReplay(h.pi, h.ctx, 1, "task"), /HEAD has changed/);
  assert.equal(records(h, "swe-replay-final-selection").length, 1);
  assert.equal(h.navigations.length, 0);
  assert.equal(records(h, "swe-replay-restoration").at(-1).data.workspaceRecovery, "not-needed");
});

test("winner restoration refuses ignored-file collisions without overwriting the ignored data", async (t) => {
  t.mock.method(Math, "random", () => 0.1);
  const h = harness(false, t, { contents: ["A", "B"], onTurn: ({ cwd, prompts }) => {
    if (prompts === 1) writeFileSync(join(cwd, "winner-only"), "winner content");
  } });
  const navigate = h.ctx.navigateTree;
  h.ctx.navigateTree = async (id, options) => {
    const result = await navigate(id, options);
    if (h.ctx.sessionManager.getEntry(id)?.customType === "swe-replay-candidate") {
      writeFileSync(join(h.ctx.cwd, ".gitignore"), "winner-only\n");
      writeFileSync(join(h.ctx.cwd, "winner-only"), "ignored data");
    }
    return result;
  };
  await assert.rejects(runSweReplay(h.pi, h.ctx, 2, "task"), /Ignored files would obstruct/);
  assert.equal(readFileSync(join(h.ctx.cwd, "a"), "utf8"), "B");
  assert.equal(readFileSync(join(h.ctx.cwd, "winner-only"), "utf8"), "ignored data");
  assert.equal(records(h, "swe-replay-restoration").at(-1).data.workspaceRecovery, "not-needed");
});

test("the command reports selected/restored and no-winner outcomes without exporting evidence to model context", async (t) => {
  const { default: extension } = await jiti.import("../extensions/index.ts");
  for (const empty of [false, true]) {
    const h = harness(false, t, { contents: [empty ? "initial" : "A"] });
    const commands = new Map();
    h.pi.registerCommand = (name, options) => commands.set(name, options);
    extension(h.pi);
    h.ctx.hasUI = true;
    h.ctx.ui.input = async () => "true";
    const notices = [];
    h.ctx.ui.notify = (message, level) => notices.push({ message, level });
    await commands.get("swe-replay").handler("1 task", h.ctx);
    const notice = notices.at(-1);
    assert.equal(notice.level, empty ? "warning" : "info");
    assert.match(notice.message, empty ? /no regression-passing, nonempty patch qualified/ : /Selected iteration 1: 1 of 1 eligible votes/);
    assert.match(notice.message, empty ? /remain at the last iteration/ : /Workspace and conversation restored/);
    assert.equal(h.entries.filter((e) => e.type === "custom_message").length, 0);
    assert.equal(h.promptCount(), 1);
  }
});
