import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { ReplayWorkspace } = await jiti.import("../extensions/swe-replay/workspace.ts");
const { evaluateSnapshot, eligibleStepIds } = await jiti.import("../extensions/swe-replay/evaluation.ts");

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "replay-evaluation-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  mkdirSync(join(cwd, "subdir"));
  writeFileSync(join(cwd, "subdir/a"), "initial");
  writeFileSync(join(cwd, ".gitignore"), "ignored\n");
  git("add", ".");
  git("commit", "-qm", "initial");
  return { cwd, git };
}

test("evaluation materializes staged, unstaged, and untracked state without changing the search checkout", async (t) => {
  const { cwd, git } = repository(t);
  writeFileSync(join(cwd, "subdir/a"), "staged");
  git("add", ".");
  writeFileSync(join(cwd, "subdir/a"), "unstaged");
  writeFileSync(join(cwd, "subdir/new"), "untracked");
  writeFileSync(join(cwd, "ignored"), "not copied");
  const before = git("status", "--porcelain");
  const workspace = await ReplayWorkspace.open(cwd);
  const snapshot = await workspace.capture("root", "step");
  let evaluationCwd;
  const pi = { exec: async (shell, args, options) => {
    evaluationCwd = options.cwd;
    assert.equal(shell, "bash");
    assert.deepEqual(args, ["-lc", "user command"]);
    assert.equal(options.timeout, 600_000);
    assert.equal(readFileSync(join(options.cwd, "a"), "utf8"), "unstaged");
    assert.equal(readFileSync(join(options.cwd, "new"), "utf8"), "untracked");
    assert.equal(existsSync(join(options.cwd, "../ignored")), false);
    assert.equal(execFileSync("git", ["show", ":subdir/a"], { cwd: options.cwd, encoding: "utf8" }), "staged");
    writeFileSync(join(options.cwd, "a"), "test side effect");
    return { code: 0, killed: false, stdout: "passed", stderr: "" };
  } };
  const result = await evaluateSnapshot(pi, workspace, snapshot, join(cwd, "subdir"), "user command", 1, "terminal");
  assert.equal(result.status, "passed");
  assert.equal(result.snapshotOid, snapshot.oid);
  assert.equal(result.stdout, "passed");
  assert.equal(existsSync(evaluationCwd), false);
  assert.equal(git("status", "--porcelain"), before);
  assert.equal(readFileSync(join(cwd, "subdir/a"), "utf8"), "unstaged");
  assert.equal(git("worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
});

for (const [name, response, expected] of [
  ["nonzero", { code: 1, killed: false, stdout: "x".repeat(20_000), stderr: "failure" }, "failed"],
  ["killed", { code: 0, killed: true, stdout: "", stderr: "" }, "inconclusive"],
  ["exception", new Error("cannot execute"), "inconclusive"],
]) {
  test(`evaluation handles ${name} and still removes the disposable worktree`, async (t) => {
    const { cwd, git } = repository(t);
    const workspace = await ReplayWorkspace.open(cwd);
    const snapshot = await workspace.capture("root", "step");
    const pi = { exec: async () => {
      if (response instanceof Error) throw response;
      return response;
    } };
    const result = await evaluateSnapshot(pi, workspace, snapshot, cwd, "test", 1, "terminal");
    assert.equal(result.status, expected);
    assert.ok(result.stdout.length <= 16_000);
    if (name === "exception") assert.match(result.error, /cannot execute/);
    assert.equal(git("worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
  });
}

test("eligibility includes passing shared prefixes but not failed-only branches or other roots", () => {
  const custom = (id, parentId, customType = "other") => ({ id, parentId, type: "custom", customType });
  const entries = [
    custom("root", null, "swe-replay-root"), custom("shared", "root"),
    custom("pass", "shared"), custom("fail", "shared"),
    custom("nested", "shared", "swe-replay-root"), custom("other", "nested"),
  ];
  assert.deepEqual([...eligibleStepIds(entries, "root", ["pass", "other"])].sort(), ["pass", "shared"]);
  assert.deepEqual([...eligibleStepIds(entries, "root", [])], []);
});
