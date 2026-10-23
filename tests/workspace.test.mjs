import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readlinkSync, existsSync, symlinkSync, unlinkSync } from "node:fs";
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

test("content trees ignore staging and retain complete content without mutating the checkout", async (t) => {
  const { git, write, workspace } = await repo(t);
  write("a", "user's initial change");
  write("initial-untracked", "user data");
  const initial = await workspace.capture("root", "root");
  const base = await workspace.contentTree(initial);

  write("a", "candidate");
  write("new\nfile", "addition");
  git("stash", "push", "-u", "-m", "ordinary user stash");
  git("stash", "apply", "--index");
  const stashes = git("stash", "list");
  const firstSnapshot = await workspace.capture("root", "one");
  const first = await workspace.contentTree(firstSnapshot);
  git("add", "a", "new\nfile", "initial-untracked");
  const before = git("status", "--porcelain=v1", "-z");
  const second = await workspace.contentTree(await workspace.capture("root", "two"));

  assert.equal(first.treeOid, second.treeOid);
  assert.equal(git("status", "--porcelain=v1", "-z"), before);
  assert.equal(git("stash", "list"), stashes);
  assert.equal(git("show", `${base.treeOid}:initial-untracked`), "user data");
  assert.equal(git("show", `${second.treeOid}:new\nfile`), "addition");
  assert.equal(git("rev-parse", second.ref).trim(), second.treeOid);
  assert.deepEqual(await workspace.exportPatch(base, first), await workspace.exportPatch(base, second));
  assert.equal((await workspace.exportPatch(first, second)).length, 0);
  await assert.rejects(workspace.exportPatch(base, { ...second, rootEntryId: "other" }), /different replay runs/);

  // The tree has its own retaining ref, independent of the original stash-shaped commit.
  git("update-ref", "-d", firstSnapshot.ref);
  git("reflog", "expire", "--expire=now", "--all");
  git("gc", "--prune=now");
  assert.equal(git("show", `${first.ref}:new\nfile`), "addition");
});

test("content trees include recreated staged deletions and file-to-directory replacements", async (t) => {
  const { cwd, git, write, workspace } = await repo(t);
  git("rm", "a", "deleted");
  mkdirSync(join(cwd, "a"));
  write("a/child", "replacement directory");
  write("deleted", "recreated untracked");
  write("staged-then-removed", "added");
  git("add", "staged-then-removed");
  unlinkSync(join(cwd, "staged-then-removed"));
  write("ignored", "must not enter content tree");
  const before = git("status", "--porcelain=v1", "-z");
  const snapshot = await workspace.capture("root", "step");
  const tree = await workspace.contentTree(snapshot);

  assert.equal(git("show", `${tree.treeOid}:a/child`), "replacement directory");
  assert.equal(git("show", `${tree.treeOid}:deleted`), "recreated untracked");
  assert.throws(() => git("show", `${tree.treeOid}:staged-then-removed`));
  assert.throws(() => git("show", `${tree.treeOid}:ignored`));
  assert.equal(git("status", "--porcelain=v1", "-z"), before);

  await workspace.withEvaluationWorkspace(snapshot, cwd, async (directory) => {
    execFileSync("git", ["add", "-A"], { cwd: directory });
    const materialized = execFileSync("git", ["write-tree"], { cwd: directory, encoding: "utf8" }).trim();
    assert.equal(materialized, tree.treeOid);
  });
});

test("exported patches apply to dirty initial content, including binary, mode, symlink and existence changes", async (t) => {
  const { cwd, git, write, workspace } = await repo(t);
  write("a", "preexisting staged change\n");
  git("add", "a");
  write("a", "preexisting unstaged change\n");
  write("preexisting", "initial untracked\n");
  write("invalid-utf8", Buffer.from([0xff, 0xfe, 0x0a]));
  const initial = await workspace.capture("root", "root");
  const base = await workspace.contentTree(initial);

  write("a", "candidate content\n");
  write("preexisting", "updated untracked\n");
  write("invalid-utf8", Buffer.from([0xff, 0xfd, 0x0a]));
  unlinkSync(join(cwd, "deleted"));
  write("binary", Buffer.from([0, 1, 2, 255]));
  write("executable", "#!/bin/sh\nexit 0\n");
  chmodSync(join(cwd, "executable"), 0o755);
  symlinkSync("a", join(cwd, "link"));
  write("staged-addition", "staged\n");
  git("add", "staged-addition");
  const candidate = await workspace.contentTree(await workspace.capture("root", "candidate"));
  const before = git("status", "--porcelain=v1", "-z");

  // Ignore caller diff presentation settings and never invoke external diff programs.
  git("config", "diff.external", "nonexistent-command");
  git("config", "diff.noprefix", "true");
  git("config", "diff.context", "0");
  git("config", "diff.renames", "true");
  const patch = await workspace.exportPatch(base, candidate);
  assert.ok(Buffer.isBuffer(patch));
  assert.match(patch.toString(), /GIT binary patch/);
  assert.match(patch.toString(), /diff --git a\/a b\/a/);
  assert.equal(git("status", "--porcelain=v1", "-z"), before);

  await workspace.withEvaluationWorkspace(initial, cwd, async (directory) => {
    execFileSync("git", ["apply", "--binary", "-"], { cwd: directory, input: patch });
    assert.equal(readFileSync(join(directory, "a"), "utf8"), "candidate content\n");
    assert.equal(readFileSync(join(directory, "preexisting"), "utf8"), "updated untracked\n");
    assert.deepEqual(readFileSync(join(directory, "binary")), Buffer.from([0, 1, 2, 255]));
    assert.deepEqual(readFileSync(join(directory, "invalid-utf8")), Buffer.from([0xff, 0xfd, 0x0a]));
    assert.equal(readlinkSync(join(directory, "link")), "a");
    assert.equal(existsSync(join(directory, "deleted")), false);
    execFileSync("git", ["add", "-A"], { cwd: directory });
    const appliedTree = execFileSync("git", ["write-tree"], { cwd: directory, encoding: "utf8" }).trim();
    assert.equal(appliedTree, candidate.treeOid);
  });
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
