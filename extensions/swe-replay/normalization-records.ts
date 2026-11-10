import { isSupportedNormalizationProvenance, PATCH_IDENTITY_POLICY } from "./normalization-policy";
import type { NormalizedPatchIdentity } from "./patch-normalization";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const oid = (value: unknown): value is string => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** New durable identities nest provenance; legacy Agentless payloads stay unchanged. */
export function capturePatchNormalization(identity: NormalizedPatchIdentity) {
  if (identity.policy === PATCH_IDENTITY_POLICY) {
    const { policy, python, ...patch } = identity;
    return { ...patch, provenance: { policy, python } };
  }
  const { policy, tsc, ...patch } = identity;
  return { ...patch, provenance: { policy, tsc } };
}
export type CapturedPatchNormalization = ReturnType<typeof capturePatchNormalization>;

function pythonDiagnostic(value: unknown): boolean {
  return object(value) && value.kind === "exact-content-fallback" && text(value.path) && typeof value.message === "string"
    && ["SyntaxError", "IndentationError", "TabError"].includes(String(value.pythonType));
}

function tscDiagnostic(value: unknown): boolean {
  if (!object(value) || value.kind !== "exact-content-fallback" || !text(value.pathBase64) || value.pathBase64.length > 5464
    || Buffer.from(value.pathBase64, "base64").toString("base64") !== value.pathBase64
    || Buffer.from(value.pathBase64, "base64").byteLength > 4096
    || !["before", "after"].includes(String(value.side))
    || !["unsupported-language", "invalid-utf8", "nul-binary", "syntax-error", "unsupported-trivia", "unsupported-kind"].includes(String(value.reason))
    || !Array.isArray(value.issues) || value.issues.length > 8) return false;

  return value.issues.every((issue) => object(issue) && ["error", "missing", "unsupported-trivia"].includes(String(issue.kind))
    && text(issue.nodeType) && issue.nodeType.length <= 128 && nonnegative(issue.startIndex)
    && nonnegative(issue.endIndex) && issue.endIndex >= issue.startIndex);
}

/** Shape only; run ownership and contract/tree associations are archive concerns. */
export function parsePatchNormalization(value: unknown, schemaVersion: 1 | 2): NormalizedPatchIdentity | undefined {
  if (!object(value) || !oid(value.baseTreeOid) || !oid(value.candidateTreeOid)
    || typeof value.keyHash !== "string" || !/^[0-9a-f]{64}$/.test(value.keyHash)
    || typeof value.rawEmpty !== "boolean" || typeof value.normalizationEmpty !== "boolean" || !Array.isArray(value.diagnostics)) return;
  if (schemaVersion === 1 && Object.hasOwn(value, "provenance")) return;
  if (schemaVersion === 2 && ["policy", "python", "tsc"].some((field) => Object.hasOwn(value, field))) return;
  const provenance = schemaVersion === 1 ? value : value.provenance;
  if (!isSupportedNormalizationProvenance(provenance) || (schemaVersion === 1 && provenance.policy !== PATCH_IDENTITY_POLICY)) return;
  if (provenance.policy === PATCH_IDENTITY_POLICY) {
    if (!value.diagnostics.every(pythonDiagnostic)) return;
  } else if (!nonnegative(value.diagnosticsTruncated) || value.diagnostics.length > 32 || !value.diagnostics.every(tscDiagnostic)) return;

  // Explicit captured provenance is projected for the backend-neutral voter.
  // This never supplies a missing modern contract or infers a legacy TSC policy.
  return { ...value, ...provenance } as unknown as NormalizedPatchIdentity;
}
