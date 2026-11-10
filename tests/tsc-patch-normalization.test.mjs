import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { ReplayWorkspace } = await jiti.import("../extensions/swe-replay/workspace.ts");
const { normalizeWorkspacePatches } = await jiti.import("../extensions/swe-replay/patch-normalization.ts");
const policy = await jiti.import("../extensions/swe-replay/normalization-policy.ts");
const { TSC_WORKSPACE_LIMITS, TSC_WORKSPACE_RESOURCE_PROFILE } = await jiti.import("../extensions/swe-replay/tsc-workspace-limits.ts");
const contract = JSON.parse(readFileSync(new URL("./fixtures/tsc/contract.json", import.meta.url), "utf8"));

async function repo(t) {
  const cwd = mkdtempSync(join(tmpdir(), "replay-tsc-patch-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  const write = (path, content) => writeFileSync(join(cwd, path), content);
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  write("a.py", "x=1\n");
  write("a.ts", "const x=1;\n");
  write("data", "committed\n");
  git("add", ".");
  git("commit", "-m", "initial");
  write("a.py", "x=2\n");
  git("add", "a.py");
  write("a.py", "x=3\n");
  write("data", "unstaged\n");
  write("user.py", "u=1\n");
  const workspace = await ReplayWorkspace.open(cwd);
  const base = await workspace.contentTree(await workspace.capture("root", "terminal"));
  const initial = [["a.py", "x=3\n"], ["a.ts", "const x=1;\n"], ["data", "unstaged\n"], ["user.py", "u=1\n"]];
  const blob = (content) => execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd, input: content, encoding: "utf8" }).trim();
  const tree = (overrides = []) => {
    const entries = new Map(initial.map(([name, content]) => [Buffer.from(name).toString("base64"), { path: Buffer.from(name), content, mode: "100644" }]));
    for (const item of overrides) {
      const path = Buffer.from(item.path);
      if (item.content === null && !item.oid) entries.delete(path.toString("base64"));
      else entries.set(path.toString("base64"), { mode: "100644", ...item, path });
    }
    const records = [...entries.values()].map(({ path, mode, content, oid }) => Buffer.concat([
      Buffer.from(`${mode} ${mode === "160000" ? "commit" : "blob"} ${oid ?? blob(content)}\t`), path, Buffer.from([0]),
    ]));
    const treeOid = execFileSync("git", ["mktree", "-z"], { cwd, input: Buffer.concat(records), encoding: "utf8" }).trim();
    return { ...base, treeOid };
  };
  const cache = join(cwd, ".grammar-cache");
  // Cache files are outside any captured candidate tree, not runtime inputs.
  const cacheDir = mkdtempSync(cache);
  for (const pin of policy.TSC_LANGUAGES) {
    copyFileSync(join(dirname(require.resolve(`${pin.package}/package.json`)), pin.asset), join(cacheDir, `${pin.sha256}.wasm`));
  }
  const options = { backend: "tsc", grammar: { cacheDir, offline: true, fetch() { throw new Error("Runtime network forbidden"); } } };
  const normalize = (candidates, overrides = {}) => normalizeWorkspacePatches(workspace, base, candidates, { ...options, ...overrides });
  return { cwd, git, write, workspace, base, tree, normalize, options };
}
const file = (path, content, mode = "100644") => ({ path, content, mode });

test("TSC complete-tree frame pins all provenance and base tree without enabling persisted compatibility", async (t) => {
  const { base, normalize } = await repo(t);
  const result = await normalize([base]);
  assert.equal(TSC_WORKSPACE_RESOURCE_PROFILE, contract.workspaceResourceProfile.name);
  assert.deepEqual(TSC_WORKSPACE_LIMITS, contract.workspaceResourceProfile.limits);
  for (const field of ["policy", "canonicalization", "helpers", "registry", "sourceFallback", "framing"]) {
    assert.equal(result.tsc[field], contract.identity[field], field);
  }
  const provenance = policy.tscPatchProvenanceFrame(result.tsc);
  assert.deepEqual(provenance.slice(0, 6), ["policy", "canonicalization", "helpers", "registry", "sourceFallback", "framing"].map((field) => contract.identity[field]));
  assert.deepEqual(provenance.slice(6, 9), ["web-tree-sitter", "0.27.1", policy.TSC_RUNTIME_ASSET.sha256]);
  assert.deepEqual(provenance[9], policy.TSC_LANGUAGES.map((pin) => [pin.language, pin.package, pin.version, pin.sha256]));
  const expected = createHash("sha256").update(JSON.stringify([result.policy, provenance, base.treeOid, []])).digest("hex");
  assert.equal(result.patches[0].keyHash, expected);
  assert.equal(result.patches[0].rawEmpty, true);
  assert.equal(result.patches[0].normalizationEmpty, true);
  assert.equal(policy.isSupportedNormalizationProvenance(result), false, "P5 is still required");
});

