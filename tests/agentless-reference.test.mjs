import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const inputs = JSON.parse(readFileSync(new URL("./fixtures/agentless-normalization-input.json", import.meta.url)));
const reference = JSON.parse(readFileSync(new URL("./fixtures/agentless-normalization-expected.json", import.meta.url)));
const byId = new Map(reference.cases.map((entry) => [entry.id, entry]));
const key = (id) => {
  const entry = byId.get(id);
  assert.equal(typeof entry?.key, "string", `missing key for ${id}`);
  return entry.key;
};

// These assert properties of the captured oracle, not compatibility of a production
// normalizer (which is not implemented yet). Reuse the corpus for differential tests.
test("Agentless reference corpus is complete, uniquely identified, and pinned", () => {
  assert.equal(reference.upstreamRevision, "5ce5888b9f149beaace393957a55ea8ee46c9f71");
  assert.equal(reference.sourceSha256, "9ddd0f53dbdf696d4d4726d0f05f92073db7795cb62b441dbeb5f66146d05462");
  assert.equal(reference.referencePythonVersion, "3.14.4");
  assert.equal(reference.gitDiffPolicy, "fixed-myers-three-context-v1");
  assert.equal(byId.size, reference.cases.length);
  assert.equal(new Set(inputs.map((entry) => entry.id)).size, inputs.length);
  assert.deepEqual(reference.cases.map((entry) => entry.id), inputs.map((entry) => entry.id));

  for (const entry of reference.cases) {
    assert.notEqual(typeof entry.key === "string", typeof entry.errorType === "string", entry.id);
  }
});

test("reference removes cosmetic changes but preserves meaningful paths and syntax changes", () => {
  for (const id of ["raw-empty-short-circuit", "formatting-and-comments", "quote-style", "docstring-change"]) {
    assert.equal(key(id), "", id);
  }

  assert.equal(key("constant-change"), key("constant-change-formatted"));
  assert.notEqual(key("constant-change"), "");
  assert.notEqual(key("constant-change"), key("constant-change-different-path"));
  assert.match(key("docstring-only-paired-fallback"), /old/);
  assert.match(key("docstring-only-paired-fallback"), /new/);
});

test("reference added-function rule removes context but preserves upstream EOF and global-change quirks", () => {
  assert.equal(key("added-function-before-interior"), key("added-function-after-interior"));
  assert.notEqual(key("added-function-before"), key("added-function-after"));

  for (const id of ["added-function-before", "added-function-and-global-change", "added-async-method"]) {
    assert.ok(key(id).split("\n").every((line) => line.startsWith("+") || line.startsWith("-")), id);
  }

  assert.match(key("added-function-and-global-change"), /-x = 1\n\+x = 2/);
  assert.match(key("added-and-modified-function"), /@@/);
  assert.match(key("removed-function"), /@@/);
  assert.match(key("nested-function-modifies-outer"), /@@/);
});

test("reference records unsafe assumptions requiring explicit production policy", () => {
  assert.equal(byId.get("invalid-python").errorType, "SyntaxError");
  assert.notEqual(key("multiple-files"), key("multiple-files-reversed"));
  assert.equal(key("new-empty-python-file"), "");
  assert.equal(key("new-comment-only-python-file"), "");
  assert.match(key("python-314-template-string"), /t'\{value\}'/);
});
