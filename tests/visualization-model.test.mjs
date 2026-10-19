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

test("legacy decisions keep probabilities unavailable and use only recorded scores", () => {
  const entries = archive();
  entries.push(decision("broken", "s2", {
    rootEntryId: "root", iteration: 4,
    states: [{ files: ["/repo/a"], candidateStepIds: ["a2", "missing"] }],
    selection: { stepId: "missing", reasoningScore: 5 },
  }));
  const view = buildReplayView(entries, "root");
  const state = view.decisions[1].states[0];
  assert.equal(state.probability, undefined); // Membership is not a recorded distribution.
  assert.equal(view.decisions[1].probabilitySource, "unavailable");
  assert.match(view.decisions[1].traceNote, /no selection trace/);
  assert.equal(state.candidates[0].score, undefined);
  assert.equal(state.candidates[1].score, 5);
  assert.deepEqual(state.candidates.map((candidate) => candidate.probability), [undefined, undefined]);
  assert.ok(view.diagnostics.some((message) => message.includes("missing")));
});

test("legacy/malformed records degrade to diagnostics; fallback remains one decision", () => {
  const entries = archive();
  entries.push(
    decision("legacy", "s2", undefined),
    decision("fallback", "s2", { rootEntryId: "root", iteration: 4, states: [], selection: null, fallbackReason: "no-eligible-states" }),
    decision("bad-groups", "s2", { rootEntryId: "root", iteration: 5, states: [{ files: [42] }] }),
    snapshot("bad-snapshot", "s2", "missing", ["/a"]),
    snapshot("bad-files", "s2", "a2", [42]),
    step("after-bad", "bad-files"), snapshot("after-bad-snapshot", "after-bad", "after-bad", ["/a"]),
  );
  const view = buildReplayView(entries, "root");
  assert.equal(view.decisions.length, 4);
  assert.equal(view.decisions[1].outcome, "unknown");
  assert.equal(view.decisions[2].outcome, "explore-fallback");
  assert.equal(view.steps.find((step) => step.id === "after-bad").filesBefore, undefined);
  assert.ok(view.diagnostics.length >= 3);
  assert.match(replaySummary(view), /no-eligible-states/);
  assert.match(buildReplayView(entries, "missing").diagnostics[0], /root is missing/);
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
