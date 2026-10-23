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
  { files: ["/a"], candidates: [{ stepId: "a", multiplicity: 1 }] },
  { files: ["/b"], candidates: ["b", "c", "d"].map((stepId) => ({ stepId, multiplicity: 1 })) },
];
const session = sessionWith({ a: 0, b: 0, c: 0, d: 0 });

test("samples states using softmax of inverse group size, not uniform or flattened steps", () => {
  const boundary = Math.exp(1) / (Math.exp(1) + Math.exp(1 / 3));
  assert.equal(selectExploitationStep(states, session, draws(boundary - 1e-9, 0)).stepId, "a");
  assert.equal(selectExploitationStep(states, session, draws(boundary + 1e-9, 0)).stepId, "b");
  assert.equal(selectExploitationStep(states, session, draws(0, 0)).state, states[0]);
});

test("samples within the chosen state using softmax of paragraph counts", () => {
  const state = {
    files: ["/a"],
    candidates: ["short", "long"].map((stepId) => ({ stepId, multiplicity: 1 })),
  };
  const session = sessionWith({ short: 1, long: 3 });
  const boundary = Math.exp(1) / (Math.exp(1) + Math.exp(3));
  for (const [draw, stepId, score] of [[boundary - 1e-9, "short", 1], [boundary + 1e-9, "long", 3]]) {
    const result = selectExploitationStep([state], session, draws(0, draw));
    assert.equal(result.state, state);
    assert.equal(result.stepId, stepId);
    assert.equal(result.reasoningScore, score);
    assert.equal(result.trace.selectedStepId, stepId);
    assert.ok(Math.abs(result.trace.candidates[0].probability - boundary) < 1e-15);
  }
});

test("zero reasoning scores give uniform step probabilities when multiplicities are equal", () => {
  const state = {
    files: ["/b"],
    candidates: ["b", "c", "d"].map((stepId) => ({ stepId, multiplicity: 1 })),
  };

  for (const [draw, expected] of [[0, "b"], [0.34, "c"], [1 - Number.EPSILON, "d"]]) {
    const result = selectExploitationStep([state], session, draws(0, draw));
    assert.equal(result.stepId, expected);
    for (const candidate of result.trace.candidates) {
      assert.ok(Math.abs(candidate.probability - 1 / 3) < 1e-15);
    }
  }
});

test("zero reasoning scores give step probabilities proportional to multiplicity", () => {
  const state = {
    files: ["/b"],
    candidates: [
      { stepId: "b", multiplicity: 1 },
      { stepId: "c", multiplicity: 3 },
    ],
  };

  for (const [draw, expected] of [[0.25 - 1e-9, "b"], [0.25 + 1e-9, "c"]]) {
    const result = selectExploitationStep([state], session, draws(0, draw));
    assert.equal(result.stepId, expected);
    assert.ok(Math.abs(result.trace.candidates[0].probability - 0.25) < 1e-15);
    assert.ok(Math.abs(result.trace.candidates[1].probability - 0.75) < 1e-15);
  }
});

test("uses numerically stable softmax even for very large paragraph counts", () => {
  const state = {
    files: ["/a"],
    candidates: ["low", "high"].map((stepId) => ({ stepId, multiplicity: 1 })),
  };
  const session = sessionWith({ low: 1000, high: 1001 });
  const boundary = 1 / (1 + Math.E);
  assert.equal(selectExploitationStep([state], session, draws(0, boundary - 1e-9)).stepId, "low");
  assert.equal(selectExploitationStep([state], session, draws(0, boundary + 1e-9)).stepId, "high");
  // The first weight underflows to zero; a draw of zero must still skip it.
  assert.equal(selectExploitationStep([state], sessionWith({ low: 0, high: 1000 }), draws(0, 0)).stepId, "high");
});

test("skips empty states and returns undefined without drawing if none are eligible", () => {
  const empty = [
    { files: [], candidates: [{ stepId: "missing", multiplicity: 1 }] },
    { files: ["/empty"], candidates: [] },
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
    { files: ["/a"], candidates: [{ stepId: "missing", multiplicity: 1 }] },
  ], session, draws(0)), /assistant message entry: missing/);
  for (const value of [-0.1, 1, NaN, Infinity]) {
    assert.throws(() => selectExploitationStep(states, session, draws(value)), /Selection RNG/);
    assert.throws(() => selectExploitationStep(states, session, draws(0, value)), /Selection RNG/);
  }
});
