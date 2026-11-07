import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/tsc/${name}.json`, import.meta.url), "utf8"));
const sources = load("source-pairs");
const helpers = load("helper-pairs");
const provenance = load("provenance");
const contract = load("contract");
const sourceById = new Map(sources.map((item) => [item.id, item]));
const helperById = new Map(helpers.map((item) => [item.id, item]));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = (source) => Buffer.from(source.content, source.encoding === "utf8" ? "utf8" : "base64");
const text = (source) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes(source));

function validateSource(source, label) {
  assert.deepEqual(Object.keys(source).sort(), ["content", "encoding", "sha256"], label);
  assert.ok(["utf8", "base64"].includes(source.encoding), label);
  assert.equal(typeof source.content, "string", label);
  const decoded = bytes(source);
  if (source.encoding === "base64") {
    assert.equal(decoded.toString("base64"), source.content, `${label}: canonical base64`);
    assert.throws(() => text(source), TypeError, `${label}: base64 reserved for invalid UTF-8`);
  } else {
    assert.equal(text(source), source.content, `${label}: lossless UTF-8`);
  }
  assert.match(source.sha256, /^[0-9a-f]{64}$/, label);
  assert.equal(sha256(decoded), source.sha256, `${label}: source bytes`);
}

function validateCase(item, expectedValues) {
  assert.equal(typeof item.id, "string");
  assert.ok(item.id.length > 0);
  assert.ok(["python", "typescript", "unknown"].includes(item.language), item.id);
  assert.ok(expectedValues.includes(item.expected), item.id);
  assert.equal(typeof item.rationale, "string", item.id);
  assert.ok(item.rationale.length > 0, item.id);
  assert.equal(typeof item.origin.file, "string", item.id);
  assert.equal(typeof item.origin.id, "string", item.id);
  // Expectations must not be generated canonical keys or prototype observations.
  assert.equal(Object.hasOwn(item, "keyHash"), false, item.id);
  assert.equal(Object.hasOwn(item, "observed"), false, item.id);
}

test("TSC fixtures preserve the reviewed input counts and unique identifiers", () => {
  assert.equal(sources.length, 71);
  assert.equal(sourceById.size, sources.length);
  assert.equal(helpers.length, 36);
  assert.equal(helperById.size, helpers.length);
  assert.equal(sources.filter((item) => item.id.startsWith("original:")).length, 27);
  assert.equal(sources.filter((item) => item.id.startsWith("supplemental:")).length, 44);
  assert.equal(helpers.filter((item) => item.id.startsWith("historical:")).length, 20);
  assert.equal(helpers.filter((item) => item.id.startsWith("residual:")).length, 16);
});

test("TSC source and helper inputs have explicit expectations and intact original bytes", () => {
  for (const item of sources) {
    validateCase(item, ["equivalent", "different", "fallback-required"]);
    validateSource(item.before, `${item.id}:before`);
    validateSource(item.after, `${item.id}:after`);
  }

  for (const item of helpers) {
    validateCase(item, ["equivalent", "different"]);
    assert.equal(typeof item.acceptedOrderingRisk, "boolean", item.id);
    for (const field of ["baseline", "candidateA", "candidateB"]) validateSource(item[field], `${item.id}:${field}`);
  }
});

test("TSC fixture provenance is self-contained metadata, not a dependency on ignored research", () => {
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.historicalSourcePairs, 71);
  assert.equal(provenance.historicalHelperPairs, 20);
  assert.equal(provenance.addedResidualPairs, 16);
  assert.match(provenance.helperRule, /D8-B/);
  assert.match(provenance.promotionScriptSha256, /^[0-9a-f]{64}$/);
  const origins = new Set(provenance.sourceArtifacts.map((item) => item.file));
  assert.equal(origins.size, provenance.sourceArtifacts.length);
  for (const artifact of provenance.sourceArtifacts) assert.match(artifact.sha256, /^[0-9a-f]{64}$/, artifact.file);
  for (const item of [...sources, ...helpers]) {
    if (item.origin.id === "D8-B") assert.equal(item.origin.file, "tests/fixtures/tsc/README.md");
    else assert.ok(origins.has(item.origin.file), item.id);
  }
});

test("TSC inputs retain the three interpolation requirements and distinguishing literal cases", () => {
  for (const id of ["py-fstring-expression-formatting", "ts-template-expression-formatting", "ts-template-expression-comment"]) {
    assert.equal(sourceById.get(`supplemental:${id}`).expected, "equivalent", id);
  }
  for (const id of ["py-second-string-expression", "py-function-docstring-promotion", "py-quote-spelling", "ts-template-blank-lines", "ts-template-trailing-space", "ts-template-crlf", "ts-template-expression-operator"]) {
    assert.equal(sourceById.get(`supplemental:${id}`).expected, "different", id);
  }
  const bom = sourceById.get("supplemental:py-bom");
  assert.equal(bom.expected, "different");
  assert.equal(bom.historicalExpected, "characterize");
  assert.equal(bom.policyDecision, "D5");
  assert.equal(text(bom.after), `\uFEFF${text(bom.before)}`);
});

test("TSC exact-fallback fixtures retain invalid encodings, NUL, missing tokens and final newlines", () => {
  for (const language of ["py", "ts"]) {
    const item = sourceById.get(`supplemental:${language}-invalid-utf8`);
    assert.equal(item.expected, "fallback-required");
    assert.throws(() => text(item.before), TypeError);
    assert.throws(() => text(item.after), TypeError);
    assert.notDeepEqual(bytes(item.before), bytes(item.after));
  }
  const nul = sourceById.get("supplemental:py-nul");
  assert.ok(bytes(nul.before).includes(0));
  assert.equal(nul.expected, "fallback-required");
  for (const id of ["py-missing-token-both", "ts-missing-token-both", "unknown-final-newline"]) {
    const item = sourceById.get(`supplemental:${id}`);
    assert.equal(item.expected, "fallback-required", id);
    assert.notDeepEqual(bytes(item.before), bytes(item.after), id);
  }
  const newline = sourceById.get("supplemental:unknown-final-newline");
  assert.equal(text(newline.after), `${text(newline.before)}\n`);
});

test("D8-B explicitly groups identical mixed edits and protects different residuals/helpers", () => {
  for (const language of ["python", "typescript"]) {
    for (const id of ["changed-caller-same-residual", "same-global-residual", "multiple-additions-mixed-edit", "no-added-helper", "removed-existing-function"]) {
      assert.equal(helperById.get(`residual:${language}:${id}`).expected, "equivalent", `${language}:${id}`);
    }
    for (const id of ["different-caller-residual", "different-global-residual", "different-helper-body"]) {
      assert.equal(helperById.get(`residual:${language}:${id}`).expected, "different", `${language}:${id}`);
    }
    const caller = helperById.get(`residual:${language}:changed-caller-same-residual`);
    assert.match(text(caller.candidateA), /return adjust\(value\)/);
    assert.match(text(caller.candidateB), /return adjust\(value\)/);
    assert.doesNotMatch(text(caller.baseline), /adjust/);
    assert.notEqual(text(caller.candidateA), text(caller.candidateB));
  }
});

test("historical ordering-risk and differing-global cases remain explicit under D8-B", () => {
  const risks = helpers.filter((item) => item.acceptedOrderingRisk);
  assert.deepEqual(risks.map((item) => item.id).sort(), ["historical:python:accepted-binding-order-risk", "historical:python:decorated-helper"]);
  for (const item of risks) assert.equal(item.expected, "equivalent", item.id);
  for (const language of ["python", "typescript"]) {
    assert.equal(helperById.get(`historical:${language}:global-edit`).expected, "different");
    assert.equal(helperById.get(`historical:${language}:duplicate-name`).expected, "different");
  }
});

test("P0 contract pins a distinct structural identity and the adopted residual rule", () => {
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.status, "p0-contract-not-runtime-support");
  assert.deepEqual(contract.choice.values, ["agentless", "tsc"]);
  assert.equal(contract.choice.default, "agentless");
  assert.equal(contract.choice.cancelBeforeRunCreation, true);
  assert.equal(contract.identity.policy, "complete-tree-tsc-mixed-v1");
  assert.equal(contract.identity.canonicalization, "tsc-canonical-tree-v1");
  assert.equal(contract.identity.helpers, "added-helper-residual-v1");
  assert.equal(contract.identity.registry, "python-typescript-files-v1");
  assert.equal(contract.identity.sourceFallback, "lossless-paired-source-v1");
  assert.equal(contract.identity.framing, "tagged-json-arrays-utf8-sha256-v1");
  assert.equal(contract.identity.requireResidualEqualBaseline, false);
  for (const field of ["retainLiteralSpelling", "retainExistingCodeOrder", "retainResidualEdits", "classifyDocumentationBeforeSubtraction", "emptyHelperCollectionUsesSameFrame"]) {
    assert.equal(contract.identity[field], true, field);
  }
});

test("P0 registry and encoding decisions are explicit rather than parser defaults", () => {
  assert.deepEqual(contract.languages.map(({ language, extensions }) => ({ language, extensions })), [
    { language: "python", extensions: [".py"] },
    { language: "typescript", extensions: [".ts"] },
  ]);
  assert.equal(contract.extensionMatching, "case-sensitive-byte-suffix");
  assert.deepEqual(contract.unsupportedExtensions, [".pyi", ".mts", ".cts", ".tsx", ".js", ".jsx"]);
  assert.ok(contract.unsupportedHelperForms.includes("default-export-function"));
  assert.ok(contract.unsupportedHelperForms.includes("ambient-or-no-body-declaration"));
  assert.equal(contract.duplicateFunctionNames, "disable-extraction-for-file");
  assert.equal(contract.encoding.decode, "strict-utf8");
  assert.equal(contract.encoding.bomOnlyDifference, "different");
  assert.equal(contract.encoding.leadingUtf8Bom, "parse-after-marker-retain-marker-in-source-envelope");
  assert.equal(contract.encoding.stripCarriageReturns, false);
  assert.equal(contract.encoding.rewriteFinalNewlines, false);
  assert.equal(sourceById.get("supplemental:py-bom").expected, contract.encoding.bomOnlyDifference);
});

test("P0 records require new explicit contracts without retroactively selecting legacy runs", () => {
  assert.equal(contract.persistence.newRunContractVersion, 1);
  assert.deepEqual(contract.persistence.newRecordVersions, {
    root: 2, base: 2, identity: 2, finalSelection: 2,
    candidate: 1, evaluation: 1, restoration: 1,
  });
  assert.equal(contract.persistence.legacyAgentless, "read-captured-v1-with-existing-explicit-provenance");
  assert.equal(contract.persistence.legacyAutomaticFinalization, false);
  assert.equal(contract.persistence.inferMissingNewContract, false);
  assert.equal(contract.persistence.mixedRunPolicies, "reject");
});

test("P0 pins offline assets and keeps measured limits as an explicit enablement gate", () => {
  assert.deepEqual(contract.dependencies.map(({ package: name, version, asset }) => [name, version, asset]), [
    ["web-tree-sitter", "0.27.1", "web-tree-sitter.wasm"],
    ["tree-sitter-python", "0.25.0", "tree-sitter-python.wasm"],
    ["tree-sitter-typescript", "0.23.2", "tree-sitter-typescript.wasm"],
  ]);
  for (const dependency of contract.dependencies) {
    assert.match(dependency.sha256, /^[0-9a-f]{64}$/, dependency.package);
    assert.equal(dependency.license, "MIT", dependency.package);
  }
  assert.equal(contract.execution.workersPerBatch, 1);
  assert.equal(contract.execution.batchTimeoutMs, 60000);
  assert.equal(contract.execution.runtimeNetwork, false);
  assert.equal(contract.execution.infrastructureErrors, "fatal-whole-batch");
  assert.equal(contract.execution.limitsAffectSuccessfulIdentity, false);
  const resource = contract.implementationGates.find((gate) => gate.id === "resource-profile");
  assert.equal(resource.owner, "P2");
  assert.equal(resource.status, "pending-measurement");
  for (const gate of contract.implementationGates) assert.equal(gate.blocksRuntimeEnablement, true, gate.id);
});
