import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { readReplayArchive, assertReplayComplete, completedSelectionInputs, appendReplayRecord } = await jiti.import("../extensions/swe-replay/replay-records.ts");
const { finalizeReplay } = await jiti.import("../extensions/swe-replay/finalize-run.ts");
const { selectFinalPatch } = await jiti.import("../extensions/swe-replay/final-selection.ts");
const oid = (n, size = 40) => n.toString(16).padStart(size, "0");

function fixture() {
  const entries = [];
  const add = (id, parentId, customType, data) => {
    const entry = { id, parentId, timestamp: "2026-01-01T00:00:00.000Z", type: "custom", customType, data };
    entries.push(entry);
    return entry;
  };
  const snapshot = (stepId, n) => ({ rootEntryId: "root", stepId, oid: oid(n), ref: `refs/swe-replay/snapshot-${n}` });
  const tree = (snapshot, n) => ({ rootEntryId: "root", snapshotOid: snapshot.oid, treeOid: oid(n), ref: `refs/swe-replay/trees/${n}` });
  const initial = snapshot("root", 1);
  const baseTree = tree(initial, 2);
  const execution = { testCommand: "npm test", testTimeoutMs: 600000, cwd: "/repo" };
  add("root", null, "swe-replay-root", { schemaVersion: 1, prompt: "task", requestedPatchCount: 2, ...execution });
  add("base", "root", "swe-replay-base", { schemaVersion: 1, rootEntryId: "root", requestedCount: 2,
    snapshot: initial, tree: baseTree, baseTreeOid: baseTree.treeOid, ...execution });
  add("baseline", "base", "swe-replay-evaluation", { schemaVersion: 1, rootEntryId: "root", iteration: 0,
    terminalEntryId: "base", snapshotOid: initial.oid, status: "passed", exitCode: 0, killed: false,
    stdout: "private baseline", stderr: "", durationMs: 1, ...execution });
  for (const i of [1, 2]) {
    const terminalId = `terminal-${i}`;
    entries.push({ id: terminalId, parentId: "root", timestamp: "2026-01-01T00:00:00.000Z", type: "message",
      message: { role: "assistant", content: [], stopReason: "stop" } });
    const s = snapshot(terminalId, 10 + i);
    add(`candidate-${i}`, terminalId, "swe-replay-candidate", {
      schemaVersion: 1, rootEntryId: "root", iteration: i, terminalEntryId: terminalId, snapshot: s,
    });
    add(`evaluation-${i}`, `candidate-${i}`, "swe-replay-evaluation", {
      schemaVersion: 1, rootEntryId: "root", candidateEntryId: `candidate-${i}`, iteration: i,
      terminalEntryId: terminalId, snapshotOid: s.oid, status: "passed", exitCode: 0, killed: false,
      stdout: "private candidate", stderr: "", durationMs: 1, ...execution,
    });
    add(`identity-${i}`, "evaluation-2", "swe-replay-patch-identity", {
      schemaVersion: 1, rootEntryId: "root", candidateEntryId: `candidate-${i}`, tree: tree(s, 20 + i),
      normalization: {
        policy: "complete-tree-agentless-mixed-v1", baseTreeOid: baseTree.treeOid, candidateTreeOid: oid(20 + i),
        keyHash: oid(3, 64), rawEmpty: false, normalizationEmpty: false, diagnostics: [],
        python: { policy: "agentless-python-pyodide-v2", upstreamRevision: "5ce5888b9f149beaace393957a55ea8ee46c9f71",
          pyodideVersion: "314.0.7", pythonVersion: "3.14.2", gitDiffPolicy: "fixed-myers-three-context-v1" },
      },
    });
  }
  return { entries, entry: (id) => entries.find((e) => e.id === id) };
}

const codes = (result) => result.diagnostics.map((d) => d.code);
const read = (entries) => readReplayArchive(entries, "root");

test("append-only v1 associations round-trip across archived branches without leaf or storage-order inference", () => {
  const { entries } = fixture();
  const result = read(JSON.parse(JSON.stringify(entries)).reverse());
  assert.equal(result.status, "available");
  const candidates = completedSelectionInputs(result.archive);
  assert.equal(candidates.length, 2);
  const decision = selectFinalPatch(result.archive.base, candidates, result.archive.evaluations);
  assert.equal(decision.status, "selected");
  assert.equal(decision.groups[0].votes, 2);
  assert.equal(decision.selectedCandidateEntryId, "candidate-1");
});

