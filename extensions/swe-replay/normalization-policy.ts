/** Shared producer/consumer contract; changing it requires an explicit policy decision. */
export const PATCH_IDENTITY_POLICY = "complete-tree-agentless-mixed-v1";
export const PYTHON_NORMALIZATION_POLICY = "agentless-python-pyodide-v2";
export const AGENTLESS_REVISION = "5ce5888b9f149beaace393957a55ea8ee46c9f71";
export const PYODIDE_VERSION = "314.0.7";
export const BUNDLED_PYTHON_VERSION = "3.14.2";

// Core/acquisition TSC contracts. Persisted TSC provenance is not supported until P5.
export const TSC_CANONICALIZATION_POLICY = "tsc-canonical-tree-v1";
export const TSC_REGISTRY_POLICY = "python-typescript-files-v1";
export const TSC_GRAMMAR_SOURCE_POLICY = "tree-sitter-github-releases-v1";
export const TSC_RUNTIME_ASSET = Object.freeze({
  package: "web-tree-sitter", version: "0.27.1", asset: "web-tree-sitter.wasm", bytes: 210415,
  sha256: "beca80e44cccbf2299ed4d1e3fa6462a9a6fe818aeebf847547a392227ce4acc",
});
export const TSC_LANGUAGES = Object.freeze([
  Object.freeze({
    language: "python", extension: ".py", rootType: "module", package: "tree-sitter-python", version: "0.25.0",
    asset: "tree-sitter-python.wasm", repository: "tree-sitter/tree-sitter-python",
    releaseTag: "v0.25.0", bytes: 457883,
    sha256: "16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47",
  } as const),
  Object.freeze({
    language: "typescript", extension: ".ts", rootType: "program", package: "tree-sitter-typescript", version: "0.23.2",
    asset: "tree-sitter-typescript.wasm", repository: "tree-sitter/tree-sitter-typescript",
    releaseTag: "v0.23.2", bytes: 1413849,
    sha256: "778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d",
  } as const),
]);
export type TscLanguage = typeof TSC_LANGUAGES[number]["language"];

/** Declared source-normalization contract, independent of cache paths and limits. */
export function tscSourceProvenance(languages: readonly TscLanguage[]) {
  const needed = new Set(languages);
  return Object.freeze({
    canonicalization: TSC_CANONICALIZATION_POLICY, registry: TSC_REGISTRY_POLICY,
    sourcePolicy: TSC_GRAMMAR_SOURCE_POLICY, runtime: TSC_RUNTIME_ASSET,
    grammars: Object.freeze(TSC_LANGUAGES.filter((entry) => needed.has(entry.language))),
  });
}
export type TscSourceProvenance = ReturnType<typeof tscSourceProvenance>;

export const PYTHON_NORMALIZATION_PROVENANCE = Object.freeze({
  policy: PYTHON_NORMALIZATION_POLICY,
  upstreamRevision: AGENTLESS_REVISION,
  pyodideVersion: PYODIDE_VERSION,
  pythonVersion: BUNDLED_PYTHON_VERSION,
  gitDiffPolicy: "fixed-myers-three-context-v1",
} as const);

export type PythonNormalizationProvenance = typeof PYTHON_NORMALIZATION_PROVENANCE;

export interface NormalizationProvenance {
  policy: typeof PATCH_IDENTITY_POLICY;
  python: PythonNormalizationProvenance;
}

/** Check compatibility only, not the surrounding patch shape or its associations. */
export function isSupportedNormalizationProvenance(value: unknown): value is NormalizationProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const normalization = value as Record<string, unknown>;
  const python = normalization.python;
  if (normalization.policy !== PATCH_IDENTITY_POLICY
    || !python || typeof python !== "object" || Array.isArray(python)) {
    return false;
  }

  const provenance = python as Record<string, unknown>;
  return provenance.policy === PYTHON_NORMALIZATION_PROVENANCE.policy
    && provenance.upstreamRevision === PYTHON_NORMALIZATION_PROVENANCE.upstreamRevision
    && provenance.pyodideVersion === PYTHON_NORMALIZATION_PROVENANCE.pyodideVersion
    && provenance.pythonVersion === PYTHON_NORMALIZATION_PROVENANCE.pythonVersion
    && provenance.gitDiffPolicy === PYTHON_NORMALIZATION_PROVENANCE.gitDiffPolicy;
}
