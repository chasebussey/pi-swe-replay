import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { overviewArchive } from "./fixtures/overview.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const policy = await jiti.import("../extensions/swe-replay/normalization-policy.ts");
const contracts = await jiti.import("../extensions/swe-replay/normalization-contract.ts");
const { parsePatchNormalization, capturePatchNormalization } = await jiti.import("../extensions/swe-replay/normalization-records.ts");
const { readReplayArchive, completedSelectionInputs } = await jiti.import("../extensions/swe-replay/replay-records.ts");
const { parseFinalSelectionRecord } = await jiti.import("../extensions/swe-replay/overview-records.ts");
const { buildReplayOverview } = await jiti.import("../extensions/swe-replay/overview-model.ts");
const { selectFinalPatch } = await jiti.import("../extensions/swe-replay/final-selection.ts");
const { finalizeReplay } = await jiti.import("../extensions/swe-replay/finalize-run.ts");
const data = (entries, id) => entries.find((entry) => entry.id === id).data;
const read = (entries) => readReplayArchive(entries, "root");
const code = (entries, expected) => {
  const result = read(entries);
  assert.equal(result.status, "unavailable");
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === expected), JSON.stringify(result.diagnostics));
};

for (const choice of ["agentless", "tsc"]) {
  test(`${choice}: immutable explicit contract/execution round-trip and order-independent equality`, () => {
    const resolved = contracts.resolveNormalization(choice, { timeoutMs: 12345 });
    assert.ok(Object.isFrozen(resolved));
    assert.ok(Object.isFrozen(resolved.normalizationContract));
    assert.ok(Object.isFrozen(resolved.normalizationExecution));
    assert.ok(policy.isSupportedNormalizationContract(resolved.normalizationContract));
    assert.ok(policy.isSupportedNormalizationProvenance(resolved.normalizationContract.provenance));
    assert.ok(contracts.isSupportedNormalizationExecution(resolved.normalizationExecution));
    const captured = JSON.parse(JSON.stringify(resolved));
    const reverse = (value) => Array.isArray(value) ? value.map(reverse) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverse(child)])) : value;
    assert.ok(policy.sameNormalizationContract(resolved.normalizationContract, reverse(captured.normalizationContract)));
    assert.ok(contracts.sameNormalizationExecution(resolved.normalizationExecution, reverse(captured.normalizationExecution)));
    assert.deepEqual(contracts.snapshotNormalization(captured), resolved);
    if (choice === "tsc") {
      assert.ok(Object.isFrozen(resolved.normalizationExecution.sourceLimits));
      assert.ok(Object.isFrozen(resolved.normalizationExecution.workspaceLimits));
    }
  });

  test(`${choice}: v2 archive/decision stays readable across branches and storage order without recomputation`, () => {
    const entries = overviewArchive({ normalization: choice });
    const captured = JSON.parse(JSON.stringify(entries)).reverse();
    const result = read(captured);
    assert.equal(result.status, "available", JSON.stringify(result));
    const { archive } = result;
    assert.equal(archive.base.schemaVersion, 2);
    assert.ok(archive.candidates.every((candidate) => candidate.schemaVersion === 1));
    const candidates = completedSelectionInputs(archive);
    const selected = selectFinalPatch(archive.base, candidates, archive.evaluations);
    assert.deepEqual(selected, data(entries, "selection").decision);
    assert.equal(selected.policy.equivalence, contracts.resolveNormalization(choice).normalizationContract.provenance.policy);
    assert.ok(parseFinalSelectionRecord(data(entries, "selection")));
    const before = JSON.stringify(captured);
    const random = Math.random;
    Math.random = () => assert.fail("inspection must not consume randomness");
    try {
      const overview = buildReplayOverview(captured, "root");
      assert.match(overview.headline, /Selected iteration 2.*restored/);
      assert.equal(overview.eligibleCount, 3);
      assert.equal(JSON.stringify(captured), before);
    } finally { Math.random = random; }
  });

  test(`${choice}: missing modern fields, mismatched schema/contract and wrong-run identities are unavailable`, () => {
    const cases = [
      [(entries) => { delete data(entries, "root").normalizationContract; }, "invalid-root-normalization-contract"],
      [(entries) => { delete data(entries, "root").normalizationExecution; }, "invalid-root-normalization-contract"],
      [(entries) => { data(entries, "root").normalizationContract.schemaVersion = 99; }, "invalid-root-normalization-contract"],
      [(entries) => { delete data(entries, "base").normalizationContract; }, "invalid-base"],
      [(entries) => { data(entries, "base").normalizationExecution.timeoutMs--; }, "base-normalization-contract-mismatch"],
      [(entries) => { data(entries, "base").schemaVersion = 1; }, "invalid-base"],
      [(entries) => { data(entries, "identity-1").schemaVersion = 1; }, "invalid-or-unsupported-patch-identity"],
      [(entries) => { data(entries, "candidate-1").schemaVersion = 2; }, "invalid-candidate-association"],
      [(entries) => { data(entries, "evaluation-1").schemaVersion = 2; }, "invalid-evaluation"],
      [(entries) => { data(entries, "identity-1").rootEntryId = "other"; }, "unsupported-or-mismatched-record"],
      [(entries) => { data(entries, "identity-1").normalization.provenance = contracts.resolveNormalization(choice === "tsc" ? "agentless" : "tsc").normalizationContract.provenance;
        if (choice === "agentless") data(entries, "identity-1").normalization.diagnosticsTruncated = 0;
      }, "identity-normalization-contract-mismatch"],
    ];
    for (const [mutate, expected] of cases) {
      const entries = overviewArchive({ normalization: choice });
      mutate(entries);
      code(entries, expected);
    }
  });

  test(`${choice}: selection records require captured v2 contract, exact archive label and supported associations`, () => {
    const mutations = [
      (payload) => { delete payload.normalizationContract; },
      (payload) => { payload.schemaVersion = 1; },
      (payload) => { payload.normalizationContract = contracts.resolveNormalization(choice === "tsc" ? "agentless" : "tsc").normalizationContract; },
      (payload) => { payload.decision.policy.equivalence = "future"; },
      (payload) => { payload.baseEntryId = "missing"; },
      (payload) => { payload.identityEntryIds.pop(); },
      (payload) => { payload.candidateEntryIds.pop(); },
    ];
    for (const mutate of mutations) {
      const entries = overviewArchive({ normalization: choice });
      mutate(data(entries, "selection"));
      assert.match(buildReplayOverview(entries, "root").headline, /Outcome unavailable/);
    }
  });
}

