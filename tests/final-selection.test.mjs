import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { selectFinalPatch } = await jiti.import("../extensions/swe-replay/final-selection.ts");
const hex = (value, length = 40) => value.toString(16).padStart(length, "0");
const scope = {
  rootEntryId: "root", baseTreeOid: hex(1), testCommand: "npm ci && npm test", testTimeoutMs: 600000, cwd: "/repo",
};

function candidate(iteration, group = 1) {
  return {
    entryId: `candidate-${iteration}`, rootEntryId: "root", iteration, terminalEntryId: `terminal-${iteration}`,
    snapshot: { rootEntryId: "root", stepId: `terminal-${iteration}`, oid: hex(100 + iteration), ref: `refs/swe-replay/${iteration}` },
    normalization: {
      policy: "complete-tree-agentless-mixed-v1", baseTreeOid: scope.baseTreeOid, candidateTreeOid: hex(200 + iteration),
      keyHash: hex(group, 64), rawEmpty: false, normalizationEmpty: false, diagnostics: [],
      python: {
        policy: "agentless-python-pyodide-v2", upstreamRevision: "5ce5888b9f149beaace393957a55ea8ee46c9f71",
        pyodideVersion: "314.0.7", pythonVersion: "3.14.2", gitDiffPolicy: "fixed-myers-three-context-v1",
      },
    },
  };
}

function evaluation(c, status = "passed") {
  return {
    entryId: `evaluation-${c.entryId}`, candidateEntryId: c.entryId,
    testCommand: scope.testCommand, testTimeoutMs: scope.testTimeoutMs, cwd: scope.cwd,
    evaluation: {
      rootEntryId: c.rootEntryId, iteration: c.iteration, terminalEntryId: c.terminalEntryId,
      snapshotOid: c.snapshot.oid, status,
      ...(status === "inconclusive" ? { killed: true } : { exitCode: status === "passed" ? 0 : 1, killed: false }),
    },
  };
}

const decide = (candidates, evaluations = candidates.map((c) => evaluation(c))) => selectFinalPatch(scope, candidates, evaluations);
const reasons = (result, id) => result.candidates.find((c) => c.candidateEntryId === id).exclusionReasons;
const codes = (result) => result.diagnostics.map((d) => d.code);

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("plurality counts passing occurrences, not unique trees, reasoning scores or exploitation multiplicity", () => {
  const candidates = [candidate(1, 1), candidate(2, 2), candidate(3, 1), candidate(4, 1), candidate(5, 3), candidate(6, 4)];
  candidates[0].multiplicity = 100;
  candidates[1].reasoningScore = 100;
  const result = decide(candidates, candidates.map((c) => evaluation(c, c.iteration === 3 ? "failed" : "passed")));
  assert.equal(result.status, "selected");
  assert.equal(result.selectedCandidateEntryId, "candidate-1");
  assert.equal(result.selectedKeyHash, hex(1, 64));
  assert.equal(result.eligibleCount, 5); // Plurality wins with 2/5, not an absolute majority.
  assert.deepEqual(result.groups.map((g) => [g.keyHash, g.votes, g.iterations]), [
    [hex(1, 64), 2, [1, 4]], [hex(2, 64), 1, [2]], [hex(3, 64), 1, [5]], [hex(4, 64), 1, [6]],
  ]);
  assert.deepEqual(reasons(result, "candidate-3"), ["regression-failed"]);
  assert.deepEqual(result.tiedGroupKeyHashes, []);
  assert.deepEqual(result.policy, {
    voting: "passing-candidate-occurrences-v1", equivalence: "complete-tree-agentless-mixed-v1", tieBreak: "earliest-passing-iteration",
  });
});

test("ties and representative selection use earliest passing iteration, independent of storage order", () => {
  const candidates = [candidate(1, 2), candidate(2, 1), candidate(3, 1), candidate(4, 2), candidate(5, 2)];
  const evaluations = candidates.map((c) => evaluation(c, c.iteration === 1 ? "failed" : "passed"));
  const result = decide(candidates, evaluations);
  assert.equal(result.selectedCandidateEntryId, "candidate-2");
  assert.deepEqual(result.tiedGroupKeyHashes, [hex(1, 64), hex(2, 64)]);
  assert.equal(result.groups[1].representativeCandidateEntryId, "candidate-4");
  assert.deepEqual(decide([...candidates].reverse(), [...evaluations].reverse()), result);
  const unique = decide([candidate(5, 5), candidate(3, 3), candidate(1, 1)]);
  assert.equal(unique.selectedCandidateEntryId, "candidate-1");
  assert.equal(unique.tiedGroupKeyHashes.length, 3);
});