test("appendReplayRecord captures IDs from the real Pi SessionManager API, not appendEntry's void return", () => {
  const sessionManager = SessionManager.inMemory("/repo");
  const pi = { appendEntry: (type, data) => { sessionManager.appendCustomEntry(type, data); } };
  const data = { schemaVersion: 1, value: 42 };
  const id = appendReplayRecord(pi, { sessionManager }, "test", data);
  assert.equal(sessionManager.getEntry(id).data, data);
  assert.throws(() => appendReplayRecord({ appendEntry: () => {} }, { sessionManager }, "other", data), /Could not identify/);
});

test("legacy or unsupported runs are unavailable rather than automatically migrated", () => {
  const { entries, entry } = fixture();
  delete entry("root").data.schemaVersion;
  assert.deepEqual(codes(read(entries)), ["unsupported-or-missing-root"]);
  entry("root").data.schemaVersion = 2;
  assert.deepEqual(codes(read(entries)), ["unsupported-or-missing-root"]);
  assert.deepEqual(codes(read([])), ["unsupported-or-missing-root"]);
});

test("missing or conflicting base and baseline evidence prevents automatic selection", () => {
  for (const change of [
    (f) => { f.entries.splice(f.entries.indexOf(f.entry("base")), 1); },
    (f) => { f.entry("baseline").data.status = "failed"; },
    (f) => { f.entry("baseline").data.testCommand = "different test"; },
    (f) => { f.entry("baseline").data.snapshotOid = oid(999); },
    (f) => { f.entry("base").data.tree.snapshotOid = oid(999); },
    (f) => { f.entry("base").data.requestedCount = 3; },
  ]) {
    const f = fixture();
    change(f);
    const result = read(f.entries);
    assert.equal(result.status, "unavailable");
    assert.ok(codes(result).some((code) => ["invalid-base", "missing-or-ambiguous-base", "missing-or-invalid-passing-baseline"].includes(code)));
  }
});

test("candidate snapshots and normalization trees must have explicit, exact associations", () => {
  for (const [change, code] of [
    [(f) => { f.entry("candidate-1").parentId = "root"; }, "invalid-candidate-association"],
    [(f) => { f.entry("candidate-1").data.snapshot.stepId = "other"; }, "invalid-candidate-association"],
    [(f) => { f.entry("identity-1").data.tree.snapshotOid = oid(999); }, "invalid-identity-link"],
    [(f) => { f.entry("identity-1").data.tree.treeOid = oid(999); }, "invalid-identity-link"],
    [(f) => { f.entry("identity-1").data.normalization.baseTreeOid = oid(999); }, "invalid-identity-link"],
    [(f) => { f.entry("identity-1").data.candidateEntryId = "missing"; }, "invalid-identity-link"],
    [(f) => { f.entry("evaluation-1").parentId = "root"; }, "invalid-evaluation-link"],
  ]) {
    const f = fixture();
    change(f);
    assert.ok(codes(read(f.entries)).includes(code), code);
  }
});

test("malformed and unsupported normalization/evaluation fields have specific diagnostics", () => {
  for (const change of [
    (f) => { f.entry("identity-1").data.normalization.policy = "future"; },
    ...["policy", "upstreamRevision", "pyodideVersion", "pythonVersion", "gitDiffPolicy"].map((field) =>
      (f) => { f.entry("identity-1").data.normalization.python[field] = "future"; }),
    (f) => { f.entry("identity-1").data.normalization.diagnostics = [{ kind: "unknown" }]; },
    (f) => { f.entry("identity-1").data.normalization.keyHash = "broken"; },
  ]) {
    const f = fixture();
    change(f);
    assert.ok(codes(read(f.entries)).includes("invalid-or-unsupported-patch-identity"));
  }
  const f = fixture();
  f.entry("evaluation-1").data.durationMs = -1;
  assert.ok(codes(read(f.entries)).includes("invalid-evaluation"));
});