test("unsupported TSC labels and every runtime/grammar pin reject instead of reinterpreting hashes", () => {
  const mutations = [
    ...["policy", "canonicalization", "helpers", "registry", "sourceFallback", "framing"].map((field) => (p) => { p[field] = "future"; }),
    ...["package", "version", "sha256"].map((field) => (p) => { p.runtime[field] = "future"; }),
    ...[0, 1].flatMap((index) => ["language", "package", "version", "sha256"].map((field) => (p) => { p.grammars[index][field] = "future"; })),
    (p) => { p.grammars.reverse(); }, (p) => { p.grammars.pop(); },
  ];
  for (const mutate of mutations) {
    const entries = overviewArchive({ normalization: "tsc" });
    mutate(data(entries, "root").normalizationContract.provenance.tsc);
    code(entries, "invalid-root-normalization-contract");
    const identity = structuredClone(data(entries, "identity-1").normalization);
    mutate(identity.provenance.tsc);
    assert.equal(parsePatchNormalization(identity, 2), undefined);
  }
});

test("execution validators reject mixed, incomplete, relaxed and unsupported profiles before run setup", () => {
  for (const mutate of [
    (r) => { r.normalizationExecution.backend = "agentless"; },
    (r) => { r.normalizationExecution.sourceResourceProfile = "future"; },
    (r) => { r.normalizationExecution.workspaceResourceProfile = "future"; },
    (r) => { r.normalizationExecution.timeoutMs = 0; },
    (r) => { r.normalizationExecution.timeoutMs = 60001; },
    (r) => { delete r.normalizationExecution.sourceLimits.maxSources; },
    (r) => { r.normalizationExecution.sourceLimits.maxSourceBytes++; },
    (r) => { r.normalizationExecution.workspaceLimits.maxCandidates++; },
    (r) => { r.normalizationExecution.workspaceLimits.extra = 1; },
    (r) => { delete r.normalizationContract; },
  ]) {
    const resolved = structuredClone(contracts.resolveNormalization("tsc"));
    mutate(resolved);
    assert.throws(() => contracts.snapshotNormalization(resolved), /Invalid or unsupported/);
  }
  assert.throws(() => contracts.resolveNormalization(undefined), /Unsupported normalization choice/);
  assert.throws(() => contracts.resolveNormalization("agentless", { sourceLimits: { maxSources: 1 } }), /cannot be applied/);
  const mixedProvenance = { ...policy.AGENTLESS_NORMALIZATION_PROVENANCE, tsc: policy.TSC_PATCH_PROVENANCE };
  assert.equal(policy.isSupportedNormalizationProvenance(mixedProvenance), false);
  assert.equal(policy.isSupportedNormalizationProvenance({ ...mixedProvenance, policy: policy.TSC_PATCH_IDENTITY_POLICY }), false);
  assert.throws(() => contracts.resolveNormalization("tsc", { sourceLimits: { maxSources: 513 } }), /Invalid TSC limit/);
  const entries = overviewArchive({ normalization: "tsc" });
  data(entries, "base").normalizationExecution.sourceLimits.maxSources--;
  code(entries, "base-normalization-contract-mismatch");
});