test("failed, inconclusive, unevaluated, raw-empty, and normalization-empty candidates are excluded distinctly", () => {
  const candidates = Array.from({ length: 5 }, (_, i) => candidate(i + 1));
  candidates[3].normalization.rawEmpty = true;
  candidates[3].normalization.normalizationEmpty = true;
  candidates[3].normalization.candidateTreeOid = scope.baseTreeOid;
  candidates[4].normalization.normalizationEmpty = true;
  const evaluations = [evaluation(candidates[0], "failed"), evaluation(candidates[1], "inconclusive"),
    evaluation(candidates[3]), evaluation(candidates[4])];
  const result = decide(candidates, evaluations);
  assert.equal(result.status, "no-valid-candidates");
  assert.ok(!("selectedCandidateEntryId" in result));
  assert.ok(!("selectedKeyHash" in result));
  assert.deepEqual(result.groups, []);
  assert.equal(result.eligibleCount, 0);
  for (const [index, reason] of ["regression-failed", "regression-inconclusive", "unevaluated", "raw-empty", "normalization-empty"].entries()) {
    assert.deepEqual(reasons(result, `candidate-${index + 1}`), [reason]);
  }
  assert.equal(decide([]).status, "no-valid-candidates");
});

test("each occurrence requires its own passing evidence even for identical snapshots and patch hashes", () => {
  const first = candidate(1);
  const second = candidate(2);
  second.snapshot.oid = first.snapshot.oid;
  second.normalization.candidateTreeOid = first.normalization.candidateTreeOid;
  const result = decide([first, second], [evaluation(first)]);
  assert.equal(result.eligibleCount, 1);
  assert.deepEqual(reasons(result, second.entryId), ["unevaluated"]);
});

test("identical candidate/evaluation records and aliases count once per iteration", () => {
  const first = candidate(1);
  const alias = { ...structuredClone(first), entryId: "alias" };
  alias.normalization.diagnostics.push({ kind: "exact-content-fallback", path: "a.py", pythonType: "SyntaxError", message: "diagnostic only" });
  const e = evaluation(first);
  const aliasEvaluation = evaluation(alias);
  const candidates = [first, structuredClone(first), alias, candidate(2)];
  const evaluations = [e, structuredClone(e), aliasEvaluation, evaluation(candidates[3])];
  const result = decide(candidates, evaluations);
  assert.equal(result.eligibleCount, 2);
  assert.equal(result.selectedCandidateEntryId, "alias");
  assert.deepEqual(result.groups[0].candidateEntryIds, ["alias", "candidate-2"]);
  assert.equal(result.candidates.find((c) => c.candidateEntryId === first.entryId).status, "duplicate");
  assert.ok(codes(result).includes("duplicate-candidate"));
  assert.ok(codes(result).includes("duplicate-evaluation"));
  assert.deepEqual(decide([...candidates].reverse(), [...evaluations].reverse()), result);
});

test("an unevaluated duplicate alias cannot become the representative of an evaluated occurrence", () => {
  const c = candidate(1);
  const alias = { ...structuredClone(c), entryId: "aaa-unevaluated" };
  const result = decide([alias, c], [evaluation(c)]);
  assert.equal(result.eligibleCount, 1);
  assert.equal(result.selectedCandidateEntryId, c.entryId);
  assert.equal(result.candidates.find((record) => record.candidateEntryId === alias.entryId).status, "duplicate");
});

test("conflicting candidates poison the entire iteration instead of choosing a convenient record", () => {
  for (const sameId of [false, true]) {
    const first = candidate(1);
    const conflict = candidate(1, 2);
    if (!sameId) conflict.entryId = "conflict";
    const result = decide([first, conflict, candidate(2)]);
    assert.equal(result.selectedCandidateEntryId, "candidate-2");
    assert.equal(result.eligibleCount, 1);
    assert.ok(reasons(result, first.entryId).includes("conflicting-candidate-records"));
    assert.ok(codes(result).includes("conflicting-candidate-records"));
  }
});

test("a reused candidate ID spanning runs or iterations cannot vote", () => {
  const first = candidate(1);
  for (const other of [candidate(2), { ...candidate(1), rootEntryId: "other-root" }]) {
    other.entryId = first.entryId;
    const result = decide([first, other]);
    assert.equal(result.eligibleCount, 0);
    assert.ok(codes(result).includes("conflicting-candidate-records"));
  }
});

