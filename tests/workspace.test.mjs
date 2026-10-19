import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { ReplayWorkspace, preStepSnapshot } = await jiti.import("../extensions/swe-replay/workspace.ts");

async function repo(t) {
  const cwd = mkdtempSync(join(tmpdir(), "replay-workspace-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  const write = (file, text) => writeFileSync(join(cwd, file), text);
  const read = (file) => readFileSync(join(cwd, file), "utf8");
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  write("a", "base");
  write("deleted", "base");
  write(".gitignore", "ignored\n");
  git("add", ".");
  git("commit", "-m", "initial");
  return { cwd, git, write, read, workspace: await ReplayWorkspace.open(cwd) };
}

test("capture is non-mutating; restore round-trips index, working tree, deletions and untracked files", async (t) => {
  const { cwd, git, write, read, workspace } = await repo(t);
  write("a", "staged");
  git("add", "a");
  write("a", "unstaged");
  unlinkSync(join(cwd, "deleted"));
  write("new\nfile", "untracked");
  write("ignored", "keep");
  const before = git("status", "--porcelain=v1", "-z");
  const snapshot = await workspace.capture("root", "step");
  assert.equal(git("status", "--porcelain=v1", "-z"), before);
  assert.equal(read("a"), "unstaged");
  assert.equal(git("stash", "list"), "");
  assert.equal(git("rev-parse", snapshot.ref).trim(), snapshot.oid);
  write("a", "later");
  write("later", "remove");
  unlinkSync(join(cwd, "new\nfile"));
  await workspace.restore(snapshot);
  assert.equal(git("status", "--porcelain=v1", "-z"), before);
  assert.equal(read("a"), "unstaged");
  assert.equal(git("show", ":a"), "staged");
  assert.equal(read("new\nfile"), "untracked");
  assert.equal(read("ignored"), "keep");
  assert.equal(existsSync(join(cwd, "later")), false);
  assert.equal(existsSync(join(cwd, "deleted")), false);
});

test("clean root snapshots restore cleanly and remove subsequent untracked files", async (t) => {
  const { cwd, git, write, read, workspace } = await repo(t);
  const snapshot = await workspace.capture("root", "root");
  write("a", "changed");
  write("new", "new");
  git("add", "new");
  write("other", "other");
  await workspace.restore(snapshot);
  assert.equal(read("a"), "base");
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(existsSync(join(cwd, "new")), false);
  assert.equal(existsSync(join(cwd, "other")), false);
});

test("HEAD changes are refused without changing current files", async (t) => {
  const { git, write, read, workspace } = await repo(t);
  const snapshot = await workspace.capture("root", "root");
  git("commit", "--allow-empty", "-m", "changed head");
  write("a", "preserve");
  await assert.rejects(workspace.restore(snapshot), /HEAD has changed/);
  assert.equal(read("a"), "preserve");
});

test("ignored-file collisions are refused before cleanup", async (t) => {
  const { write, read, workspace } = await repo(t);
  write("new", "snapshot");
  const snapshot = await workspace.capture("root", "step");
  write(".gitignore", "ignored\nnew\n");
  write("new", "ignored user data");
  write("a", "preserve");
  await assert.rejects(workspace.restore(snapshot), /Ignored files/);
  assert.equal(read("new"), "ignored user data");
  assert.equal(read("a"), "preserve");
});

test("pre-step lookup uses ancestors, excluding own and sibling snapshots", () => {
  const root = { id: "root", parentId: null, type: "custom", customType: "swe-replay-root" };
  const snap = (id, parentId, stepId) => ({ id, parentId, type: "custom", customType: "swe-replay-workspace", data: { rootEntryId: "root", stepId, oid: id, ref: `refs/swe-replay/${id}` } });
  const step = (id, parentId) => ({ id, parentId, type: "message", message: { role: "assistant" } });
  const entries = [root, snap("initial", "root", "root"), step("a", "initial"), snap("after-a", "a", "a"), step("b", "after-a"), snap("after-b", "b", "b"), snap("sibling", "a", "a")];
  assert.equal(preStepSnapshot(entries, "root", "a").oid, "initial");
  assert.equal(preStepSnapshot(entries, "root", "b").oid, "after-a");
  assert.throws(() => preStepSnapshot([root, step("old", "root")], "root", "old"), /No pre-step/);
});
