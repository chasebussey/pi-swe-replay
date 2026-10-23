import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { ReplayWorkspace } = await jiti.import("../extensions/swe-replay/workspace.ts");
const { normalizeWorkspacePatches } = await jiti.import("../extensions/swe-replay/patch-normalization.ts");

async function repo(t) {
  const cwd = mkdtempSync(join(tmpdir(), "replay-patch-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  const write = (path, content) => writeFileSync(join(cwd, path), content);
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  write("a.py", "x = 1\n");
  write("b.py", "y = 1\n");
  write("data", "committed\n");
  git("add", ".");
  git("commit", "-m", "initial");
  // A dirty initial workspace must be the base, not HEAD.
  write("data", "staged user work\n");
  git("add", "data");
  write("data", "unstaged user work\n");
  write("user-file", "preexisting untracked\n");
  const workspace = await ReplayWorkspace.open(cwd);
  const capture = async () => workspace.contentTree(await workspace.capture("root", "terminal"));
  const base = await capture();
  return { cwd, git, write, workspace, capture, base };
}

test("mixed identities ignore cosmetic Python companions and staging, but preserve exact bytes", async (t) => {
  const { git, write, workspace, capture, base } = await repo(t);
  write("data", "actual change\n");
  const first = await capture();
  write("a.py", "# cosmetic\nx=1\n");
  git("add", "data", "a.py");
  const cosmetic = await capture();
  write("data", Buffer.from([0, 255, 128]));
  const binary = await capture();
  write("data", Buffer.from([0, 255, 129]));
  const otherBinary = await capture();
  const status = git("status", "--porcelain=v1", "-z");
  const stashes = git("stash", "list");
  const result = await normalizeWorkspacePatches(workspace, base, [first, cosmetic, binary, otherBinary]);
  const [a, b, c, d] = result.patches;
  assert.equal(result.policy, "complete-tree-agentless-mixed-v1");
  assert.equal(result.python.policy, "agentless-python-pyodide-v2");
  assert.equal(a.keyHash, b.keyHash);
  assert.notEqual(b.keyHash, c.keyHash);
  assert.notEqual(c.keyHash, d.keyHash);
  assert.equal(a.keyHash.length, 64);
  assert.ok(result.patches.every((patch) => !patch.rawEmpty && !patch.normalizationEmpty));
  assert.equal(git("status", "--porcelain=v1", "-z"), status);
  assert.equal(git("stash", "list"), stashes);
});

test("raw empty and normalized empty are distinct; empty-file existence and modes survive", async (t) => {
  const { cwd, write, workspace, capture, base } = await repo(t);
  write("a.py", "# only comment\nx=1\n");
  const cosmetic = await capture();
  write("empty.py", "");
  const added = await capture();
  unlinkSync(join(cwd, "empty.py"));
  chmodSync(join(cwd, "a.py"), 0o755);
  const executable = await capture();
  const result = await normalizeWorkspacePatches(workspace, base, [base, cosmetic, added, executable]);
  const [a, b, c, d] = result.patches;
  assert.equal(a.rawEmpty, true);
  assert.equal(b.rawEmpty, false);
  assert.equal(a.normalizationEmpty, true);
  assert.equal(b.normalizationEmpty, true);
  assert.equal(a.keyHash, b.keyHash);
  assert.equal(c.normalizationEmpty, false);
  assert.equal(d.normalizationEmpty, false);
  assert.notEqual(c.keyHash, d.keyHash);
  const deletion = await normalizeWorkspacePatches(workspace, added, [cosmetic]);
  assert.equal(deletion.patches[0].normalizationEmpty, false);
});

test("invalid UTF-8, NUL-containing Python, and symlinks use lossless exact identity", async (t) => {
  const { cwd, write, workspace, capture, base } = await repo(t);
  write("a.py", Buffer.from([255, 10]));
  const invalid = await capture();
  write("a.py", Buffer.from([254, 10]));
  const otherInvalid = await capture();
  write("a.py", "x = 1\0\n");
  const nul = await capture();
  unlinkSync(join(cwd, "a.py"));
  symlinkSync("x = 1\n", join(cwd, "a.py"));
  const link = await capture();
  const result = await normalizeWorkspacePatches(workspace, base, [invalid, otherInvalid, nul, link]);
  assert.equal(new Set(result.patches.map((patch) => patch.keyHash)).size, 4);
  assert.ok(result.patches.every((patch) => !patch.normalizationEmpty && patch.diagnostics.length === 0));
});

test("source-error fallback remains per file and cosmetic companion changes do not split its group", async (t) => {
  const { write, workspace, capture, base } = await repo(t);
  write("a.py", "def broken(:\n");
  const invalid = await capture();
  write("b.py", "# cosmetic\ny=1\n");
  const companion = await capture();
  write("b.py", "y = 2\n");
  const changed = await capture();
  const result = await normalizeWorkspacePatches(workspace, base, [invalid, companion, changed]);
  const [a, b, c] = result.patches;
  assert.equal(a.keyHash, b.keyHash);
  assert.notEqual(b.keyHash, c.keyHash);
  assert.deepEqual(a.diagnostics.map(({ kind, path, pythonType }) => ({ kind, path, pythonType })), [
    { kind: "exact-content-fallback", path: "a.py", pythonType: "SyntaxError" },
  ]);
});

test("immutable reads are byte-sorted, include additions/deletions, and ignore later workspace changes", async (t) => {
  const { cwd, write, workspace, capture, base } = await repo(t);
  write("z\n.py", "value=3\n");
  write("A.py", "value=4\n");
  unlinkSync(join(cwd, "a.py"));
  const candidate = await capture();
  write("A.py", "not in snapshot");
  const changes = await workspace.treeChanges(base, candidate);
  assert.deepEqual(changes.map(({ path }) => path.toString()), ["A.py", "a.py", "z\n.py"]);
  assert.equal(changes[0].before, null);
  assert.equal(changes[0].after.content.toString(), "value=4\n");
  assert.equal(changes[1].after, null);
  const result = await normalizeWorkspacePatches(workspace, base, [candidate]);
  assert.equal(result.patches[0].normalizationEmpty, false);
});

test("raw Git path bytes and unsupported tree kinds have exact identity", async (t) => {
  const { cwd, workspace, base } = await repo(t);
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd, input: "x=1\n", encoding: "utf8" }).trim();
  const tree = (byte) => {
    const path = Buffer.from([byte, 46, 112, 121]);
    const input = Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), path, Buffer.from([0])]);
    const treeOid = execFileSync("git", ["mktree", "-z"], { cwd, input, encoding: "utf8" }).trim();
    return { ...base, treeOid };
  };
  const first = tree(255);
  const second = tree(254);
  const changes = await workspace.treeChanges(base, first);
  assert.ok(changes.some(({ path }) => path.equals(Buffer.from([255, 46, 112, 121]))));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const treeOid = execFileSync("git", ["mktree"], {
    cwd, input: `160000 commit ${head}\tsubmodule\n`, encoding: "utf8",
  }).trim();
  const result = await normalizeWorkspacePatches(workspace, base, [first, second, { ...base, treeOid }]);
  assert.equal(new Set(result.patches.map(({ keyHash }) => keyHash)).size, 3);
  assert.ok(result.patches.every(({ normalizationEmpty }) => !normalizationEmpty));
});

test("cross-run input, Git errors, cancellation and resource failures reject the whole batch", async (t) => {
  const { write, workspace, base, capture } = await repo(t);
  await assert.rejects(normalizeWorkspacePatches(workspace, base, [{ ...base, rootEntryId: "other" }]), /different replay runs/);
  await assert.rejects(normalizeWorkspacePatches(workspace, base, [{ ...base, treeOid: "f".repeat(40) }]), /git/);
  await assert.rejects(normalizeWorkspacePatches(workspace, base, [base], { signal: AbortSignal.abort() }), /abort/i);
  await assert.rejects(normalizeWorkspacePatches(workspace, base, [base], { timeoutMs: 0 }), /positive and finite/);
  const slowWorkspace = {
    treeChanges: async (_base, _candidate, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  };
  await assert.rejects(normalizeWorkspacePatches(slowWorkspace, base, [base], { timeoutMs: 10 }), /Patch normalization timed out/);
  write("a.py", "x = " + "1+".repeat(5000) + "1\n");
  const resource = await capture();
  await assert.rejects(normalizeWorkspacePatches(workspace, base, [base, resource]), /RecursionError/);
});