test("backend-specific identity diagnostics validate shapes without changing vote fingerprints", () => {
  for (const choice of ["agentless", "tsc"]) {
    const entries = overviewArchive({ normalization: choice });
    const identity = data(entries, "identity-1").normalization;
    const parsed = parsePatchNormalization(identity, 2);
    assert.ok(parsed);
    assert.deepEqual(capturePatchNormalization(parsed), identity);
    assert.equal(parsePatchNormalization({ ...identity, policy: "shadow" }, 2), undefined);
  }
  const identity = data(overviewArchive({ normalization: "tsc" }), "identity-1").normalization;
  const diagnostic = { kind: "exact-content-fallback", pathBase64: Buffer.from([0xff, 46, 112, 121]).toString("base64"),
    side: "after", reason: "syntax-error", issues: [{ kind: "missing", nodeType: ")", startIndex: 2, endIndex: 2 }] };
  identity.diagnostics = [diagnostic];
  assert.ok(parsePatchNormalization(identity, 2));
  for (const mutate of [
    (n) => { delete n.diagnosticsTruncated; }, (n) => { n.diagnosticsTruncated = -1; },
    (n) => { n.diagnostics = Array.from({ length: 33 }, () => diagnostic); },
    (n) => { n.diagnostics[0].pathBase64 = "not base64!"; },
    (n) => { n.diagnostics[0].side = "other"; }, (n) => { n.diagnostics[0].reason = "future"; },
    (n) => { n.diagnostics[0].issues[0].kind = "future"; },
    (n) => { n.diagnostics[0].issues[0].startIndex = -1; },
    (n) => { n.diagnostics[0].issues[0].endIndex = 1; },
  ]) {
    const malformed = structuredClone(identity);
    mutate(malformed);
    assert.equal(parsePatchNormalization(malformed, 2), undefined);
  }
});

