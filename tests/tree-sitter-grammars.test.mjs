import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, symlink, lstat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { ensureTscGrammar, tscGrammarReleaseUrl, GrammarAcquisitionError, TSC_GRAMMAR_ACQUISITION_LIMITS } = await jiti.import("../extensions/swe-replay/tree-sitter-grammars.ts");
const { TSC_LANGUAGES, TSC_GRAMMAR_SOURCE_POLICY } = await jiti.import("../extensions/swe-replay/normalization-policy.ts");
const contract = JSON.parse(readFileSync(new URL("./fixtures/tsc/contract.json", import.meta.url), "utf8"));
const assets = new Map(TSC_LANGUAGES.map((pin) => {
  // Trusted, hash-checked test seed only. The production fetcher never uses npm.
  const bytes = readFileSync(path.join(path.dirname(require.resolve(`${pin.package}/package.json`)), pin.asset));
  assert.equal(bytes.length, pin.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256);
  return [pin.language, bytes];
}));
const python = TSC_LANGUAGES.find((entry) => entry.language === "python");
const cachedFile = (cacheDir, pin = python) => path.join(cacheDir, `${pin.sha256}.wasm`);
const noNetwork = () => { throw new Error("Unexpected network access"); };
const code = (expected) => (error) => error instanceof GrammarAcquisitionError && error.code === expected;

async function cache(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "tsc-grammar-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function success(language = "python", options = {}) {
  return new Response(assets.get(language), { status: 200, ...options });
}
async function noTemporaryFiles(directory) {
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
}
async function waitForWrittenTemporary(directory) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    for (const name of await readdir(directory)) {
      if (name.endsWith(".tmp") && (await lstat(path.join(directory, name))).size > 0) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("No partially written download observed");
}

test("release registry uses only pinned standalone tree-sitter organization assets", async (t) => {
  assert.equal(TSC_GRAMMAR_SOURCE_POLICY, "tree-sitter-github-releases-v1");
  assert.equal(contract.grammarAcquisition.policy, TSC_GRAMMAR_SOURCE_POLICY);
  assert.ok(Object.isFrozen(TSC_GRAMMAR_ACQUISITION_LIMITS));
  for (const [field, value] of Object.entries(TSC_GRAMMAR_ACQUISITION_LIMITS)) {
    assert.equal(contract.grammarAcquisition[field], value, field);
  }
  assert.equal(contract.grammarAcquisition.mirrorsOrAggregators, false);
  assert.equal(contract.grammarAcquisition.arbitraryUrlConfiguration, false);
  assert.equal(contract.execution.runtimeNetwork, false, "normalization remains offline");
  assert.equal(contract.grammarAcquisition.networkAllowedInProvisioning, true);
  const cacheDir = await cache(t);
  for (const pin of TSC_LANGUAGES) {
    const fixture = contract.grammarAcquisition.sources.find((entry) => entry.language === pin.language);
    for (const field of ["repository", "releaseTag", "asset", "bytes"]) assert.equal(pin[field], fixture[field]);
    const expected = `https://github.com/tree-sitter/${pin.package}/releases/download/v${pin.version}/${pin.asset}`;
    assert.equal(tscGrammarReleaseUrl(pin.language), expected);
    let calls = 0;
    const result = await ensureTscGrammar(pin.language, { cacheDir, fetch: async (url, options) => {
      assert.equal(url, expected);
      assert.equal(options.method, "GET");
      assert.equal(options.body, undefined);
      assert.equal(options.redirect, "manual");
      assert.equal(options.credentials, "omit");
      assert.equal(options.signal.aborted, false);
      calls++;
      return success(pin.language);
    } });
    assert.equal(calls, 1);
    assert.equal(result.sourcePolicy, TSC_GRAMMAR_SOURCE_POLICY);
    assert.ok(Object.isFrozen(result));
    assert.equal(result.repository, pin.repository);
    assert.equal(result.releaseTag, `v${pin.version}`);
    assert.equal(result.cacheStatus, "downloaded");
    assert.equal(result.path, cachedFile(cacheDir, pin));
    assert.deepEqual(await readFile(result.path), assets.get(pin.language));
  }
  await noTemporaryFiles(cacheDir);
});