test("conflicting evaluations and evaluation IDs reused across associations cannot create votes", () => {
  const first = candidate(1);
  const passed = evaluation(first);
  const failed = evaluation(first, "failed");
  failed.entryId = "failed-record";
  const result = decide([first], [passed, failed]);
  assert.equal(result.status, "no-valid-candidates");
  assert.ok(reasons(result, first.entryId).includes("conflicting-evaluation-records"));
  const second = candidate(2);
  const reused = evaluation(second);
  reused.entryId = passed.entryId;
  const both = decide([first, second], [passed, reused]);
  assert.equal(both.eligibleCount, 0);
  for (const c of [first, second]) assert.ok(reasons(both, c.entryId).includes("conflicting-evaluation-records"));
});

test("evaluations must match root, iteration, terminal, snapshot and the frozen execution contract", () => {
  const c = candidate(1);
  for (const [field, value] of [["rootEntryId", "other"], ["iteration", 2], ["terminalEntryId", "other"], ["snapshotOid", hex(999)]]) {
    const e = evaluation(c);
    e.evaluation[field] = value;
    const result = decide([c], [e]);
    assert.equal(result.status, "no-valid-candidates");
    assert.deepEqual(reasons(result, c.entryId), ["evaluation-association-mismatch"]);
  }
  for (const [field, value] of [["testCommand", "other test"], ["testTimeoutMs", 1], ["cwd", "/other"]]) {
    const e = evaluation(c);
    e[field] = value;
    assert.deepEqual(reasons(decide([c], [e]), c.entryId), ["evaluation-command-mismatch"]);
  }
  const orphan = evaluation(c);
  orphan.candidateEntryId = "missing";
  const result = decide([c], [orphan]);
  assert.deepEqual(reasons(result, c.entryId), ["unevaluated"]);
  assert.ok(codes(result).includes("orphan-evaluation"));
});

test("unsupported policies and provenance are unavailable, never reinterpreted or grouped", () => {
  for (const [field, value] of [["policy", "old"], ["upstreamRevision", "other"], ["pyodideVersion", "next"],
    ["pythonVersion", "next"], ["gitDiffPolicy", "other"]]) {
    const c = candidate(1);
    c.normalization.python[field] = value;
    assert.deepEqual(reasons(decide([c]), c.entryId), ["unsupported-normalization"]);
  }
  const c = candidate(1);
  c.normalization.policy = "future-mixed-policy";
  assert.deepEqual(reasons(decide([c]), c.entryId), ["unsupported-normalization"]);
});

