/** Shared producer/consumer contract; changing it requires an explicit policy decision. */
export const PATCH_IDENTITY_POLICY = "complete-tree-agentless-mixed-v1";
export const PYTHON_NORMALIZATION_POLICY = "agentless-python-pyodide-v2";
export const AGENTLESS_REVISION = "5ce5888b9f149beaace393957a55ea8ee46c9f71";
export const PYODIDE_VERSION = "314.0.7";
export const BUNDLED_PYTHON_VERSION = "3.14.2";

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
