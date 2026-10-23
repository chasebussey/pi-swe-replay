import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const policy = await jiti.import("../extensions/swe-replay/normalization-policy.ts");
const python = await jiti.import("../extensions/swe-replay/python-normalization.ts");
const mixed = await jiti.import("../extensions/swe-replay/patch-normalization.ts");
const { isSupportedNormalizationProvenance, PYTHON_NORMALIZATION_PROVENANCE, PATCH_IDENTITY_POLICY } = policy;

const supported = () => ({ policy: PATCH_IDENTITY_POLICY, python: { ...PYTHON_NORMALIZATION_PROVENANCE } });

test("normalization producers and existing exports retain the pinned provenance contract", async () => {
  const expected = {
    policy: "agentless-python-pyodide-v2",
    upstreamRevision: "5ce5888b9f149beaace393957a55ea8ee46c9f71",
    pyodideVersion: "314.0.7",
    pythonVersion: "3.14.2",
    gitDiffPolicy: "fixed-myers-three-context-v1",
  };
  assert.deepEqual(PYTHON_NORMALIZATION_PROVENANCE, expected);
  assert.ok(Object.isFrozen(PYTHON_NORMALIZATION_PROVENANCE));
  assert.deepEqual(await python.normalizePythonPatches([]), { ...expected, patches: [] });

  for (const name of ["AGENTLESS_REVISION", "BUNDLED_PYTHON_VERSION", "PYODIDE_VERSION", "PYTHON_NORMALIZATION_POLICY"]) {
    assert.equal(python[name], policy[name], name);
  }
  assert.equal(mixed.PATCH_IDENTITY_POLICY, "complete-tree-agentless-mixed-v1");
  assert.equal(mixed.PATCH_IDENTITY_POLICY, PATCH_IDENTITY_POLICY);
});

test("compatibility rejects every unsupported or missing policy/provenance field", () => {
  assert.equal(isSupportedNormalizationProvenance(supported()), true);

  for (const field of Object.keys(PYTHON_NORMALIZATION_PROVENANCE)) {
    const unsupported = supported();
    unsupported.python[field] = "unsupported";
    assert.equal(isSupportedNormalizationProvenance(unsupported), false, field);

    const missing = supported();
    delete missing.python[field];
    assert.equal(isSupportedNormalizationProvenance(missing), false, `missing ${field}`);
  }

  for (const value of [null, undefined, [], "policy", {}, { python: supported().python },
    { ...supported(), policy: "unsupported" }, { ...supported(), python: null },
    { ...supported(), python: [] }, { ...supported(), python: "unsupported" }]) {
    assert.equal(isSupportedNormalizationProvenance(value), false);
  }
});

test("compatibility does not validate patch shape, associations, or unrelated metadata", () => {
  const value = { ...supported(), baseTreeOid: "invalid", diagnostics: "invalid", extraMetadata: true };
  value.python.extraMetadata = "retained";
  const before = structuredClone(value);

  assert.equal(isSupportedNormalizationProvenance(value), true);
  assert.deepEqual(value, before);
});
