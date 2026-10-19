import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { selectionTrace } from "./fixtures/replay.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { selectExploitationStep } = await jiti.import("../extensions/swe-replay/select-step.ts");
const { parseSelectionTrace } = await jiti.import("../extensions/swe-replay/selection-trace.ts");

function select(draw) {
  const states = [
    { files: ["/a"], candidateStepIds: ["a"] },
    { files: ["/b"], candidateStepIds: ["b", "c"] },
  ];
  const scores = { b: 0, c: 2 };
  const lookups = [];
  const session = { getEntry: (id) => {
    lookups.push(id);
    assert.notEqual(id, "a", "unselected states must not be scored");
    return { id, type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: Array(scores[id]).fill("Reasoning.").join("\n\n") },
    ] } };
  } };
  const draws = [0.99, draw];
  const result = selectExploitationStep(states, session, () => {
    assert.ok(draws.length > 0, "trace capture must not consume extra random draws");
    return draws.shift();
  });
  assert.equal(draws.length, 0);
  return { states, result, lookups };
}

test("trace captures both distributions actually used, including all state memberships", () => {
  const boundary = 1 / (1 + Math.exp(2));
  for (const [draw, expected] of [[boundary - 1e-9, "b"], [boundary + 1e-9, "c"]]) {
    const { result, lookups } = select(draw);
    const trace = JSON.parse(JSON.stringify(result.trace));
    assert.deepEqual(parseSelectionTrace(trace), trace);
    assert.equal(trace.policyVersion, 1);
    assert.equal(trace.eligibilityPolicy, "all-recorded-completed-steps");
    assert.equal(trace.selectedStateIndex, 1);
    assert.equal(trace.selectedStepId, expected);
    assert.equal(result.stepId, expected);
    assert.deepEqual(trace.states.map((state) => state.candidateStepIds), [["a"], ["b", "c"]]);
    assert.ok(Math.abs(trace.states[0].probability - 1 / (1 + Math.exp(-0.5))) < 1e-15);
    assert.ok(Math.abs(trace.candidates[0].probability - boundary) < 1e-15);
    assert.deepEqual(trace.candidates.map((candidate) => candidate.reasoningScore), [0, 2]);
    assert.deepEqual(lookups, ["b", "c"]);
  }
});

test("trace is a detached, JSON-safe snapshot of mutable state groups", () => {
  const { states, result } = select(0.99);
  const before = JSON.parse(JSON.stringify(result.trace));
  states[0].files.push("/later");
  states[1].candidateStepIds.push("later");
  assert.deepEqual(result.trace, before);
  const parsed = parseSelectionTrace(before);
  parsed.states[0].files.push("/ui-change");
  assert.notDeepEqual(parsed, before);
  assert.deepEqual(result.trace, before);
});

test("trace parsing rejects unsupported, malformed, and inconsistent records without recomputing", () => {
  for (const invalid of [undefined, null, [], {}, { policyVersion: 999 }]) {
    assert.equal(parseSelectionTrace(invalid), undefined);
  }
  for (const corrupt of [
    (trace) => { trace.policyVersion = 2; },
    (trace) => { trace.eligibilityPolicy = "unknown"; },
    (trace) => { trace.selectedStateIndex = -1; },
    (trace) => { trace.selectedStateIndex = 0.5; },
    (trace) => { trace.selectedStateIndex = 5; },
    (trace) => { trace.selectedStepId = "missing"; },
    (trace) => { trace.states[0].files = []; },
    (trace) => { trace.states[0].probability = Infinity; },
    (trace) => { trace.states[0].probability = 0.5; },
    (trace) => { trace.states[0].candidateStepIds = ["a2", "a2"]; },
    (trace) => { trace.states.push(structuredClone(trace.states[0])); },
    (trace) => { trace.candidates.pop(); },
    (trace) => { trace.candidates.reverse(); },
    (trace) => { trace.candidates[0].reasoningScore = -1; },
    (trace) => { trace.candidates[0].reasoningScore = 1.5; },
    (trace) => { trace.candidates[0].probability = NaN; },
    (trace) => { trace.candidates[0].probability = -0.1; },
    (trace) => { trace.candidates[0].probability = 0; trace.candidates[1].probability = 1; trace.selectedStepId = "a2"; },
  ]) {
    const trace = selectionTrace();
    corrupt(trace);
    assert.equal(parseSelectionTrace(trace), undefined);
  }
});

test("zero probabilities from softmax underflow are valid if the chosen candidate has positive mass", () => {
  const trace = selectionTrace();
  trace.candidates[0].probability = 0;
  trace.candidates[1].probability = 1;
  assert.deepEqual(parseSelectionTrace(trace), trace);
});
