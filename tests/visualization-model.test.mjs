import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { archive, root, step, snapshot, decision, selectionTrace } from "./fixtures/replay.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { buildReplayView, replayRoots, replaySummary } = await jiti.import("../extensions/swe-replay/visualization-model.ts");

function freeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

test("projects pre-step states, ancestry, scores, selections, and active branch without side effects", (t) => {
  t.mock.method(Math, "random", () => { throw new Error("inspection must not draw"); });
  const entries = freeze(archive());
  const view = buildReplayView(entries, "root", ["root", "b1", "t1", "b2", "t2"]);
  assert.equal(view.prompt, undefined);
  assert.equal(view.requestedCount, undefined);
  assert.deepEqual(view.steps.map((step) => [step.id, step.parentStepId, step.filesBefore, step.active]), [
    ["a1", undefined, [], false],
    ["a2", "a1", ["/repo/a"], false],
    ["b1", undefined, [], true],
    ["b2", "b1", ["/repo/a"], true],
  ]);
  assert.deepEqual(view.steps.find((step) => step.id === "b2").selectedIn, [3]);
  assert.equal(view.steps.find((step) => step.id === "b2").reasoningScore, 3);
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.decisions[0].outcome, "step-selected");
  assert.ok(!JSON.stringify(view).includes("Private reasoning"));
  const summary = replaySummary(view);
  assert.match(summary, /requested iterations: unknown/);
  assert.match(summary, /step-selected/);
  assert.match(summary, /Decisions record selection, not generation completion/);
  assert.doesNotMatch(summary, /selected-only|Selection-only|no replacement branch/);
});

test("historical distributions use captured membership, unaffected by future candidates", () => {
  const entries = archive();
  const before = buildReplayView(entries, "root").decisions;
  entries.push(step("a3", "s1", 8), snapshot("s3", "a3", "a3", ["/repo/a"], 4));
  const view = buildReplayView(entries, "root");
  assert.deepEqual(view.decisions, before);
  const state = view.decisions[0].states[0];
  assert.equal(state.probability, 1);
  assert.deepEqual(state.candidates.map((candidate) => candidate.probability), selectionTrace().candidates.map((candidate) => candidate.probability));
  assert.equal(view.decisions[0].probabilitySource, "recorded");
});

test("follows ancestry independently of array order and deduplicates shared prefix steps", () => {
  const entries = archive();
  entries.push(
    snapshot("shared-copy", "s1", "a1", ["/repo/a"], 4),
    step("fork", "s1"), snapshot("fork-snapshot", "fork", "fork", ["/repo/a"], 4),
  );
  const view = buildReplayView(entries.reverse(), "root");
  assert.equal(view.steps.filter((step) => step.id === "a1").length, 1);
  assert.deepEqual(view.steps.find((step) => step.id === "a1").iterations, [1, 4]);
  assert.equal(view.steps.find((step) => step.id === "fork").parentStepId, "a1");
  assert.deepEqual(view.steps.find((step) => step.id === "fork").filesBefore, ["/repo/a"]);
});

test("isolates sibling/nested runs, including falsely attributed snapshots and decisions", () => {
  const entries = archive();
  entries.push(
    root("nested", "s2"), step("n1", "nested"), snapshot("n-snapshot", "n1", "n1", ["/nested"], 1, "nested"),
    snapshot("wrong-root", "n-snapshot", "n1", ["/wrong"]),
    decision("nested-decision", "n-snapshot", { rootEntryId: "nested", iteration: 2 }),
    root("sibling"), step("x1", "sibling"), snapshot("x-snapshot", "x1", "x1", ["/x"], 1, "sibling"),
  );
  assert.equal(replayRoots(entries).length, 3);
  assert.equal(buildReplayView(entries, "root").steps.length, 4);
  assert.equal(buildReplayView(entries, "root").decisions.length, 1);
  assert.deepEqual(buildReplayView(entries, "nested").steps.map((step) => step.id), ["n1"]);
  assert.equal(buildReplayView(entries, "nested").decisions.length, 1);
});

test("no-eligible-states fallback projects as one exploration-fallback decision", () => {
  const entries = archive();
  const before = buildReplayView(entries, "root");
  entries.push(decision("fallback", "s2", {
    rootEntryId: "root", iteration: 4, states: [], selection: null, trace: null,
    fallbackReason: "no-eligible-states",
  }));

  const view = buildReplayView(entries, "root");
  const added = view.decisions.filter((item) => item.id === "fallback");
  assert.equal(view.decisions.length, before.decisions.length + 1);
  assert.equal(added.length, 1);
  assert.equal(added[0].outcome, "explore-fallback");
  assert.equal(added[0].fallbackReason, "no-eligible-states");
  assert.equal(added[0].selectedStepId, undefined);
  assert.equal(added[0].probabilitySource, "unavailable");
  assert.deepEqual(added[0].states, []);
  assert.deepEqual(view.diagnostics, []);
  assert.match(replaySummary(view), /no-eligible-states/);
});