test("payload shape errors retain record-specific diagnostics before association validation", () => {
  const malformed = [
    ["base", "requestedCount", "2", "invalid-base"],
    ["base", "snapshot", null, "invalid-base"],
    ["base", "tree", [], "invalid-base"],
    ["base", "baseTreeOid", "not-an-oid", "invalid-base"],
    ["base", "testCommand", " ", "invalid-base"],
    ["base", "testTimeoutMs", 0, "invalid-base"],
    ["base", "cwd", "", "invalid-base"],
    ["candidate-1", "iteration", 1.5, "invalid-candidate-association"],
    ["candidate-1", "terminalEntryId", "", "invalid-candidate-association"],
    ["candidate-1", "snapshot", {}, "invalid-candidate-association"],
    ["identity-1", "candidateEntryId", null, "invalid-or-unsupported-patch-identity"],
    ["identity-1", "tree", null, "invalid-or-unsupported-patch-identity"],
    ["identity-1", "normalization", {}, "invalid-or-unsupported-patch-identity"],
    ["evaluation-1", "iteration", "1", "invalid-evaluation"],
    ["evaluation-1", "status", "unknown", "invalid-evaluation"],
    ["evaluation-1", "terminalEntryId", "", "invalid-evaluation"],
    ["evaluation-1", "snapshotOid", "not-an-oid", "invalid-evaluation"],
    ["evaluation-1", "stdout", null, "invalid-evaluation"],
    ["evaluation-1", "stderr", 0, "invalid-evaluation"],
    ["evaluation-1", "durationMs", Infinity, "invalid-evaluation"],
    ["evaluation-1", "exitCode", "0", "invalid-evaluation"],
    ["evaluation-1", "killed", 0, "invalid-evaluation"],
    ["evaluation-1", "error", {}, "invalid-evaluation"],
    ["evaluation-1", "testCommand", "", "invalid-evaluation"],
    ["evaluation-1", "testTimeoutMs", -1, "invalid-evaluation"],
    ["evaluation-1", "cwd", null, "invalid-evaluation"],
    ["evaluation-1", "candidateEntryId", undefined, "invalid-evaluation"],
    ["baseline", "candidateEntryId", "candidate-1", "invalid-evaluation"],
  ];

  for (const [entryId, field, value, code] of malformed) {
    const f = fixture();
    f.entry(entryId).data[field] = value;
    const result = read(f.entries);
    assert.equal(result.status, "unavailable", `${entryId}.${field}`);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code && diagnostic.entryId === entryId),
      `${entryId}.${field}: expected ${code}`);
  }
});

test("typed payload parsing preserves extra fields and absent optional execution evidence", () => {
  const { entries, entry } = fixture();
  for (const id of ["base", "candidate-1", "identity-1", "evaluation-1"]) {
    entry(id).data.extraMetadata = { retained: true };
  }
  const evidence = entry("evaluation-1").data;
  evidence.status = "inconclusive";
  delete evidence.exitCode;
  delete evidence.killed;

  const result = read(entries);
  assert.equal(result.status, "available");
  const { archive } = result;
  assert.deepEqual(archive.base, { ...entry("base").data, entryId: "base" });
  assert.deepEqual(archive.candidates.find((record) => record.entryId === "candidate-1"),
    { ...entry("candidate-1").data, entryId: "candidate-1" });
  assert.deepEqual(archive.identities.find((record) => record.entryId === "identity-1"),
    { ...entry("identity-1").data, entryId: "identity-1" });
  assert.deepEqual(archive.evaluations.find((record) => record.entryId === "evaluation-1").evaluation, evidence);
});

test("wrong-root, nested-root, cyclic and duplicate entry associations cannot masquerade as run candidates", () => {
  const f = fixture();
  f.entries.push({ id: "nested-root", parentId: "root", type: "custom", customType: "swe-replay-root", data: { schemaVersion: 1 } });
  f.entry("candidate-1").parentId = "nested-root";
  assert.ok(codes(read(f.entries)).includes("record-outside-run"));
  const cycle = fixture();
  cycle.entry("terminal-1").parentId = "candidate-1";
  assert.ok(codes(read(cycle.entries)).includes("record-outside-run"));
  const duplicate = fixture();
  duplicate.entries.push(structuredClone(duplicate.entry("candidate-1")));
  assert.deepEqual(codes(read(duplicate.entries)), ["duplicate-session-entry"]);
});