test("malformed candidate fields and baseline iterations have specific diagnostics", () => {
  const changes = [
    (c) => { c.iteration = 0; },
    (c) => { c.iteration = 1.5; },
    (c) => { c.iteration = NaN; },
    (c) => { c.iteration = Infinity; },
    (c) => { c.snapshot.rootEntryId = "other"; },
    (c) => { c.snapshot.stepId = "other"; },
    (c) => { c.snapshot.oid = "not-an-oid"; },
    (c) => { c.normalization.keyHash = "invalid"; },
    (c) => { c.normalization.rawEmpty = true; },
    (c) => { c.normalization.candidateTreeOid = scope.baseTreeOid; },
  ];
  for (const change of changes) {
    const c = candidate(1);
    change(c);
    const result = decide([c]);
    assert.equal(result.status, "no-valid-candidates");
    assert.ok(reasons(result, c.entryId).includes("invalid-candidate"));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
  const wrongRun = candidate(1);
  wrongRun.rootEntryId = "other";
  wrongRun.snapshot.rootEntryId = "other";
  assert.deepEqual(reasons(decide([wrongRun]), wrongRun.entryId), ["wrong-run"]);
  const wrongBase = candidate(1);
  wrongBase.normalization.baseTreeOid = hex(999);
  assert.deepEqual(reasons(decide([wrongBase]), wrongBase.entryId), ["base-tree-mismatch"]);
});

test("passing status is insufficient when execution evidence is contradictory or missing", () => {
  const c = candidate(1);
  for (const change of [
    (e) => { delete e.evaluation.exitCode; },
    (e) => { e.evaluation.exitCode = 1; },
    (e) => { e.evaluation.killed = true; },
    (e) => { e.evaluation.error = "execution failed"; },
    (e) => { e.evaluation.status = "unknown"; },
  ]) {
    const e = evaluation(c);
    change(e);
    assert.deepEqual(reasons(decide([c], [e]), c.entryId), ["invalid-evaluation"]);
  }
});

test("shared terminals, archived branches and terminals with descendants remain independent completed occurrences", () => {
  const candidates = [candidate(1), candidate(2), candidate(3, 2)];
  candidates[1].terminalEntryId = candidates[0].terminalEntryId;
  candidates[1].snapshot.stepId = candidates[0].terminalEntryId;
  // The voter deliberately has no active-branch, leaf-only or ancestry input.
  const result = decide(candidates);
  assert.equal(result.groups[0].votes, 2);
  assert.deepEqual(result.groups[0].iterations, [1, 2]);
  assert.equal(result.eligibleCount, 3);
});

test("decisions are JSON-safe detached captures and selection has no random or input-mutating effects", () => {
  const candidates = freeze([candidate(2), candidate(1)]);
  const evaluations = freeze(candidates.map((c) => evaluation(c)));
  const oldRandom = Math.random;
  Math.random = () => { throw new Error("selection must not sample"); };
  let result;
  try {
    result = selectFinalPatch(freeze(structuredClone(scope)), candidates, evaluations);
  } finally {
    Math.random = oldRandom;
  }
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  const saved = structuredClone(result);
  result.groups[0].candidateEntryIds.push("external edit");
  assert.deepEqual(decide(candidates, evaluations), saved);
});

test("conflict and exclusion captures do not depend on candidate/evaluation ordering", () => {
  const first = candidate(1);
  const alias = { ...structuredClone(first), entryId: "alias" };
  alias.normalization.baseTreeOid = hex(999);
  alias.normalization.policy = "unsupported";
  const second = candidate(2);
  const passed = evaluation(first);
  const failed = evaluation(alias, "failed");
  const orphan = evaluation(candidate(3));
  const candidates = [first, alias, second];
  const evaluations = [passed, failed, orphan];
  const expected = decide(candidates, evaluations);
  for (const order of [[0, 1, 2], [2, 0, 1], [1, 2, 0], [2, 1, 0]]) {
    assert.deepEqual(decide(order.map((i) => candidates[i]), order.map((i) => evaluations[i])), expected);
  }
});

test("mixed assessments preserve the full decision capture while only eligible iterations add votes", () => {
  const first = candidate(1);
  const alias = { ...structuredClone(first), entryId: "alias" };
  const second = candidate(2, 2);
  const third = candidate(3, 2);
  const failed = evaluation(alias, "failed");
  failed.testCommand = "different command";
  const candidates = [third, first, second, alias];
  const evaluations = [evaluation(third), evaluation(first), failed, evaluation(second)];
  const exclusionReasons = ["conflicting-evaluation-records", "evaluation-command-mismatch", "regression-failed"];
  const excludedEvaluationIds = ["evaluation-alias", "evaluation-candidate-1"];

  const expected = {
    rootEntryId: scope.rootEntryId,
    baseTreeOid: scope.baseTreeOid,
    policy: {
      voting: "passing-candidate-occurrences-v1",
      equivalence: "complete-tree-agentless-mixed-v1",
      tieBreak: "earliest-passing-iteration",
    },
    candidates: [
      ...["alias", "candidate-1"].map((candidateEntryId) => ({
        candidateEntryId, iteration: 1, status: "excluded", exclusionReasons,
        canonicalCandidateEntryId: "alias", evaluationEntryIds: excludedEvaluationIds,
      })),
      ...[2, 3].map((iteration) => ({
        candidateEntryId: `candidate-${iteration}`, iteration, status: "eligible", exclusionReasons: [],
        canonicalCandidateEntryId: `candidate-${iteration}`, evaluationEntryIds: [`evaluation-candidate-${iteration}`],
      })),
    ],
    groups: [{
      keyHash: hex(2, 64), candidateEntryIds: ["candidate-2", "candidate-3"], iterations: [2, 3], votes: 2,
      representativeCandidateEntryId: "candidate-2", representativeIteration: 2,
    }],
    eligibleCount: 2,
    tiedGroupKeyHashes: [],
    diagnostics: exclusionReasons.map((code) => ({
      code, candidateEntryIds: ["alias", "candidate-1"], evaluationEntryIds: excludedEvaluationIds,
    })),
    status: "selected",
    selectedCandidateEntryId: "candidate-2",
    selectedKeyHash: hex(2, 64),
  };

  assert.deepEqual(decide(candidates, evaluations), expected);
  assert.deepEqual(decide([...candidates].reverse(), [...evaluations].reverse()), expected);
});

test("invalid run scope fails explicitly rather than returning a misleading no-winner result", () => {
  for (const overrides of [{ rootEntryId: "" }, { baseTreeOid: "HEAD" }, { testCommand: " " }, { testTimeoutMs: 0 }, { cwd: "" }]) {
    assert.throws(() => selectFinalPatch({ ...scope, ...overrides }, [], []), /Invalid final-selection scope/);
  }
});