test("canonical content frame is explicit and distinct from exact bytes and metadata", async (t) => {
  const { tree, normalize, base } = await repo(t);
  const candidate = tree([file("a.py", "x=4\n")]);
  const result = await normalize([candidate]);
  const source = (integer) => ["source", "utf8", ["node", "module", [[null, ["node", "expression_statement", [[null,
    ["node", "assignment", [["left", ["token", "identifier", "x"]], [null, ["token", "=", "="]], ["right", ["token", "integer", integer]]]],
  ]]]]]]];
  const content = ["canonical", source("3"), source("4"), []];
  const frame = [result.policy, policy.tscPatchProvenanceFrame(result.tsc), base.treeOid,
    [[Buffer.from("a.py").toString("base64"), "100644", "100644", content]]];
  assert.equal(result.patches[0].keyHash, createHash("sha256").update(JSON.stringify(frame)).digest("hex"));
});

test("all 36 promoted helper comparisons retain expected complete-tree hashes", async (t) => {
  const { tree, workspace, options } = await repo(t);
  const pairs = JSON.parse(readFileSync(new URL("./fixtures/tsc/helper-pairs.json", import.meta.url), "utf8"));
  const bytes = (value) => Buffer.from(value.content, value.encoding === "utf8" ? "utf8" : "base64");
  for (const item of pairs) {
    const path = item.language === "python" ? "a.py" : "a.ts";
    const baseline = tree([file(path, bytes(item.baseline))]);
    const candidates = [item.candidateA, item.candidateB].map((value) => tree([file(path, bytes(value))]));
    const result = await normalizeWorkspacePatches(workspace, baseline, candidates, options);
    assert.equal(result.patches[0].keyHash === result.patches[1].keyHash, item.expected === "equivalent", item.id);
  }
});

test("helper placement groups with matching residuals in both languages; other files/path moves remain significant", async (t) => {
  const { normalize, tree, git, write } = await repo(t);
  const py = "def helper():\n return 7\n";
  const ts = "export function helper(){return 7;}\n";
  const a = tree([file("a.py", py + "x=4\n"), file("a.ts", ts + "const x=2;\n")]);
  const b = tree([file("a.py", "x=4\n" + py), file("a.ts", "const x=2;\n" + ts)]);
  const other = tree([file("a.py", "x=5\n" + py), file("a.ts", ts + "const x=2;\n")]);
  const companion = tree([file("a.py", py + "x=4\n"), file("a.ts", ts + "const x=2;\n"), file("data", "different\n")]);
  const moved = tree([file("a.py", "x=4\n"), file("user.py", py + "u=1\n"), file("a.ts", ts + "const x=2;\n")]);
  write("a.py", "later uncaptured work\n");
  const status = git("status", "--porcelain=v1", "-z");
  const stash = git("stash", "list");
  const refs = git("show-ref");
  const result = await normalize([a, b, other, companion, moved]);
  const hashes = result.patches.map((patch) => patch.keyHash);
  assert.equal(hashes[0], hashes[1]);
  assert.equal(new Set(hashes).size, 4);
  assert.equal(git("status", "--porcelain=v1", "-z"), status);
  assert.equal(git("stash", "list"), stash);
  assert.equal(git("show-ref"), refs);
});

test("initial dirty complete tree, not HEAD or later files, defines the baseline", async (t) => {
  const { tree, base, normalize, git } = await repo(t);
  assert.notEqual(base.treeOid, git("rev-parse", "HEAD^{tree}").trim());
  const same = tree();
  assert.equal(same.treeOid, base.treeOid);
  const cosmetic = tree([file("a.py", "# doc\nx = 3\n"), file("user.py", '"module docs"\nu = 1\n')]);
  const headContent = tree([file("a.py", "x=1\n"), file("data", "committed\n"), file("user.py", null)]);
  const result = await normalize([same, cosmetic, headContent]);
  assert.deepEqual(result.patches.map((p) => [p.rawEmpty, p.normalizationEmpty]), [[true, true], [false, true], [false, false]]);
  assert.equal(result.patches[0].keyHash, result.patches[1].keyHash);
});

