import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Use Pi's installed TypeScript loader, without emitting build artifacts.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { rollUpExplorationStates } = await jiti.import("../extensions/swe-replay/exploration-state.ts");

const root = (id = "root", parentId = null) => ({
  id, parentId, type: "custom", customType: "swe-replay-root",
});
const step = (id, parentId) => ({
  id, parentId, type: "message", message: { role: "assistant" },
});
const snapshot = (id, parentId, messageEntryId, files, rootEntryId = "root") => ({
  id, parentId, type: "custom", customType: "swe-replay-turn-files",
  data: { rootEntryId, iteration: 1, turnIndex: 0, messageEntryId, files },
});

function archive() {
  return [
    root(),
    step("a1", "root"), snapshot("s1", "a1", "a1", ["/a"]),
    step("a2", "s1"), snapshot("s2", "a2", "a2", ["/a", "/b"]),
    step("a3", "s2"), snapshot("s3", "a3", "a3", ["/a", "/b"]),
    // A fresh sibling branch must not inherit a3's files.
    step("b1", "root"), snapshot("t1", "b1", "b1", ["/b", "/a", "/a"]),
    step("b2", "t1"), snapshot("t2", "b2", "b2", ["/a", "/b", "/c"]),
  ];
}

test("groups archived steps by pre-step file sets, skipping empty states", () => {
  const entries = archive();
  assert.deepEqual(rollUpExplorationStates(entries, "root"), [
    { files: ["/a"], candidateStepIds: ["a2"] },
    { files: ["/a", "/b"], candidateStepIds: ["a3", "b2"] },
  ]);
  assert.deepEqual(entries[8].data.files, ["/b", "/a", "/a"]);
});

test("follows parent IDs rather than storage order and deduplicates concrete steps", () => {
  const entries = archive();
  entries.push(snapshot("duplicate", "s3", "a3", ["/different"]));
  const states = rollUpExplorationStates(entries.reverse(), "root");
  assert.deepEqual(states.find((state) => state.files.length === 2)?.candidateStepIds.sort(), ["a3", "b2"]);
  assert.deepEqual(states.find((state) => state.files.length === 1)?.candidateStepIds, ["a2"]);
});

test("isolates roots, rejects dangling/non-assistant IDs, and excludes nested runs", () => {
  const entries = archive();
  entries.push(
    root("other", "s3"),
    step("other1", "other"), snapshot("o1", "other1", "other1", ["/other"], "other"),
    step("other2", "o1"), snapshot("o2", "other2", "other2", ["/other"], "other"),
    snapshot("dangling", "s3", "missing", ["/a"]),
    snapshot("not-message", "s3", "s1", ["/a"]),
    snapshot("wrong-root", "o2", "other2", ["/a"]),
    step("orphan", "missing"), snapshot("orphan-snapshot", "orphan", "orphan", ["/a"]),
  );
  assert.deepEqual(rollUpExplorationStates(entries, "root"), rollUpExplorationStates(archive(), "root"));
  assert.deepEqual(rollUpExplorationStates(entries, "other"), [
    { files: ["/other"], candidateStepIds: ["other2"] },
  ]);
  assert.deepEqual(rollUpExplorationStates(entries, "missing-root"), []);
});

test("ignores malformed snapshots and steps without a completed-turn snapshot", () => {
  const entries = archive();
  entries.push(
    step("unfinished", "s3"),
    { ...snapshot("bad", "s3", "unfinished", [42]) },
    { id: "empty", type: "custom", customType: "swe-replay-turn-files" },
  );
  assert.deepEqual(rollUpExplorationStates(entries, "root"), rollUpExplorationStates(archive(), "root"));
});
