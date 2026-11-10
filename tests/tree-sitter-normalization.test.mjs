import assert from "node:assert/strict";
import { mkdtemp, copyFile, rm, readFile, writeFile, readdir, mkdir, cp, symlink } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { getEventListeners } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { normalizeTscSources } = await jiti.import("../extensions/swe-replay/tree-sitter-normalization.ts");
const { tscHelperResidual } = await jiti.import("../extensions/swe-replay/tree-sitter-helpers.ts");
const { TSC_LANGUAGES, TSC_CANONICALIZATION_POLICY, tscSourceProvenance } = await jiti.import("../extensions/swe-replay/normalization-policy.ts");
const { tscLimits, TSC_NORMALIZATION_LIMITS, TSC_RESOURCE_PROFILE } = await jiti.import("../extensions/swe-replay/tree-sitter-limits.ts");
const { executeTscWorker } = await jiti.import("../extensions/swe-replay/tree-sitter-worker-client.ts");
const { TSC_WORKER_PROTOCOL, prepareTscSources, validateTscWorkerRequest } = await jiti.import("../extensions/swe-replay/tree-sitter-protocol.ts");
const corpus = JSON.parse(readFileSync(new URL("./fixtures/tsc/source-pairs.json", import.meta.url), "utf8"));
const contract = JSON.parse(readFileSync(new URL("./fixtures/tsc/contract.json", import.meta.url), "utf8"));
const fixtureWorker = new URL("./fixtures/tsc-worker.mjs", import.meta.url);
const actualWorker = new URL("../extensions/swe-replay/tree-sitter-normalization-worker.mjs", import.meta.url);
const input = (id = "x", source = "x=1\n", extension = ".py") => ({ id, path: Buffer.from(`input${extension}`), content: Buffer.from(source) });
const blob = (value) => Buffer.from(value.content, value.encoding === "utf8" ? "utf8" : "base64");
const noNetwork = () => { throw new Error("Unexpected host network request"); };
const resource = (limit) => (error) => error.code === "resource-limit" && error.limit === limit;

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "tsc-worker-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assets = [];
  for (const pin of TSC_LANGUAGES) {
    const filename = path.join(directory, `${pin.sha256}.wasm`);
    await copyFile(path.join(path.dirname(require.resolve(`${pin.package}/package.json`)), pin.asset), filename);
    assets.push({ language: pin.language, path: filename });
  }
  return { directory, assets, options: { grammar: { cacheDir: directory, offline: true, fetch: noNetwork } } };
}
function request(sources, assets, limits = tscLimits()) {
  return { protocolVersion: TSC_WORKER_PROTOCOL, resourceProfile: TSC_RESOURCE_PROFILE, sources: prepareTscSources(sources, limits), assets, limits,
    provenance: tscSourceProvenance(assets.map((asset) => asset.language)) };
}
function worker(mode, payload, memory = 64) {
  return new Worker(fixtureWorker, { execArgv: [], workerData: { mode, payload }, resourceLimits: { maxOldGenerationSizeMb: memory } });
}
async function ownedExecution(w, req, signal = AbortSignal.timeout(5000), progress) {
  try { return await executeTscWorker(w, req, signal, progress); }
  finally {
    assert.equal(w.threadId, -1, "worker must be terminated before settling");
    assert.equal(w.listenerCount("message"), 0);
    assert.equal(w.listenerCount("error"), 0);
    assert.equal(getEventListeners(signal, "abort").length, 0);
  }
}

test("resource profile and production loader/runtime dependencies match the frozen contract", () => {
  assert.equal(TSC_RESOURCE_PROFILE, contract.resourceProfile.name);
  assert.equal(TSC_WORKER_PROTOCOL, contract.resourceProfile.workerProtocolVersion);
  assert.deepEqual(TSC_NORMALIZATION_LIMITS, contract.resourceProfile.limits);
  assert.ok(Object.isFrozen(TSC_NORMALIZATION_LIMITS));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies.jiti, contract.trustedCodeLoader.version);
  assert.equal(pkg.dependencies["web-tree-sitter"], "0.27.1");
  assert.equal(pkg.dependencies["tree-sitter-python"], undefined);
  assert.equal(pkg.dependencies["tree-sitter-typescript"], undefined);
});