test("modes, file addition/deletion, BOM and empty/documentation-only existence remain distinct", async (t) => {
  const { tree, normalize, base, workspace, options } = await repo(t);
  const added = tree([file("new.py", "")]);
  const docs = tree([file("new.py", '"docs"\n')]);
  const binary = tree([file("new.py", Buffer.from([0xff]))]);
  const mode = tree([file("a.py", "x=3\n", "100755")]);
  const bom = tree([file("a.py", "\uFEFFx=3\n")]);
  const deleted = tree([file("a.py", null)]);
  const result = await normalize([base, added, docs, binary, mode, bom, deleted]);
  assert.equal(result.patches[1].keyHash, result.patches[2].keyHash, "documentation-only new file still exists");
  assert.equal(new Set(result.patches.map((p) => p.keyHash)).size, 6);
  assert.deepEqual(result.patches.map((p) => p.normalizationEmpty), [true, false, false, false, false, false, false]);
  const reverse = await normalizeWorkspacePatches(workspace, docs, [base], options);
  assert.equal(reverse.patches[0].normalizationEmpty, false, "documentation-only file deletion remains significant");
});

test("paired source fallback preserves both raw sources and ignores cosmetic companions", async (t) => {
  const { tree, normalize, workspace, options } = await repo(t);
  const malformed = tree([file("a.py", "def broken(:\n")]);
  const cosmetic = tree([file("a.py", "def broken(:\n"), file("a.ts", "// docs\nconst x = 1;\n")]);
  const changed = tree([file("a.py", "def broken( :\n")]);
  const result = await normalize([malformed, cosmetic, changed]);
  assert.equal(result.patches[0].keyHash, result.patches[1].keyHash);
  assert.notEqual(result.patches[0].keyHash, result.patches[2].keyHash);
  assert.deepEqual(result.patches[0].diagnostics.map(({ side, reason, pathBase64 }) => [side, reason, pathBase64]),
    [["after", "syntax-error", Buffer.from("a.py").toString("base64")]]);
  const badBase = tree([file("a.py", "def broken(:\n")]);
  const a = tree([file("a.py", "x=3\n")]);
  const b = tree([file("a.py", "x = 3\n")]);
  const paired = await normalizeWorkspacePatches(workspace, badBase, [a, b], options);
  assert.notEqual(paired.patches[0].keyHash, paired.patches[1].keyHash, "baseline source error forces exact handling on both sides");
  assert.equal(paired.patches[0].diagnostics[0].side, "before");
});

test("exact bytes, unsupported suffixes/kinds and raw paths remain lossless", async (t) => {
  const { tree, normalize, git } = await repo(t);
  const raw = Buffer.from([0xff, 46, 112, 121]);
  const otherRaw = Buffer.from([0xfe, 46, 112, 121]);
  const cases = [tree([file("a.py", Buffer.from([0xff]))]), tree([file("a.py", Buffer.from([0xfe]))]),
    tree([file("a.py", "x=3\0\n")]), tree([file("a.py", "x = 3\n", "120000")]),
    tree([file("x.mts", "const x=1;\n")]), tree([file("x.mts", "const x = 1;\n")]),
    tree([file(raw, "def h():\n pass\n")]), tree([file(otherRaw, "def h():\n pass\n")]),
    tree([{ path: "submodule", content: null, mode: "160000", oid: git("rev-parse", "HEAD").trim() }])];
  const result = await normalize(cases);
  assert.equal(new Set(result.patches.map((p) => p.keyHash)).size, cases.length);
  assert.equal(result.patches[0].diagnostics[0].reason, "invalid-utf8");
  assert.equal(result.patches[2].diagnostics[0].reason, "nul-binary");
  assert.ok(result.patches[3].diagnostics.some((d) => d.reason === "unsupported-kind"));
  assert.ok(result.patches[4].diagnostics.every((d) => d.reason === "unsupported-language"));
  assert.equal(result.patches[6].diagnostics.length, 0, "raw suffix matching permits undecodable path prefixes");
  assert.equal(result.patches[8].diagnostics[0].reason, "unsupported-kind");
});

