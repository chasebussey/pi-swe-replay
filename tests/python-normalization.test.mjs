import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { normalizePythonPatches, PythonNormalizationError } = await jiti.import("../extensions/swe-replay/python-normalization.ts");
const inputs = JSON.parse(readFileSync(new URL("./fixtures/agentless-normalization-input.json", import.meta.url)));
const reference = JSON.parse(readFileSync(new URL("./fixtures/agentless-normalization-expected.json", import.meta.url)));
const expectedById = new Map(reference.cases.map((entry) => [entry.id, entry]));

const scratchDirectories = () => readdirSync(tmpdir()).filter((name) => name.startsWith("swe-replay-normalization-")).sort();

test("offline Pyodide normalizer matches all successful pinned Agentless outputs without host Python", async (t) => {
  const oldPath = process.env.PATH;
  const tools = mkdtempSync(join(tmpdir(), "replay-normalization-tools-"));
  const git = oldPath.split(delimiter).map((directory) => join(directory, "git")).find(existsSync);
  assert.ok(git, "Git must be installed");
  symlinkSync(realpathSync(git), join(tools, "git"));
  process.env.PATH = tools; // No python, python3, shell, or compiler available to subprocesses.
  t.after(() => {
    process.env.PATH = oldPath;
    rmSync(tools, { recursive: true, force: true });
  });

  const successful = inputs.filter((entry) => !expectedById.get(entry.id).errorType);
  const before = scratchDirectories();
  const result = await normalizePythonPatches(successful);

  assert.equal(result.policy, "agentless-python-pyodide-v2");
  assert.equal(result.upstreamRevision, reference.upstreamRevision);
  assert.equal(result.pyodideVersion, "314.0.7");
  assert.equal(result.pythonVersion, "3.14.2");
  assert.equal(result.gitDiffPolicy, reference.gitDiffPolicy);
  assert.equal(result.patches.length, successful.length);
  for (const [index, input] of successful.entries()) {
    const expected = expectedById.get(input.id).key;
    assert.equal(result.patches[index].key, expected, input.id);
    assert.equal(result.patches[index].empty, !expected.trim(), input.id);
    assert.deepEqual(result.patches[index].diagnostics, [], input.id);
  }
  assert.deepEqual(scratchDirectories(), before);
});

test("normalization ignores ambient Git attributes and ignore files", async (t) => {
  const oldConfigHome = process.env.XDG_CONFIG_HOME;
  const configHome = mkdtempSync(join(tmpdir(), "replay-normalization-config-"));
  const gitConfig = join(configHome, "git");
  mkdirSync(gitConfig);
  process.env.XDG_CONFIG_HOME = configHome;
  t.after(() => {
    if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfigHome;

    rmSync(configHome, { recursive: true, force: true });
  });

  const cases = ["constant-change", "added-function-before-interior", "formatting-and-comments"]
    .map((id) => inputs.find((entry) => entry.id === id));
  const expected = cases.map(({ id }) => ({
    key: expectedById.get(id).key,
    empty: !expectedById.get(id).key.trim(),
    diagnostics: [],
  }));

  for (const scenario of ["ignore", "attributes", "both"]) {
    writeFileSync(join(gitConfig, "ignore"), scenario === "attributes" ? "" : "*.py\n");
    writeFileSync(join(gitConfig, "attributes"), scenario === "ignore" ? "" : "*.py -diff\n");

    const result = await normalizePythonPatches(cases);
    assert.deepEqual(result.patches, expected, scenario);
  }
});

test("normalization treats leading-colon filenames as literal Git paths", async () => {
  const paths = [":foo.py", ":(exclude)foo.py"];
  const result = await normalizePythonPatches(paths.map((path) => ({
    files: [{ path, before: "x = 1", after: "x = 2" }],
  })));

  for (const [index, path] of paths.entries()) {
    const patch = result.patches[index];
    assert.equal(patch.empty, false);
    assert.deepEqual(patch.diagnostics, []);
    assert.ok(patch.key.includes(`diff --git a/${path} b/${path}\n`));
    assert.match(patch.key, /-x = 1/);
    assert.match(patch.key, /\+x = 2/);
  }
});

test("source errors use exact original content per file and do not discard other files or patches", async () => {
  const invalid = inputs.find((entry) => entry.id === "invalid-python").files[0];
  const valid = { path: "good.py", before: "x = 1\n", after: "x = 2\n" };
  const input = { files: [valid, invalid] };
  const variants = [
    input,
    { files: [{ ...valid, after: "# cosmetic\nx=(2)\n" }, invalid] },
    { files: [valid, { ...invalid, after: "def broken( :\n" }] },
    { files: [valid, { ...invalid, before: "x=1\n" }] },
    { files: [{ ...valid, after: "x = 3\n" }, invalid] },
    { files: [valid, { ...invalid, path: "other.py" }] },
    { files: [valid] },
    { files: [invalid, valid, { ...invalid, path: "bad-two.py" }, { ...valid, path: "last.py" }] },
  ];
  const result = await normalizePythonPatches(variants);
  const patches = result.patches;
  assert.equal(patches.length, variants.length);
  assert.equal(patches[0].key, patches[1].key);
  for (const index of [2, 3, 4, 5, 6]) assert.notEqual(patches[0].key, patches[index].key, `variant ${index}`);
  assert.ok(patches.every((patch) => !patch.empty));
  assert.deepEqual(patches[6].diagnostics, []);

  const diagnostic = patches[0].diagnostics[0];
  assert.equal(patches[0].diagnostics.length, 1);
  assert.equal(diagnostic.kind, "exact-content-fallback");
  assert.equal(diagnostic.path, "a.py");
  assert.equal(diagnostic.pythonType, expectedById.get("invalid-python").errorType);
  assert.match(diagnostic.message, /invalid syntax/);

  const [domain, components] = JSON.parse(patches[0].key);
  assert.equal(domain, "exact-python-source-v1");
  assert.match(components[0][1], /\+x = 2/);
  assert.deepEqual(components[1], ["exact", invalid.path, invalid.before, invalid.after]);

  const [, interleaved] = JSON.parse(patches[7].key);
  assert.deepEqual(interleaved.map(([kind]) => kind), ["exact", "agentless", "exact", "agentless"]);
  assert.deepEqual(patches[7].diagnostics.map(({ path }) => path), ["a.py", "bad-two.py"]);
});