test("bounded offline worker matches all 71 source cases and is deterministic across fresh workers", async (t) => {
  const { options } = await setup(t);
  const sources = corpus.flatMap((item, index) => [
    { id: `p${index}-before`, path: Buffer.from(item.language === "unknown" ? "x.unknown" : `x.${item.language === "python" ? "py" : "ts"}`), content: blob(item.before) },
    { id: `p${index}-after`, path: Buffer.from(item.language === "unknown" ? "x.unknown" : `x.${item.language === "python" ? "py" : "ts"}`), content: blob(item.after) },
  ]);
  const first = await normalizeTscSources(sources, options);
  const second = await normalizeTscSources([...sources].reverse(), options);
  const byId = new Map(second.results.map((result) => [result.id, result]));
  assert.equal(first.provenance.canonicalization, TSC_CANONICALIZATION_POLICY);
  assert.equal(first.resourceProfile, TSC_RESOURCE_PROFILE);
  for (const result of first.results) assert.deepEqual(result, byId.get(result.id));
  for (const [index, item] of corpus.entries()) {
    const [a, b] = first.results.slice(index * 2, index * 2 + 2);
    if (item.expected === "fallback-required") assert.ok(a.kind === "exact" || b.kind === "exact", item.id);
    else {
      assert.equal(a.kind, "canonical", item.id);
      assert.equal(b.kind, "canonical", item.id);
      assert.equal(a.canonical === b.canonical, item.expected === "equivalent", item.id);
      assert.equal(Buffer.byteLength(a.canonical), a.metrics.canonicalBytes);
    }
  }
});

test("helper residuals from offline worker sources match all 36 pairs across fresh workers and input order", async (t) => {
  const { options } = await setup(t);
  const helpers = JSON.parse(readFileSync(new URL("./fixtures/tsc/helper-pairs.json", import.meta.url), "utf8"));
  const sources = helpers.flatMap((item, index) => ["baseline", "candidateA", "candidateB"].map((side) => ({
    id: `${index}-${side}`, path: Buffer.from(item.language === "python" ? "x.py" : "x.ts"), content: blob(item[side]),
  })));
  const first = await normalizeTscSources(sources, options);
  const second = await normalizeTscSources([...sources].reverse(), options);
  const project = (batch) => {
    const byId = new Map(batch.results.map((result) => {
      assert.equal(result.kind, "canonical", result.id);
      return [result.id, JSON.parse(result.canonical)];
    }));
    return helpers.map((item, index) => {
      const baseline = byId.get(`${index}-baseline`);
      const a = tscHelperResidual(item.language, baseline, byId.get(`${index}-candidateA`));
      const b = tscHelperResidual(item.language, baseline, byId.get(`${index}-candidateB`));
      assert.equal(JSON.stringify(a) === JSON.stringify(b), item.expected === "equivalent", item.id);
      return [a, b];
    });
  };
  assert.deepEqual(project(first), project(second));
});

test("the batch snapshots input/options and deduplicates only equal language/raw-source pairs", async (t) => {
  const { options } = await setup(t);
  const a = input("a");
  const b = input("b");
  const progress = [];
  const settings = { ...options, onProgress: (event) => progress.push(event) };
  const operation = normalizeTscSources([a, b, input("typescript", "x=1\n", ".ts")], settings);
  a.content.fill(0);
  settings.grammar = { cacheDir: "/nonexistent", offline: true };
  const result = await operation;
  assert.equal(result.results[0].kind, "canonical");
  assert.equal(result.results[0].canonical, result.results[1].canonical);
  assert.equal(progress.filter((event) => event.phase === "canonicalizing").length, 2);
  assert.notEqual(result.results[0].canonical, result.results[2].canonical);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.provenance));
  assert.ok(Object.isFrozen(result.results));
  assert.ok(Object.isFrozen(result.results[0]));
  assert.ok(Object.isFrozen(result.results[0].metrics));
  assert.throws(() => { result.results[0].metrics.nodes = -1; }, TypeError);
});