test("malformed decisions remain inspectable and produce diagnostics", () => {
  const entries = archive();
  entries.push(
    decision("missing-data", "s2", undefined),
    decision("bad-groups", "s2", { rootEntryId: "root", iteration: 5, states: [{ files: [42] }] }),
  );

  const view = buildReplayView(entries, "root");
  assert.equal(view.decisions.length, 3);
  for (const id of ["missing-data", "bad-groups"]) {
    const malformed = view.decisions.find((item) => item.id === id);
    assert.ok(malformed, `Decision ${id} should remain visible.`);
    assert.equal(malformed.outcome, "unknown");
    assert.equal(malformed.probabilitySource, "unavailable");
    assert.deepEqual(malformed.states, []);
    assert.ok(view.diagnostics.includes(`Decision ${id} has incomplete candidate groups.`));
  }
});

test("malformed snapshots do not supply pre-step file state", () => {
  const entries = archive();
  entries.push(
    snapshot("bad-snapshot", "s2", "missing", ["/a"]),
    snapshot("bad-files", "s2", "a2", [42]),
    step("after-bad", "bad-files"), snapshot("after-bad-snapshot", "after-bad", "after-bad", ["/a"]),
  );

  const view = buildReplayView(entries, "root");
  const subsequent = view.steps.find((item) => item.id === "after-bad");
  assert.ok(subsequent);
  assert.equal(subsequent.filesBefore, undefined);
  assert.ok(!view.steps.some((item) => item.id === "missing"));
  assert.ok(view.diagnostics.includes("Invalid step reference in snapshot bad-snapshot."));
  assert.ok(view.diagnostics.includes("Malformed turn snapshot bad-files."));
});

test("missing replay roots produce a diagnostic", () => {
  const view = buildReplayView(archive(), "missing");
  assert.deepEqual(view.steps, []);
  assert.deepEqual(view.decisions, []);
  assert.deepEqual(view.diagnostics, ["Replay root is missing or invalid."]);
});

test("cycles, cross-branch references, and invalid assistant content do not crash projection", () => {
  const entries = archive();
  entries.push(
    snapshot("cross-branch", "s2", "b2", ["/wrong"]),
    root("cycle-root", "cycle-root"),
    step("invalid-content", "s2"), snapshot("invalid-snapshot", "invalid-content", "invalid-content", ["/a"]),
  );
  entries.find((entry) => entry.id === "invalid-content").message.content = null;
  const view = buildReplayView(entries, "root");
  assert.equal(view.steps.find((step) => step.id === "invalid-content").reasoningScore, undefined);
  assert.ok(view.diagnostics.some((message) => message.includes("cross-branch")));
  assert.equal(buildReplayView(entries, "cycle-root").steps.length, 0);
});

test("recorded distributions and scores survive changed or missing assistant reasoning", () => {
  const entries = archive();
  // Deliberately non-reconstructed probabilities prove the UI does not run selection math.
  entries.at(-1).data.trace.candidates[0].probability = 0.4;
  entries.at(-1).data.trace.candidates[1].probability = 0.6;
  const before = buildReplayView(entries, "root").decisions;
  entries.find((entry) => entry.id === "b2").message.content = [];
  entries.splice(entries.findIndex((entry) => entry.id === "a2"), 1);
  const after = buildReplayView(entries, "root");
  assert.deepEqual(after.decisions, before);
  assert.deepEqual(after.decisions[0].states[0].candidates.map((candidate) => candidate.score), [1, 3]);
  assert.deepEqual(after.decisions[0].states[0].candidates.map((candidate) => candidate.probability), [0.4, 0.6]);
  assert.ok(after.diagnostics.some((message) => message.includes("a2")));
});

test("invalid, unsupported, or inconsistent traces are unavailable, not reconstructed", () => {
  for (const change of [
    (trace) => { trace.policyVersion = 999; },
    (trace) => { trace.states[0].probability = NaN; },
    (trace) => { trace.selectedStepId = "a2"; }, // Conflicts with legacy selection.
    (trace) => { trace.candidates[1].reasoningScore = 9; }, // Conflicts with recorded score.
  ]) {
    const entries = archive();
    change(entries.at(-1).data.trace);
    const view = buildReplayView(entries, "root");
    assert.equal(view.decisions[0].probabilitySource, "unavailable");
    assert.equal(view.decisions[0].states[0].probability, undefined);
    assert.ok(view.decisions[0].states[0].candidates.every((candidate) => candidate.probability === undefined));
    assert.ok(view.diagnostics.some((message) => message.includes("selection trace")));
  }
});