test("pure voter isolates policies, preserves occurrence weighting/ties and never infers TSC for a legacy scope", () => {
  const { archive } = read(overviewArchive({ normalization: "tsc", count: 2 }));
  const candidates = completedSelectionInputs(archive);
  const decision = selectFinalPatch(archive.base, candidates, archive.evaluations);
  assert.equal(decision.eligibleCount, 2);
  assert.equal(decision.tiedGroupKeyHashes.length, 2);
  assert.equal(decision.selectedCandidateEntryId, "candidate-1");
  const alias = { ...structuredClone(candidates[0]), entryId: "alias" };
  alias.normalization.diagnostics = [{ kind: "exact-content-fallback", pathBase64: "YS5weQ==", side: "after", reason: "invalid-utf8", issues: [] }];
  const duplicated = selectFinalPatch(archive.base, [...candidates, alias], archive.evaluations);
  assert.equal(duplicated.eligibleCount, 2, "duplicate aliases and diagnostics add no vote");
  const mixed = structuredClone(candidates);
  const { policy: _policy, tsc: _tsc, ...common } = mixed[0].normalization;
  mixed[0].normalization = { ...common, ...policy.AGENTLESS_NORMALIZATION_PROVENANCE };
  const isolated = selectFinalPatch(archive.base, mixed, archive.evaluations);
  assert.deepEqual(isolated.candidates[0].exclusionReasons, ["unsupported-normalization"]);
  assert.equal(isolated.selectedCandidateEntryId, "candidate-2");
  const { normalizationContract: _contract, ...legacyScope } = archive.base;
  assert.equal(selectFinalPatch(legacyScope, candidates, archive.evaluations).status, "no-valid-candidates");
});

test("ambiguous identities are unavailable; repeated or conflicting evaluations retain occurrence-level handling", () => {
  for (const conflicting of [false, true]) {
    const entries = overviewArchive({ normalization: "tsc", count: 2 });
    const identity = structuredClone(entries.find((entry) => entry.id === "identity-1"));
    identity.id = "another-identity";
    if (conflicting) identity.data.normalization.keyHash = "f".repeat(64);
    entries.push(identity);
    code(entries, "ambiguous-patch-identities");
  }
  for (const conflicting of [false, true]) {
    const entries = overviewArchive({ normalization: "tsc", count: 2 });
    const evidence = structuredClone(entries.find((entry) => entry.id === "evaluation-1"));
    evidence.id = "another-evaluation";
    if (conflicting) Object.assign(evidence.data, { status: "failed", exitCode: 1 });
    entries.push(evidence);
    const { archive } = read(entries);
    const decision = selectFinalPatch(archive.base, completedSelectionInputs(archive), archive.evaluations);
    assert.equal(decision.eligibleCount, conflicting ? 1 : 2);
    assert.ok(decision.diagnostics.some((d) => d.code === (conflicting ? "conflicting-evaluation-records" : "duplicate-evaluation")));
  }
  const legacy = overviewArchive();
  data(legacy, "identity-1").normalization = { ...data(legacy, "identity-1").normalization, ...policy.TSC_NORMALIZATION_PROVENANCE, diagnosticsTruncated: 0 };
  code(legacy, "invalid-or-unsupported-patch-identity");
});

test("supported legacy captured decisions stay readable but cannot be normalized or finalized again", async () => {
  const entries = overviewArchive();
  const { archive } = read(entries);
  assert.equal(archive.base.schemaVersion, 1);
  assert.match(buildReplayOverview(entries, "root").headline, /restored/);
  assert.throws(() => completedSelectionInputs(archive), /Legacy captured.*read-only/);
  const original = JSON.stringify(entries);
  const ctx = { sessionManager: { getEntries: () => entries, getLeafEntry: () => entries.at(-1) }, ui: { notify: () => assert.fail("Legacy runs must not normalize") } };
  const pi = { appendEntry: (customType, payload) => entries.push({ id: "error", parentId: entries.at(-1).id, type: "custom", customType, data: payload }) };
  await assert.rejects(finalizeReplay(pi, ctx, { contentTree: () => assert.fail("Legacy tree read") }, "root"), /Legacy captured.*read-only/);
  assert.equal(JSON.stringify(entries.slice(0, -1)), original);
  assert.equal(entries.at(-1).customType, "swe-replay-finalization-error");
  assert.equal(entries.at(-1).data.phase, "archive");
});
