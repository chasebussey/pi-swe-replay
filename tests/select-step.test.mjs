import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { selectExploitationStep } = await jiti.import("../extensions/swe-replay/select-step.ts");

function sessionWith(scores) {
  return {
    getEntry: (id) => id in scores ? {
      id, type: "message", message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: Array(scores[id]).fill("Thought.").join("\n\n") }],
      },
    } : undefined,
  };
}

function draws(...values) {
  return () => {
    assert.ok(values.length > 0, "unexpected RNG call");
    return values.shift();
  };
}

const states = [
  { files: ["/a"], candidateStepIds: ["a"] },
  { files: ["/b"], candidateStepIds: ["b", "c", "d"] },
];
const session = sessionWith({ a: 0, b: 0, c: 0, d: 0 });

test("samples states using softmax of inverse group size, not uniform or flattened steps", () => {
  const boundary = Math.exp(1) / (Math.exp(1) + Math.exp(1 / 3));
  assert.equal(selectExploitationStep(states, session, draws(boundary - 1e-9, 0)).stepId, "a");
  assert.equal(selectExploitationStep(states, session, draws(boundary + 1e-9, 0)).stepId, "b");
  assert.equal(selectExploitationStep(states, session, draws(0, 0)).state, states[0]);
});

test("samples within the chosen state using softmax of paragraph counts", () => {
  const state = { files: ["/a"], candidateStepIds: ["short", "long"] };
  const session = sessionWith({ short: 1, long: 3 });
  const boundary = Math.exp(1) / (Math.exp(1) + Math.exp(3));
  assert.deepEqual(selectExploitationStep([state], session, draws(0, boundary - 1e-9)), {
    state, stepId: "short", reasoningScore: 1,
  });
  assert.deepEqual(selectExploitationStep([state], session, draws(0, boundary + 1e-9)), {
    state, stepId: "long", reasoningScore: 3,
  });
});

test("zero reasoning scores give uniform step probabilities", () => {
  for (const [draw, expected] of [[0, "b"], [0.34, "c"], [1 - Number.EPSILON, "d"]]) {
    assert.equal(selectExploitationStep([states[1]], session, draws(0, draw)).stepId, expected);
  }
});

test("uses numerically stable softmax even for very large paragraph counts", () => {
  const state = { files: ["/a"], candidateStepIds: ["low", "high"] };
  const session = sessionWith({ low: 1000, high: 1001 });
  const boundary = 1 / (1 + Math.E);
  assert.equal(selectExploitationStep([state], session, draws(0, boundary - 1e-9)).stepId, "low");
  assert.equal(selectExploitationStep([state], session, draws(0, boundary + 1e-9)).stepId, "high");
  // The first weight underflows to zero; a draw of zero must still skip it.
  assert.equal(selectExploitationStep([state], sessionWith({ low: 0, high: 1000 }), draws(0, 0)).stepId, "high");
});

test("skips empty states and returns undefined without drawing if none are eligible", () => {
  const empty = [
    { files: [], candidateStepIds: ["missing"] },
    { files: ["/empty"], candidateStepIds: [] },
  ];
  assert.equal(selectExploitationStep([], session, draws()), undefined);
  assert.equal(selectExploitationStep(empty, session, draws()), undefined);
  const before = structuredClone([...empty, ...states]);
  const input = structuredClone(before);
  assert.equal(selectExploitationStep(input, session, draws(0, 0)).stepId, "a");
  assert.deepEqual(input, before);
});

test("invalid candidate references and out-of-range random values fail explicitly", () => {
  assert.throws(() => selectExploitationStep([
    { files: ["/a"], candidateStepIds: ["missing"] },
  ], session, draws(0)), /assistant message entry: missing/);
  for (const value of [-0.1, 1, NaN, Infinity]) {
    assert.throws(() => selectExploitationStep(states, session, draws(value)), /Selection RNG/);
    assert.throws(() => selectExploitationStep(states, session, draws(0, value)), /Selection RNG/);
  }
});