test("verified cache hits work offline without calling any transport", async (t) => {
  const cacheDir = await cache(t);
  await writeFile(cachedFile(cacheDir), assets.get("python"));
  const result = await ensureTscGrammar("python", { cacheDir, offline: true, fetch: noNetwork });
  assert.equal(result.cacheStatus, "hit");
  assert.equal(result.sha256, python.sha256);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    assert.equal((await ensureTscGrammar("python", { cacheDir, offline: true })).cacheStatus, "hit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing or corrupt offline assets fail instead of silently becoming exact-content votes", async (t) => {
  const cacheDir = await cache(t);
  await assert.rejects(ensureTscGrammar("python", { cacheDir, offline: true, fetch: noNetwork }), code("cache-miss"));
  await writeFile(cachedFile(cacheDir), "corrupt");
  await assert.rejects(ensureTscGrammar("python", { cacheDir, offline: true, fetch: noNetwork }), code("cache-miss"));
  assert.equal(await readFile(cachedFile(cacheDir), "utf8"), "corrupt");
  await noTemporaryFiles(cacheDir);
});

test("same-size corrupted cache is rehashed and repaired only by a verified download", async (t) => {
  const cacheDir = await cache(t);
  const corrupt = Buffer.from(assets.get("python"));
  corrupt[corrupt.length - 1] ^= 1;
  await writeFile(cachedFile(cacheDir), corrupt);
  await assert.rejects(ensureTscGrammar("python", { cacheDir, fetch: async () => new Response(corrupt) }), code("integrity-error"));
  assert.deepEqual(await readFile(cachedFile(cacheDir)), corrupt, "failed download must not overwrite the existing entry");
  const result = await ensureTscGrammar("python", { cacheDir, fetch: async () => success() });
  assert.equal(result.cacheStatus, "repaired");
  assert.deepEqual(await readFile(result.path), assets.get("python"));
  await noTemporaryFiles(cacheDir);
});

test("only GitHub asset CDN redirects are followed, manually and with no alternative providers", async (t) => {
  const cacheDir = await cache(t);
  const signed = "https://release-assets.githubusercontent.com/github-production-release-asset/test?signature=temporary";
  const requests = [];
  const result = await ensureTscGrammar("python", { cacheDir, fetch: async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, "manual");
    return requests.length === 1 ? new Response(null, { status: 302, headers: { location: signed } }) : success();
  } });
  assert.deepEqual(requests, [tscGrammarReleaseUrl("python"), signed]);
  assert.equal(result.cacheStatus, "downloaded");
  assert.equal(JSON.stringify(result).includes("signature="), false, "do not persist signed CDN query strings");
});

test("unsafe redirect targets are rejected before a second request", async (t) => {
  const cacheDir = await cache(t);
  for (const location of ["http://release-assets.githubusercontent.com/x", "https://example.com/x",
    "https://github.com/other/provider/releases/download/v1/a.wasm", "https://127.0.0.1/x",
    "https://user:password@release-assets.githubusercontent.com/x", "https://release-assets.githubusercontent.com:8443/x",
    "https://release-assets.githubusercontent.com.evil.test/x", "https://release-assets.githubusercontent.com/x#fragment"]) {
    let calls = 0;
    await assert.rejects(ensureTscGrammar("python", { cacheDir, fetch: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location } });
    } }), code("invalid-redirect"));
    assert.equal(calls, 1, location);
  }
  assert.deepEqual(await readdir(cacheDir), []);
});

test("missing/looping redirects and a transport that automatically redirected are explicit failures", async (t) => {
  const cacheDir = await cache(t);
  await assert.rejects(ensureTscGrammar("python", { cacheDir, fetch: async () => new Response(null, { status: 302 }) }), code("invalid-redirect"));
  let calls = 0;
  await assert.rejects(ensureTscGrammar("python", { cacheDir, fetch: async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/loop" } });
  } }), code("invalid-redirect"));
  assert.equal(calls, 4);
  const redirected = success();
  Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(ensureTscGrammar("python", { cacheDir, fetch: async () => redirected }), code("invalid-redirect"));
});