test("empty, unsupported and invalid sources never execute source or require a host compiler", async (t) => {
  const { options, directory } = await setup(t);
  assert.deepEqual((await normalizeTscSources([], { grammar: { fetch: noNetwork } })).results, []);
  const marker = path.join(directory, "must-not-exist");
  const result = await normalizeTscSources([
    input("unknown", "anything", ".unknown"),
    { ...input("invalid"), content: Buffer.from([0xff]) },
    { ...input("nul"), content: Buffer.from([0]) },
    input("missing", "def f(:\n pass\n"),
    input("python-code", `__import__('pathlib').Path(${JSON.stringify(marker)}).write_text('executed')\n`),
    input("ts-code", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`, ".ts"),
  ], options);
  assert.deepEqual(result.results.slice(0, 4).map((entry) => entry.kind), ["exact", "exact", "exact", "exact"]);
  assert.ok(result.results.slice(4).every((entry) => entry.kind === "canonical"));
  assert.equal(existsSync(marker), false);
});

test("invalid requests and pre-abort fail before provisioning/worker startup", async () => {
  const phases = [];
  const options = { grammar: { fetch: noNetwork }, onProgress: (event) => phases.push(event) };
  for (const bad of [null, {}, [input(), input()], [{ ...input(), content: "source" }], [{ ...input(), id: "\n" }],
    [{ ...input(), content: new Uint8Array(new SharedArrayBuffer(10)) }]]) {
    await assert.rejects(normalizeTscSources(bad, options), TypeError);
  }
  for (const limits of [{ maxDepth: 0 }, { unknown: 1 }, { maxDepth: TSC_NORMALIZATION_LIMITS.maxDepth + 1 }, { workerHeapMb: 1 }, { workerStackMb: 1 }]) {
    await assert.rejects(normalizeTscSources([input()], { ...options, limits }), TypeError);
  }
  for (const timeoutMs of [0, Infinity, 60001, 0.5]) await assert.rejects(normalizeTscSources([input()], { ...options, timeoutMs }), TypeError);
  const controller = new AbortController();
  const reason = new Error("cancel before start");
  controller.abort(reason);
  await assert.rejects(normalizeTscSources([], { ...options, signal: controller.signal }), (error) => error === reason);
  assert.deepEqual(phases, []);
});

test("parent preflight bounds repeated/unique bytes, count and paths before acquiring assets", async () => {
  const options = { grammar: { fetch: noNetwork } };
  await assert.rejects(normalizeTscSources([input()], { ...options, limits: { maxSourceBytes: 3 } }), resource("maxSourceBytes"));
  await assert.rejects(normalizeTscSources([input()], { ...options, limits: { maxPathBytes: 1 } }), resource("maxPathBytes"));
  await assert.rejects(normalizeTscSources([input()], { ...options, limits: { maxBatchBytes: 3 } }), resource("maxBatchBytes"));
  await assert.rejects(normalizeTscSources([input("a"), input("b")], { ...options, limits: { maxSources: 1 } }), resource("maxSources"));
  await assert.rejects(normalizeTscSources([input("a"), input("b", "x=2\n")], { ...options, limits: { maxUniqueSources: 1 } }), resource("maxUniqueSources"));
  await assert.rejects(normalizeTscSources([input()], { ...options, limits: { maxUniqueBytes: 3 } }), resource("maxUniqueBytes"));
});

test("exact/over node, depth, per-source and cumulative output boundaries are fatal, not fallback", async (t) => {
  const { options } = await setup(t);
  const baseline = (await normalizeTscSources([input()], options)).results[0];
  for (const [limit, value] of [["maxPathBytes", input().path.byteLength], ["maxSourceNodes", baseline.metrics.nodes], ["maxBatchNodes", baseline.metrics.nodes],
    ["maxDepth", baseline.metrics.depth], ["maxSourceCanonicalBytes", baseline.metrics.canonicalBytes],
    ["maxBatchCanonicalBytes", baseline.metrics.canonicalBytes]]) {
    const exact = await normalizeTscSources([input()], { ...options, limits: { [limit]: value } });
    assert.equal(exact.results[0].canonical, baseline.canonical, limit);
    await assert.rejects(normalizeTscSources([input()], { ...options, limits: { [limit]: value - 1 } }), resource(limit));
  }
  await assert.rejects(normalizeTscSources([input()], { ...options, limits: { maxResponseBytes: 1 } }), resource("maxResponseBytes"));
  await assert.rejects(normalizeTscSources([input("first"), input("second", "y=2\n")],
    { ...options, limits: { maxBatchCanonicalBytes: baseline.metrics.canonicalBytes } }), resource("maxBatchCanonicalBytes"));
  await assert.rejects(normalizeTscSources([input("malformed", "def f(:\n pass\n")],
    { ...options, limits: { maxSourceNodes: 1 } }), resource("maxSourceNodes"));
  await assert.rejects(normalizeTscSources([input("ignored-comment", "# otherwise normalization-empty\n")],
    { ...options, limits: { maxSourceNodes: 1 } }), resource("maxSourceNodes"));
});

test("during-provisioning/worker abort, timeout and progress callback failures discard the whole batch", async (t) => {
  const { options } = await setup(t);
  const controller = new AbortController();
  const reason = new Error("cancel actual worker phase");
  await assert.rejects(normalizeTscSources([input()], { ...options, signal: controller.signal, onProgress(event) {
    if (event.phase === "canonicalizing") controller.abort(reason);
  } }), (error) => error === reason);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const beforeWorker = new AbortController();
  const earlyReason = new Error("cancel provisioning");
  await assert.rejects(normalizeTscSources([input()], { ...options, signal: beforeWorker.signal, onProgress(event) {
    if (event.phase === "provisioning") beforeWorker.abort(earlyReason);
  } }), (error) => error === earlyReason);
  await assert.rejects(normalizeTscSources([input()], { ...options, timeoutMs: 1 }), (error) => error.code === "timeout");
  const callbackError = new Error("UI callback failed");
  await assert.rejects(normalizeTscSources([input()], { ...options, onProgress(event) {
    if (event.phase === "assets-verified") throw callbackError;
  } }), (error) => error === callbackError);
});

test("worker ignores inherited Node/Pi loader and jiti cache flags; no runtime fetch or PATH tools", async (t) => {
  const { options, directory } = await setup(t);
  const names = ["NODE_OPTIONS", "NODE_PATH", "JITI_FS_CACHE", "PATH"];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const args = [...process.execArgv];
  try {
    process.env.NODE_OPTIONS = "--require=/definitely-not-a-real-loader";
    process.env.NODE_PATH = "/definitely-not-a-module-directory";
    process.env.JITI_FS_CACHE = path.join(directory, "must-not-cache");
    process.env.PATH = "";
    process.execArgv.push("--require=/definitely-not-a-real-loader");
    assert.equal((await normalizeTscSources([input()], options)).results[0].kind, "canonical");
    assert.equal(existsSync(process.env.JITI_FS_CACHE), false);
  } finally {
    process.execArgv.splice(0, process.execArgv.length, ...args);
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});

test("worker revalidates missing/corrupt grammar assets independently of host cache receipts", async (t) => {
  const { directory, assets } = await setup(t);
  const source = input();
  for (const filename of [path.join(directory, "missing.wasm"), assets[0].path]) {
    if (filename === assets[0].path) {
      const corrupt = await readFile(filename); corrupt[0] ^= 1; await writeFile(filename, corrupt);
    }
    const w = new Worker(actualWorker, { execArgv: [] });
    await assert.rejects(ownedExecution(w, request([source], [{ language: "python", path: filename }])), (error) => error.code === "infrastructure");
  }
  await assert.rejects(normalizeTscSources([source], { grammar: { cacheDir: directory, offline: true } }), (error) => error.code === "cache-miss");
});

test("installed worker rejects wrong runtime versions and missing/corrupt runtime WASM", async (t) => {
  const { directory, assets } = await setup(t);
  const fixture = path.join(directory, "installed");
  const extension = path.join(fixture, "extensions");
  const modules = path.join(fixture, "node_modules");
  await mkdir(extension, { recursive: true });
  await mkdir(modules);
  const actual = path.dirname(fileURLToPath(actualWorker));
  for (const file of await readdir(actual)) {
    if (file === "normalization-policy.ts" || file.startsWith("tree-sitter-") && /\.(ts|mjs)$/.test(file)) {
      await copyFile(path.join(actual, file), path.join(extension, file));
    }
  }
  // A disposable installed-package fixture, never editing project node_modules.
  await symlink(path.dirname(require.resolve("jiti/package.json")), path.join(modules, "jiti"), process.platform === "win32" ? "junction" : "dir");
  const runtime = path.join(modules, "web-tree-sitter");
  await cp(path.dirname(require.resolve("web-tree-sitter")), runtime, { recursive: true });
  const packageFile = path.join(runtime, "package.json");
  const metadata = JSON.parse(await readFile(packageFile, "utf8"));
  const wasmFile = path.join(runtime, "web-tree-sitter.wasm");
  const original = await readFile(wasmFile);
  for (const mode of ["version", "metadata-size", "missing", "hash"]) {
    await writeFile(packageFile, JSON.stringify({ ...metadata, version: mode === "version" ? "unsupported" : metadata.version,
      ...(mode === "metadata-size" ? { testPadding: "x".repeat(65536) } : {}) }));
    if (mode === "missing") await rm(wasmFile);
    else {
      const bytes = Buffer.from(original);
      if (mode === "hash") bytes[0] ^= 1;
      await writeFile(wasmFile, bytes);
    }
    const w = new Worker(path.join(extension, "tree-sitter-normalization-worker.mjs"), { execArgv: [] });
    await assert.rejects(ownedExecution(w, request([input()], [assets[0]])), (error) => error.code === "infrastructure");
  }
});

test("worker request validation rejects bad versions/assets/limits without parsing source", () => {
  assert.throws(() => validateTscWorkerRequest({}), /protocol/);
  const valid = request([input()], [{ language: "python", path: "/tmp/a.wasm" }]);
  for (const bad of [{ ...valid, protocolVersion: 99 }, { ...valid, resourceProfile: "unsupported" }, { ...valid, assets: [] },
    { ...valid, assets: [{ language: "rust", path: "/tmp/a.wasm" }] },
    { ...valid, assets: [{ language: "python", path: "relative.wasm" }] },
    { ...valid, provenance: { ...valid.provenance, sourcePolicy: "mirror" } },
    { ...valid, limits: {} }, { ...valid, limits: { ...valid.limits, unexpected: 1 } }]) assert.throws(() => validateTscWorkerRequest(bad));
});

test("worker transport rejects corrupt/oversized messages, bad progress and premature exits; always terminates", async () => {
  const req = request([input()], [{ language: "python", path: "/tmp/not-loaded-by-fault-fixture" }], tscLimits({ maxResponseBytes: 1000 }));
  for (const mode of ["raw-object", "bad-json", "bad-progress", "exit", "throw", "oversize"]) {
    const w = worker(mode);
    await assert.rejects(ownedExecution(w, req), (error) => ["protocol", "infrastructure", "resource-limit"].includes(error.code));
  }
  const w = worker("hang");
  await assert.rejects(ownedExecution(w, req, AbortSignal.timeout(50)));
  const controller = new AbortController();
  controller.abort(new Error("pre-aborted driver"));
  await assert.rejects(ownedExecution(worker("hang"), req, controller.signal), /pre-aborted driver/);
  const invalidPlan = { ...req, sources: [input("a"), input("b", "x=2")], limits: tscLimits({ maxUniqueSources: 1 }) };
  await assert.rejects(ownedExecution(worker("hang"), invalidPlan), resource("maxUniqueSources"));
});

test("worker JS heap exhaustion is a fatal explicit failure with cleanup", async () => {
  const w = worker("oom", undefined, 16);
  await assert.rejects(ownedExecution(w, request([input()], [{ language: "python", path: "/tmp/not-loaded" }]), AbortSignal.timeout(5000)),
    (error) => error.code === "worker-oom");
});

test("response validation rejects associations, schema and canonical-frame corruption", async (t) => {
  const { options, assets } = await setup(t);
  const result = (await normalizeTscSources([input()], options)).results[0];
  const source = { ...result }; delete source.id;
  const payload = { protocolVersion: 1, type: "success", provenance: tscSourceProvenance(["python"]),
    resourceProfile: TSC_RESOURCE_PROFILE, sources: [source], results: [{ id: "x", sourceIndex: 0 }] };
  const variants = [
    { ...payload, protocolVersion: 99 }, { ...payload, provenance: { ...payload.provenance, canonicalization: "unsupported" } },
    { ...payload, results: [{ id: "wrong", sourceIndex: 0 }] },
    { ...payload, results: [{ id: "x", sourceIndex: 1 }] },
    { ...payload, sources: [{ ...source, canonical: "[]", metrics: { ...source.metrics, canonicalBytes: 2 } }] },
    { ...payload, sources: [{ ...source, metrics: { ...source.metrics, nodes: -1 } }] },
    { ...payload, sources: [{ ...source, canonical: `${source.canonical} `,
      metrics: { ...source.metrics, canonicalBytes: source.metrics.canonicalBytes + 1 } }] },
    { ...payload, sources: [{ ...source, canonical: source.canonical.replace('"utf8"', '"utf8-bom"'),
      metrics: { ...source.metrics, canonicalBytes: source.metrics.canonicalBytes + 4 } }] },
  ];
  for (const value of variants) {
    await assert.rejects(ownedExecution(worker("payload", value), request([input()], [assets[0]])), (error) => error.code === "protocol");
  }
});