test("an interrupted candidate remains inspectable but cannot create a partial final selection", () => {
  const { entries } = fixture();
  const partial = entries.filter((e) => !["identity-1", "identity-2", "evaluation-1", "evaluation-2", "candidate-2", "terminal-2"].includes(e.id));
  const result = read(partial);
  assert.equal(result.status, "available");
  assert.equal(result.archive.candidates.length, 1);
  assert.throws(() => completedSelectionInputs(result.archive), /incomplete or inconclusive/);
  const f = fixture();
  f.entry("evaluation-1").data.status = "inconclusive";
  assert.throws(() => completedSelectionInputs(read(f.entries).archive), /incomplete or inconclusive/);
  const noIdentity = fixture();
  noIdentity.entries.splice(noIdentity.entries.indexOf(noIdentity.entry("identity-1")), 1);
  assert.throws(() => completedSelectionInputs(read(noIdentity.entries).archive), /Missing or ambiguous patch identity/);
});

test("completion is independent of patch identities and permits failed evaluated candidates", () => {
  const { archive } = read(fixture().entries);
  archive.identities = [];
  archive.evaluations[1].evaluation.status = "failed";
  archive.evaluations[1].evaluation.exitCode = 1;

  assert.doesNotThrow(() => assertReplayComplete(archive));
  assert.throws(() => completedSelectionInputs(archive), /Missing or ambiguous patch identity/);
});

test("completion and selection-input construction reject the same incomplete or inconclusive archives", () => {
  const changes = [
    (archive) => { archive.candidates.pop(); },
    (archive) => { archive.candidates[1].iteration = 1; },
    (archive) => { archive.evaluations.pop(); },
    (archive) => { archive.evaluations[1].candidateEntryId = "candidate-1"; },
    (archive) => { archive.evaluations[1].evaluation.status = "inconclusive"; },
  ];
  const error = { message: "Replay archive is incomplete or inconclusive; final selection is unavailable." };

  for (const change of changes) {
    const { archive } = read(fixture().entries);
    change(archive);
    assert.throws(() => assertReplayComplete(archive), error);
    assert.throws(() => completedSelectionInputs(archive), error);
  }
});

test("finalization applies the completion policy before any normalization work", async () => {
  const changes = [
    (entries) => entries.filter((entry) => !["candidate-2", "terminal-2", "evaluation-2"].includes(entry.id)),
    (entries) => entries.filter((entry) => entry.id !== "evaluation-2"),
    (entries) => {
      entries.find((entry) => entry.id === "evaluation-2").data.status = "inconclusive";
      return entries;
    },
  ];

  for (const change of changes) {
    const entries = change(fixture().entries.filter((entry) => entry.customType !== "swe-replay-patch-identity"));
    const ctx = {
      sessionManager: { getEntries: () => entries, getLeafEntry: () => entries.at(-1) },
      ui: { notify: () => assert.fail("Incomplete archives must not start normalization") },
    };
    const pi = {
      appendEntry: (customType, data) => entries.push({
        id: "finalization-error", parentId: entries.at(-1).id, type: "custom", customType, data,
      }),
    };
    const workspace = { contentTree: () => assert.fail("Incomplete archives must not read content trees") };

    await assert.rejects(finalizeReplay(pi, ctx, workspace, "root"), /incomplete or inconclusive/);
    assert.equal(entries.at(-1).customType, "swe-replay-finalization-error");
    assert.equal(entries.at(-1).data.phase, "archive");
  }
});

test("candidate execution mismatches remain exclusions in the captured voter decision, not silently repaired evidence", () => {
  const { entries, entry } = fixture();
  entry("evaluation-1").data.snapshotOid = oid(999);
  entry("evaluation-2").data.testCommand = "wrong command";
  const { archive } = read(entries);
  const decision = selectFinalPatch(archive.base, completedSelectionInputs(archive), archive.evaluations);
  assert.equal(decision.status, "no-valid-candidates");
  assert.deepEqual(decision.candidates.map((c) => c.exclusionReasons), [["evaluation-association-mismatch"], ["evaluation-command-mismatch"]]);
});