test("raw byte sorting, exact frame shape and tightened execution limits do not alter successful identities", async (t) => {
  const { tree, normalize, base } = await repo(t);
  const candidate = tree([file("z\n", "z"), file("A", "a"), file(Buffer.from([0xff]), "raw")]);
  const first = await normalize([candidate]);
  const second = await normalize([candidate], { workspaceLimits: { maxCandidates: 1 }, limits: { maxSourceBytes: 64 } });
  assert.equal(first.patches[0].keyHash, second.patches[0].keyHash);
  const components = [[Buffer.from("A").toString("base64"), null, "100644", ["exact", null, ["bytes", Buffer.from("a").toString("base64")]]],
    [Buffer.from("z\n").toString("base64"), null, "100644", ["exact", null, ["bytes", Buffer.from("z").toString("base64")]]],
    [Buffer.from([0xff]).toString("base64"), null, "100644", ["exact", null, ["bytes", Buffer.from("raw").toString("base64")]]]];
  const frame = [first.policy, policy.tscPatchProvenanceFrame(first.tsc), base.treeOid, components];
  assert.equal(first.patches[0].keyHash, createHash("sha256").update(JSON.stringify(frame)).digest("hex"));
});

test("workspace limits reject before blob reads, including supported-source and exact-file reads", async (t) => {
  const { tree, normalize, cwd } = await repo(t);
  const trace = join(cwd, "git-trace.log");
  const old = process.env.GIT_TRACE;
  t.after(() => { if (old === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = old; });
  const candidates = [tree([file("a.py", "x=123456789\n")])];
  for (const overrides of [{ workspaceLimits: { maxCandidates: 1 }, candidates: [...candidates, ...candidates] },
    { workspaceLimits: { maxTreeEntries: 1 } }, { workspaceLimits: { maxTreeListingBytes: 1 } },
    { workspaceLimits: { maxBatchListingBytes: 1 } }, { workspaceLimits: { maxReadBytes: 1 } },
    { limits: { maxPathBytes: 1 } }, { workspaceLimits: { maxBlobBytes: 1 } }, { limits: { maxSourceBytes: 1 } }, { limits: { maxSources: 1 } },
    { limits: { maxBatchBytes: 1 } }, { limits: { maxUniqueBytes: 1 } },
    { workspaceLimits: { maxChangedFiles: 1 }, candidates: [tree([file("a.py", "x=4"), file("data", "new")])] }]) {
    writeFileSync(trace, "");
    process.env.GIT_TRACE = trace;
    const { candidates: selected = candidates, ...settings } = overrides;
    await assert.rejects(normalize(selected, settings), /limit|maxBuffer/i);
    assert.doesNotMatch(readFileSync(trace, "utf8"), /built-in: git cat-file blob/, JSON.stringify(settings));
    delete process.env.GIT_TRACE;
  }
  writeFileSync(trace, "");
  process.env.GIT_TRACE = trace;
  await assert.rejects(normalize([tree([file("data", "long exact content")])], { workspaceLimits: { maxBlobBytes: 1 } }), /maxBlobBytes/);
  assert.doesNotMatch(readFileSync(trace, "utf8"), /built-in: git cat-file blob/);
});

test("tightened read/source limits accept exact boundaries and reject one unit over", async (t) => {
  const { tree, normalize, base, git } = await repo(t);
  const changed = tree([file("a.py", "x=4\n")]);
  const listingBytes = Buffer.byteLength(git("ls-tree", "-r", "-z", "-l", "--full-tree", base.treeOid));
  const boundaries = [
    ["workspaceLimits", "maxBlobBytes", 4], ["workspaceLimits", "maxReadBytes", 8],
    ["workspaceLimits", "maxTreeEntries", 4], ["workspaceLimits", "maxTreeListingBytes", listingBytes],
    ["workspaceLimits", "maxBatchListingBytes", 2 * listingBytes],
    ["limits", "maxSourceBytes", 4], ["limits", "maxSources", 2],
    ["limits", "maxUniqueSources", 2], ["limits", "maxUniqueBytes", 8],
    ["limits", "maxBatchBytes", 80], // Two (4-byte path + <=32-byte ID) reservations plus 8 content bytes.
  ];
  for (const [group, name, maximum] of boundaries) {
    const result = await normalize([changed], { [group]: { [name]: maximum } });
    assert.equal(result.patches[0].normalizationEmpty, false, name);
    await assert.rejects(normalize([changed], { [group]: { [name]: maximum - 1 } }),
      (error) => error.limit === name || ["maxTreeListingBytes", "maxBatchListingBytes"].includes(name) && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", name);
  }
});

test("batch-change/unique-source caps, exact framing limits and bounded diagnostics remain explicit", async (t) => {
  const { tree, normalize } = await repo(t);
  const changed = tree([file("a.py", "x=4\n")]);
  await assert.rejects(normalize([changed, changed], { workspaceLimits: { maxBatchChangedFiles: 1 } }), (error) => error.limit === "maxBatchChangedFiles");
  await assert.rejects(normalize([changed], { limits: { maxUniqueSources: 1 } }), (error) => error.limit === "maxUniqueSources");
  const large = tree([file("data", "x".repeat(2048))]);
  const empty = await normalize([]);
  const minimum = Buffer.byteLength(JSON.stringify([empty.policy, policy.tscPatchProvenanceFrame(empty.tsc), changed.treeOid, []]));
  await assert.rejects(normalize([large], { workspaceLimits: { maxIdentityBytes: minimum + 1024 } }), (error) => error.limit === "maxIdentityBytes");
  const unsupported = tree(Array.from({ length: 40 }, (_, index) => file(`unsupported-${index}.txt`, "literal\n")));
  const result = await normalize([unsupported]);
  assert.equal(result.patches[0].diagnostics.length, 32);
  assert.equal(result.patches[0].diagnosticsTruncated, 8);
});

test("input tree envelopes/options are snapshotted before asynchronous reads", async (t) => {
  const { tree, workspace, base, options } = await repo(t);
  const candidate = tree([file("a.py", "x=4\n")]);
  const expected = await normalizeWorkspacePatches(workspace, base, [candidate], options);
  const inputBase = { ...base };
  const inputCandidate = { ...candidate };
  const candidates = [inputCandidate];
  const mutableOptions = { ...options, grammar: { ...options.grammar }, workspaceLimits: { maxCandidates: 1 } };
  const operation = normalizeWorkspacePatches(workspace, inputBase, candidates, mutableOptions);
  inputBase.treeOid = "f".repeat(40);
  inputCandidate.treeOid = "e".repeat(40);
  candidates.length = 0;
  mutableOptions.grammar.cacheDir = "/nonexistent";
  mutableOptions.workspaceLimits.maxCandidates = 0;
  const result = await operation;
  assert.deepEqual(result.patches, expected.patches);
});

test("cross-run, Git, cancellation, deadline, projection and worker failures return no partial batch", async (t) => {
  const { workspace, base, normalize, tree, options } = await repo(t);
  await assert.rejects(normalize([{ ...base, rootEntryId: "other" }]), /different replay runs/);
  await assert.rejects(normalize([{ ...base, treeOid: "f".repeat(40) }]), /git/);
  const signal = AbortSignal.abort();
  await assert.rejects(normalize([base], { signal }), /abort/i);
  assert.equal(getEventListeners(signal, "abort").length, 0);
  await assert.rejects(normalize([base], { timeoutMs: 0 }), /1\.\.60000/);
  await assert.rejects(normalize([base], { workspaceLimits: { maxCandidates: TSC_WORKSPACE_LIMITS.maxCandidates + 1 } }), /Invalid TSC workspace limit/);
  const changed = tree([file("a.py", "x=4\n")]);
  await assert.rejects(normalize([base, changed], { workspaceLimits: { maxIdentityBytes: 1 } }), /maxIdentityBytes/);
  await assert.rejects(normalize([base, changed], { limits: { maxSourceNodes: 1 } }), /maxSourceNodes/);
  const waiting = { treeChanges: async (_base, _candidate, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) };
  await assert.rejects(normalizeWorkspacePatches(waiting, base, [base], { ...options, timeoutMs: 10 }), /timed out/);
  await assert.rejects(normalizeWorkspacePatches(workspace, base, [base], { backend: "unknown" }), /Unsupported normalization backend/);
});
