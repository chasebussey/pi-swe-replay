import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { reasoningScore } = await jiti.import("../extensions/swe-replay/reasoning-score.ts");

const thinking = (text) => ({ type: "thinking", thinking: text });
function sessionWith(content) {
  return {
    getEntry: (id) => id === "step"
      ? { id, type: "message", message: { role: "assistant", content } }
      : undefined,
  };
}

test("looks up the requested step and counts reasoning paragraphs, not lines or length", () => {
  const session = sessionWith([thinking("First paragraph.\nStill the first.\n\nSecond paragraph.\n\nThird.")]);
  assert.equal(reasoningScore("step", session), 3);
  assert.equal(reasoningScore("step", sessionWith([thinking("A long thought. ".repeat(1000))])), 1);
});

test("handles blank-line whitespace, repeated separators, and Windows/CR line endings", () => {
  for (const separator of ["\n\n", "\n \t\n", "\n\n\n\n", "\r\n\r\n", "\r\r"]) {
    assert.equal(reasoningScore("step", sessionWith([thinking(`\n  First.${separator}Second.  \n`)])), 2);
  }
});

test("sums separate thinking blocks and ignores assistant text and tool calls", () => {
  const session = sessionWith([
    thinking("First.\n\nSecond."),
    { type: "text", text: "Explanation.\n\nAnother explanation." },
    { type: "toolCall", id: "call", name: "read", arguments: { path: "file" } },
    thinking("Third."),
  ]);
  assert.equal(reasoningScore("step", session), 3);
});

test("scores absent, empty, and redacted reasoning as zero", () => {
  for (const content of [
    [],
    [{ type: "text", text: "Final answer." }],
    [thinking(""), thinking(" \n\t\r\n ")],
    [{ ...thinking("Hidden.\n\nHidden too."), redacted: true, thinkingSignature: "opaque" }],
    [{ ...thinking(""), thinkingSignature: "opaque" }],
  ]) {
    assert.equal(reasoningScore("step", sessionWith(content)), 0);
  }
  assert.equal(reasoningScore("step", sessionWith([
    { ...thinking("Hidden."), redacted: true }, thinking("Visible."),
  ])), 1);
});

test("rejects missing IDs and entries that are not assistant messages", () => {
  assert.throws(() => reasoningScore("missing", sessionWith([])), /assistant message entry: missing/);
  for (const entry of [
    { type: "custom", customType: "swe-replay-turn-files" },
    { type: "message", message: { role: "user", content: "Task" } },
    { type: "message", message: { role: "toolResult", content: [] } },
  ]) {
    assert.throws(() => reasoningScore("invalid", { getEntry: () => entry }), /assistant message entry: invalid/);
  }
});
