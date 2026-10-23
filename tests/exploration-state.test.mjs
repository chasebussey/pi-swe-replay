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

const archivedEligibility = new Map(["a1", "a2", "a3", "b1", "b2"].map((id) => [id, 1]));

test("groups archived steps by pre-step file sets, skipping empty states", () => {
  const entries = archive();
  assert.deepEqual(rollUpExplorationStates(entries, "root", archivedEligibility), [
    { files: ["/a"], candidates: [{ stepId: "a2", multiplicity: 1 }] },
    { files: ["/a", "/b"], candidates: [{ stepId: "a3", multiplicity: 1 }, { stepId: "b2", multiplicity: 1 }] },
  ]);
  assert.deepEqual(entries[8].data.files, ["/b", "/a", "/a"]);
});

test("filters eligibility before grouping while retaining ancestors for pre-step state", () => {
  assert.deepEqual(rollUpExplorationStates(archive(), "root", new Map([["a3", 1]])), [
    { files: ["/a", "/b"], candidates: [{ stepId: "a3", multiplicity: 1 }] },
  ]);
  assert.deepEqual(rollUpExplorationStates(archive(), "root", new Map()), []);
});

test("follows parent IDs rather than storage order and deduplicates repeated snapshots", () => {
  const entries = archive();
  entries.push(snapshot("duplicate", "s3", "a3", ["/different"]));
  const eligible = new Map([
    ["a2", 1],
    ["a3", 2],
    ["b2", 1],
  ]);

  const states = rollUpExplorationStates(entries.reverse(), "root", eligible);
  const sharedState = states.find((state) => state.files.length === 2);
  const singleFileState = states.find((state) => state.files.length === 1);

  assert.deepEqual(sharedState?.files, ["/a", "/b"]);
  assert.deepEqual(sharedState?.candidates.toSorted((a, b) => a.stepId.localeCompare(b.stepId)), [
    { stepId: "a3", multiplicity: 2 },
    { stepId: "b2", multiplicity: 1 },
  ]);
  assert.deepEqual(singleFileState?.files, ["/a"]);
  assert.deepEqual(singleFileState?.candidates, [{ stepId: "a2", multiplicity: 1 }]);
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
  const eligible = new Map([
    ...archivedEligibility,
    ...["other1", "other2", "missing", "s1", "orphan"].map((id) => [id, 1]),
  ]);

  assert.deepEqual(rollUpExplorationStates(entries, "root", eligible), rollUpExplorationStates(archive(), "root", archivedEligibility));
  assert.deepEqual(rollUpExplorationStates(entries, "other", eligible), [
    { files: ["/other"], candidates: [{ stepId: "other2", multiplicity: 1 }] },
  ]);
  assert.deepEqual(rollUpExplorationStates(entries, "missing-root", eligible), []);
});

test("ignores malformed snapshots and steps without a completed-turn snapshot", () => {
  const entries = archive();
  entries.push(
    step("unfinished", "s3"),
    { ...snapshot("bad", "s3", "unfinished", [42]) },
    { id: "empty", type: "custom", customType: "swe-replay-turn-files" },
  );
  const eligible = new Map([...archivedEligibility, ["unfinished", 1]]);

  assert.deepEqual(rollUpExplorationStates(entries, "root", eligible), rollUpExplorationStates(archive(), "root", archivedEligibility));
});