test("fallback covers either side and syntax-error subclasses, but unchanged and raw-empty inputs stay empty", async () => {
  const invalid = "def broken(:\n";
  const cases = [
    { files: [{ path: "a.py", before: invalid, after: "x=2\n" }] },
    { files: [{ path: "a.py", before: invalid, after: "x = 2\n" }] },
    { files: [{ path: "a.py", before: "x = 1\n", after: "def f():\nreturn 1\n" }] },
    { files: [{ path: "a.py", before: "x = 1\n", after: "def f():\n\tpass\n        pass\n" }] },
    { files: [{ path: "a.py", before: invalid, after: invalid }] },
    { rawPatch: "", files: [{ path: "a.py", before: invalid, after: "different invalid !!!!" }] },
  ];
  const { patches } = await normalizePythonPatches(cases);
  assert.notEqual(patches[0].key, patches[1].key, "both original sides remain exact, even when the other side parses");
  assert.equal(patches[2].diagnostics[0].pythonType, "IndentationError");
  assert.equal(patches[3].diagnostics[0].pythonType, "TabError");
  assert.equal(patches[4].key, "");
  assert.equal(patches[4].empty, true);
  assert.equal(patches[4].diagnostics.length, 1);
  assert.deepEqual(patches[5], { key: "", empty: true, diagnostics: [] });
});

test("unexpected Python errors remain hard batch failures rather than exact-content fallbacks", async () => {
  // A deep AST exhausts parser resources, rather than producing an ordinary syntax error.
  const excessive = { files: [{ path: "a.py", before: "x = 1", after: `x = ${"-".repeat(5000)}1` }] };
  await assert.rejects(normalizePythonPatches([{ files: [] }, excessive]), (error) => {
    assert.ok(error instanceof PythonNormalizationError);
    assert.equal(error.pythonType, "RecursionError");
    assert.equal(error.filePath, "a.py");
    assert.equal(error.patchIndex, 1);
    return true;
  });
});

test("batch input is validated before starting the embedded runtime", async () => {
  for (const path of ["../escape.py", "/absolute.py", ".git/file.py", "dir/../escape.py", "dir\\escape.py", "C:escape.py", "not-python.txt", "bad\0.py"]) {
    await assert.rejects(normalizePythonPatches([{ files: [{ path, before: "", after: "" }] }]), /Invalid Python normalization path/);
  }
  await assert.rejects(normalizePythonPatches([{ files: [
    { path: "a.py", before: "", after: "" }, { path: "a.py", before: "", after: "" },
  ] }]), /Duplicate Python normalization path/);
  for (const timeoutMs of [0, -1, Infinity, NaN]) {
    await assert.rejects(normalizePythonPatches([], { timeoutMs }), /timeout must be positive and finite/);
  }
  for (const before of [null, 42, {}]) {
    await assert.rejects(normalizePythonPatches([{ files: [{ path: "a.py", before, after: "" }] }]), /sources must be strings/);
  }
  await assert.rejects(normalizePythonPatches([{ files: [], rawPatch: null }]), /rawPatch must be a string/);
  assert.deepEqual((await normalizePythonPatches([])).patches, []);
});

test("worker rejects unexpected runtime package versions without loading another runtime", async () => {
  const worker = new Worker(new URL("../extensions/swe-replay/python-normalization-worker.mjs", import.meta.url), {
    execArgv: [], workerData: { patches: [], pyodideVersion: "unexpected", pythonVersion: "3.14.2" },
  });
  try {
    const [result] = await once(worker, "message");
    assert.match(result.error.message, /Unsupported Pyodide version/);
    assert.equal(result.patches, undefined);
  } finally {
    await worker.terminate();
  }
});

test("pre-abort and timeout cancel normalization rather than choosing another policy", async () => {
  const input = { files: [{ path: "a.py", before: "x = 1", after: "x = 2" }] };
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  controller.abort(reason);
  await assert.rejects(normalizePythonPatches([input], { signal: controller.signal }), (error) => error === reason);
  await assert.rejects(normalizePythonPatches([input], { timeoutMs: 1 }), /normalization timed out/);
});

test("abort after worker creation terminates the request and permits a later independent batch", async () => {
  const input = { files: [{ path: "a.py", before: "x = 1", after: "x = 2" }] };
  const controller = new AbortController();
  const pending = normalizePythonPatches([input], { signal: controller.signal });
  controller.abort(new Error("abort in flight"));
  await assert.rejects(pending, /abort in flight/);

  const result = await normalizePythonPatches([input, {
    files: [{ path: "do-not-execute.py", before: "", after: "raise RuntimeError('source must not execute')" }],
  }]);
  assert.match(result.patches[0].key, /-x = 1/);
  assert.match(result.patches[0].key, /\+x = 2/);
  assert.match(result.patches[1].key, /\+raise RuntimeError/);
});
