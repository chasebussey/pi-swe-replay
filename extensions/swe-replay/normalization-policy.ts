/** Shared producer/consumer contract; changing it requires an explicit policy decision. */
export const PATCH_IDENTITY_POLICY = "complete-tree-agentless-mixed-v1";
export const PYTHON_NORMALIZATION_POLICY = "agentless-python-pyodide-v2";
export const AGENTLESS_REVISION = "5ce5888b9f149beaace393957a55ea8ee46c9f71";
export const PYODIDE_VERSION = "314.0.7";
export const BUNDLED_PYTHON_VERSION = "3.14.2";

// TSC producer and captured provenance contracts. Never reinterpret unsupported pins.
export const TSC_PATCH_IDENTITY_POLICY = "complete-tree-tsc-mixed-v1";
export const TSC_HELPER_POLICY = "added-helper-residual-v1";
export const TSC_SOURCE_FALLBACK_POLICY = "lossless-paired-source-v1";
export const TSC_FRAMING_POLICY = "tagged-json-arrays-utf8-sha256-v1";
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

/** Complete-tree producer and captured provenance contract. */
export const TSC_PATCH_PROVENANCE = Object.freeze({
  policy: TSC_PATCH_IDENTITY_POLICY,
  canonicalization: TSC_CANONICALIZATION_POLICY,
  helpers: TSC_HELPER_POLICY,
  registry: TSC_REGISTRY_POLICY,
  sourceFallback: TSC_SOURCE_FALLBACK_POLICY,
  framing: TSC_FRAMING_POLICY,
  runtime: TSC_RUNTIME_ASSET,
  grammars: TSC_LANGUAGES,
});
export type TscPatchProvenance = Pick<typeof TSC_PATCH_PROVENANCE,
  "policy" | "canonicalization" | "helpers" | "registry" | "sourceFallback" | "framing"> & {
  readonly runtime: Pick<typeof TSC_RUNTIME_ASSET, "package" | "version" | "sha256">;
  readonly grammars: readonly Pick<typeof TSC_LANGUAGES[number], "language" | "package" | "version" | "sha256">[];
};

export function tscPatchProvenanceFrame(provenance: TscPatchProvenance) {
  return [provenance.policy, provenance.canonicalization, provenance.helpers, provenance.registry,
    provenance.sourceFallback, provenance.framing,
    provenance.runtime.package, provenance.runtime.version, provenance.runtime.sha256,
    provenance.grammars.map((grammar) => [grammar.language, grammar.package, grammar.version, grammar.sha256] as const)] as const;
}

export const PYTHON_NORMALIZATION_PROVENANCE = Object.freeze({
  policy: PYTHON_NORMALIZATION_POLICY,
  upstreamRevision: AGENTLESS_REVISION,
  pyodideVersion: PYODIDE_VERSION,
  pythonVersion: BUNDLED_PYTHON_VERSION,
  gitDiffPolicy: "fixed-myers-three-context-v1",
} as const);

export type PythonNormalizationProvenance = typeof PYTHON_NORMALIZATION_PROVENANCE;

export interface AgentlessNormalizationProvenance {
  policy: typeof PATCH_IDENTITY_POLICY;
  python: PythonNormalizationProvenance;
}
export interface TscNormalizationProvenance {
  policy: typeof TSC_PATCH_IDENTITY_POLICY;
  tsc: TscPatchProvenance;
}
export type NormalizationProvenance = AgentlessNormalizationProvenance | TscNormalizationProvenance;
export type NormalizationChoice = "agentless" | "tsc";
export type FrozenNormalizationContract =
  | { readonly schemaVersion: 1; readonly backend: "agentless"; readonly provenance: AgentlessNormalizationProvenance }
  | { readonly schemaVersion: 1; readonly backend: "tsc"; readonly provenance: TscNormalizationProvenance };

export const AGENTLESS_NORMALIZATION_PROVENANCE: AgentlessNormalizationProvenance = Object.freeze({
  policy: PATCH_IDENTITY_POLICY, python: PYTHON_NORMALIZATION_PROVENANCE,
});
export const TSC_NORMALIZATION_PROVENANCE: TscNormalizationProvenance = Object.freeze({
  policy: TSC_PATCH_IDENTITY_POLICY, tsc: TSC_PATCH_PROVENANCE,
});

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function supportedTsc(value: unknown): value is TscPatchProvenance {
  if (!object(value) || !object(value.runtime) || !Array.isArray(value.grammars)) return false;
  const expected = TSC_PATCH_PROVENANCE;
  for (const key of ["policy", "canonicalization", "helpers", "registry", "sourceFallback", "framing"] as const) {
    if (value[key] !== expected[key]) return false;
  }
  const asset = (actual: unknown, pin: typeof TSC_RUNTIME_ASSET | typeof TSC_LANGUAGES[number]) => object(actual)
    && actual.package === pin.package && actual.version === pin.version && actual.sha256 === pin.sha256;
  const grammars = value.grammars;
  return asset(value.runtime, expected.runtime) && grammars.length === expected.grammars.length
    && expected.grammars.every((pin, index) => object(grammars[index])
      && grammars[index].language === pin.language && asset(grammars[index], pin));
}

/** Fixed-position fingerprint, independent of object field order or diagnostics. */
export function normalizationProvenanceFrame(value: NormalizationProvenance): readonly unknown[] {
  if (value.policy === TSC_PATCH_IDENTITY_POLICY) return tscPatchProvenanceFrame(value.tsc);
  const p = value.python;
  return [value.policy, p.policy, p.upstreamRevision, p.pyodideVersion, p.pythonVersion, p.gitDiffPolicy];
}

export function isSupportedNormalizationContract(value: unknown): value is FrozenNormalizationContract {
  if (!object(value) || value.schemaVersion !== 1 || !isSupportedNormalizationProvenance(value.provenance)) return false;
  return value.backend === "agentless" && value.provenance.policy === PATCH_IDENTITY_POLICY
    || value.backend === "tsc" && value.provenance.policy === TSC_PATCH_IDENTITY_POLICY;
}

export function sameNormalizationContract(a: FrozenNormalizationContract, b: FrozenNormalizationContract): boolean {
  return a.backend === b.backend && JSON.stringify(normalizationProvenanceFrame(a.provenance)) === JSON.stringify(normalizationProvenanceFrame(b.provenance));
}

/** Check compatibility only, not the surrounding patch shape or its associations. */
export function isSupportedNormalizationProvenance(value: unknown): value is NormalizationProvenance {
  if (!object(value)) return false;
  if (value.policy === TSC_PATCH_IDENTITY_POLICY) return !Object.hasOwn(value, "python") && supportedTsc(value.tsc);
  if (Object.hasOwn(value, "tsc")) return false;

  const normalization = value;
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