test("HTTP failures retain bounded status/body evidence and never try mirrors", async (t) => {
  const cacheDir = await cache(t);
  let calls = 0;
  const explanation = "Approval required for github.com\n";
  await assert.rejects(ensureTscGrammar("python", { cacheDir, fetch: async () => {
    calls++;
    return new Response(explanation + "x".repeat(8000), { status: 403 });
  } }), (error) => {
    assert.equal(error.code, "http-error");
    assert.equal(error.httpStatus, 403);
    assert.ok(error.responseBody.startsWith(explanation));
    assert.equal(Buffer.byteLength(error.responseBody), 2048);
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(ensureTscGrammar("python", { cacheDir, fetch: async () => new Response("not found", { status: 404 }) }), code("http-error"));
  await noTemporaryFiles(cacheDir);
});

test("oversized headers/streams, truncated and mismatched bytes never enter the ready cache", async (t) => {
  const cacheDir = await cache(t);
  const tooLarge = Buffer.alloc(python.bytes + 1);
  const responses = [
    () => success("python", { headers: { "content-length": String(python.bytes + 1) } }),
    () => new Response(tooLarge),
    () => new Response(assets.get("python").subarray(0, 100)),
    () => new Response(Buffer.alloc(python.bytes)),
    () => new Response(null, { status: 200 }),
  ];
  for (const response of responses) {
    await assert.rejects(ensureTscGrammar("python", { cacheDir, fetch: async () => response() }), code("integrity-error"));
    assert.deepEqual(await readdir(cacheDir), []);
  }
});

test("concurrent downloads install only whole, hash-verified content", async (t) => {
  const cacheDir = await cache(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => ensureTscGrammar("python", { cacheDir, fetch: async () => success() })));
  assert.ok(results.every((result) => result.path === cachedFile(cacheDir)));
  assert.deepEqual(await readFile(cachedFile(cacheDir)), assets.get("python"));
  assert.deepEqual(await readdir(cacheDir), [`${python.sha256}.wasm`]);
});

test("pre-abort and invalid requests create no cache or network side effects", async (t) => {
  const root = await cache(t);
  const cacheDir = path.join(root, "not-created");
  const controller = new AbortController();
  const reason = new Error("user cancelled");
  controller.abort(reason);
  await assert.rejects(ensureTscGrammar("python", { cacheDir, signal: controller.signal, fetch: noNetwork }), (error) => error === reason);
  for (const timeoutMs of [0, -1, 1.5, Infinity, NaN, 120001]) {
    await assert.rejects(ensureTscGrammar("python", { cacheDir, timeoutMs, fetch: noNetwork }), code("invalid-request"));
  }
  await assert.rejects(ensureTscGrammar("rust", { cacheDir, fetch: noNetwork }), code("invalid-request"));
  await assert.rejects(ensureTscGrammar("python", { cacheDir, offline: "false", fetch: noNetwork }), code("invalid-request"));
  assert.deepEqual(await readdir(root), []);
});

test("timeout and during-stream cancellation reject and clean partial files", async (t) => {
  const cacheDir = await cache(t);
  await assert.rejects(ensureTscGrammar("python", { cacheDir, timeoutMs: 20, fetch: async (_url, { signal }) => {
    return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } }), code("timeout"));

  const controller = new AbortController();
  const reason = new Error("cancel mid-stream");
  const operation = ensureTscGrammar("python", { cacheDir, signal: controller.signal, fetch: async (_url, { signal }) => {
    let onAbort;
    return new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(assets.get("python").subarray(0, 100));
        onAbort = () => stream.error(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      },
      cancel() { signal.removeEventListener("abort", onAbort); },
    }));
  } });
  await waitForWrittenTemporary(cacheDir);
  controller.abort(reason);
  await assert.rejects(operation, (error) => error === reason);
  await noTemporaryFiles(cacheDir);
  await assert.rejects(readFile(cachedFile(cacheDir)), { code: "ENOENT" });
});

test("acquisition snapshots options and removes listeners from the original abort signal", async (t) => {
  const cacheDir = await cache(t);
  const original = new AbortController();
  const options = { cacheDir, offline: true, signal: original.signal, fetch: noNetwork };
  const operation = ensureTscGrammar("python", options);
  options.offline = false;
  options.signal = new AbortController().signal;
  await assert.rejects(operation, code("cache-miss"));
  assert.equal(getEventListeners(original.signal, "abort").length, 0);
  assert.deepEqual(await readdir(cacheDir), []);
});

test("transport errors do not leak signed query strings", async (t) => {
  const cacheDir = await cache(t);
  let calls = 0;
  await assert.rejects(ensureTscGrammar("python", { cacheDir, fetch: async () => {
    if (++calls === 1) return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/x?signature=secret" } });
    throw new Error("failed fetching ?signature=secret");
  } }), (error) => {
    assert.equal(error.code, "network-error");
    assert.equal(String(error).includes("secret"), false);
    return true;
  });
});

test("cache errors are fatal; cache symlinks are replaced without touching their targets", { skip: process.platform === "win32" }, async (t) => {
  const cacheDir = await cache(t);
  const outside = path.join(cacheDir, "outside");
  await writeFile(outside, "untouched");
  await symlink(outside, cachedFile(cacheDir));
  const result = await ensureTscGrammar("python", { cacheDir, fetch: async () => success() });
  assert.equal(result.cacheStatus, "repaired");
  assert.equal(await readFile(outside, "utf8"), "untouched");
  assert.equal((await lstat(cachedFile(cacheDir))).isSymbolicLink(), false);

  await rm(cachedFile(cacheDir));
  await mkdir(cachedFile(cacheDir));
  await assert.rejects(ensureTscGrammar("python", { cacheDir, fetch: async () => success() }), code("cache-error"));
  await noTemporaryFiles(cacheDir);
});
