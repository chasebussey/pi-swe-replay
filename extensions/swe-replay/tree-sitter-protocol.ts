import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { TSC_LANGUAGES, tscSourceProvenance, type TscSourceProvenance, type TscLanguage } from "./normalization-policy";
import { tscLanguageForPath, type SourceFallbackReason } from "./tree-sitter-source";
import { checkTscLimit, tscLimits, TSC_NORMALIZATION_LIMITS, TSC_RESOURCE_PROFILE, type TscLimits } from "./tree-sitter-limits";
import type { SyntaxIssue } from "./tree-sitter-canonical";

export const TSC_WORKER_PROTOCOL = 1;
const MAX_ASSET_PATH_BYTES = 8192; // Trusted cache locations, separate from source-path caps.
export interface TscSourceInput { readonly id: string; readonly path: Uint8Array; readonly content: Uint8Array }
export interface TscAssetLocation { readonly language: TscLanguage; readonly path: string }
export interface TscWorkerRequest {
  protocolVersion: typeof TSC_WORKER_PROTOCOL;
  resourceProfile: typeof TSC_RESOURCE_PROFILE;
  sources: readonly TscSourceInput[];
  assets: readonly TscAssetLocation[];
  provenance: TscSourceProvenance;
  limits: TscLimits;
}
export interface TscMetrics { readonly nodes: number; readonly depth: number; readonly canonicalBytes: number }
export type TscSourceValue = Readonly<{ metrics: TscMetrics } & (
  | { kind: "canonical"; canonical: string; removedComments: number; removedDocstrings: number }
  | { kind: "exact"; reason: SourceFallbackReason; issues: readonly SyntaxIssue[] }
)>;
export type TscNormalizedSource = TscSourceValue & { readonly id: string };
export interface TscWorkerSuccess {
  protocolVersion: typeof TSC_WORKER_PROTOCOL;
  type: "success";
  provenance: TscSourceProvenance;
  resourceProfile: typeof TSC_RESOURCE_PROFILE;
  sources: TscSourceValue[];
  results: { id: string; sourceIndex: number }[];
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const fail = (): never => { throw new Error("Invalid TSC worker protocol payload."); };

function sameContract(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length
    && expected.every((value, index) => sameContract(actual[index], value));
  if (record(expected)) return record(actual) && keys(actual, Object.keys(expected))
    && Object.keys(expected).every((key) => sameContract(actual[key], expected[key]));
  return actual === expected;
}

export function prepareTscSources(
  input: unknown, limits: TscLimits, copy = true, assertActive: () => void = () => {},
): TscSourceInput[] {
  if (!Array.isArray(input)) throw new TypeError("TSC sources must be an array.");
  checkTscLimit(limits, "maxSources", input.length);
  const ids = new Set<string>();
  const result: TscSourceInput[] = [];
  let total = 0;
  for (const value of input) {
    assertActive();
    if (!record(value) || !keys(value, ["id", "path", "content"]) || typeof value.id !== "string" || !value.id || value.id.length > 128
      || Buffer.byteLength(value.id) > 128 || /[\x00-\x1f\x7f-\x9f]/.test(value.id) || ids.has(value.id)
      || !(value.path instanceof Uint8Array) || !(value.content instanceof Uint8Array)
      || typeof SharedArrayBuffer !== "undefined"
        && (value.path.buffer instanceof SharedArrayBuffer || value.content.buffer instanceof SharedArrayBuffer)) {
      throw new TypeError("Invalid or duplicate TSC source input.");
    }
    checkTscLimit(limits, "maxPathBytes", value.path.byteLength);
    checkTscLimit(limits, "maxSourceBytes", value.content.byteLength);
    total += value.path.byteLength + value.content.byteLength + Buffer.byteLength(value.id);
    checkTscLimit(limits, "maxBatchBytes", total);
    ids.add(value.id);
    result.push({ id: value.id, path: copy ? Uint8Array.from(value.path) : value.path,
      content: copy ? Uint8Array.from(value.content) : value.content });
  }
  planTscSources(result, limits, assertActive);
  return result;
}

/** Deduplicate by language plus raw bytes, not path or a recovered parse. */
export function planTscSources(sources: readonly TscSourceInput[], limits: TscLimits, assertActive: () => void = () => {}) {
  const unique: TscSourceInput[] = [];
  const indexes: number[] = [];
  const byKey = new Map<string, number>();
  let bytes = 0;
  for (const source of sources) {
    assertActive();
    const language = tscLanguageForPath(source.path) ?? "unsupported";
    const hash = createHash("sha256").update(source.content).digest("hex");
    const key = `${language}:${hash}`;
    let index = byKey.get(key);
    if (index === undefined) {
      index = unique.length;
      checkTscLimit(limits, "maxUniqueSources", index + 1);
      bytes += source.content.byteLength;
      checkTscLimit(limits, "maxUniqueBytes", bytes);
      byKey.set(key, index);
      unique.push(source);
    }
    indexes.push(index);
  }
  return { unique, indexes };
}

export function validateTscWorkerRequest(value: unknown): TscWorkerRequest {
  if (!record(value) || !keys(value, ["protocolVersion", "resourceProfile", "sources", "assets", "provenance", "limits"]) || value.protocolVersion !== TSC_WORKER_PROTOCOL
    || value.resourceProfile !== TSC_RESOURCE_PROFILE
    || !record(value.limits) || !keys(value.limits, Object.keys(TSC_NORMALIZATION_LIMITS)) || !Array.isArray(value.assets)) return fail();
  const limits = tscLimits(value.limits);
  const sources = prepareTscSources(value.sources, limits, false);
  const needed = new Set(sources.map((source) => tscLanguageForPath(source.path)).filter((language) => language !== undefined));
  const provenance = tscSourceProvenance([...needed]);
  if (value.assets.length !== needed.size || !sameContract(value.provenance, provenance)) return fail();
  const assets: TscAssetLocation[] = [];
  for (const asset of value.assets) {
    if (!record(asset) || !keys(asset, ["language", "path"]) || !needed.delete(asset.language as TscLanguage)
      || typeof asset.path !== "string" || asset.path.length > MAX_ASSET_PATH_BYTES || !isAbsolute(asset.path) || asset.path.includes("\0")
      || Buffer.byteLength(asset.path) > MAX_ASSET_PATH_BYTES) return fail();
    assets.push({ language: asset.language as TscLanguage, path: asset.path });
  }
  return { protocolVersion: TSC_WORKER_PROTOCOL, resourceProfile: TSC_RESOURCE_PROFILE, sources, assets, provenance, limits };
}

/** Check canonical framing, not semantics; the trusted worker owns parsing. */
function validateCanonical(text: string, input: TscSourceInput, limits: TscLimits): void {
  const language = tscLanguageForPath(input.path);
  const grammar = TSC_LANGUAGES.find((entry) => entry.language === language);
  if (!grammar) return fail();
  checkTscLimit(limits, "maxSourceCanonicalBytes", Buffer.byteLength(text));
  const envelope: unknown = JSON.parse(text);
  if (!Array.isArray(envelope) || envelope.length !== 3 || envelope[0] !== "source"
    || !["utf8", "utf8-bom"].includes(envelope[1]) || !Array.isArray(envelope[2])
    || envelope[2][0] !== "node" || envelope[2][1] !== grammar.rootType) return fail();
  const bom = input.content[0] === 0xef && input.content[1] === 0xbb && input.content[2] === 0xbf;
  if (envelope[1] !== (bom ? "utf8-bom" : "utf8") || JSON.stringify(envelope) !== text) return fail();
  const pending = [{ value: envelope[2], depth: 1 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 2 * limits.maxSourceNodes || depth > limits.maxDepth + 1
      || !Array.isArray(value) || value.length !== 3 || typeof value[1] !== "string" || !value[1] || value[1].length > 128) return fail();
    if (value[0] === "token" || value[0] === "fragment") {
      if (typeof value[2] !== "string") return fail();
    } else if (value[0] === "node" && Array.isArray(value[2])) {
      for (const edge of value[2]) {
        if (!Array.isArray(edge) || edge.length !== 2 || !(edge[0] === null || typeof edge[0] === "string" && edge[0].length <= 128)) return fail();
        pending.push({ value: edge[1], depth: depth + 1 });
      }
    } else return fail();
  }
}

export function decodeTscWorkerSuccess(payload: unknown, request: TscWorkerRequest): readonly TscNormalizedSource[] {
  if (!(payload instanceof Uint8Array)) return fail();
  checkTscLimit(request.limits, "maxResponseBytes", payload.byteLength);
  const value: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(payload));
  if (!record(value) || !keys(value, ["protocolVersion", "type", "provenance", "resourceProfile", "sources", "results"])
    || value.protocolVersion !== TSC_WORKER_PROTOCOL || value.type !== "success" || !sameContract(value.provenance, request.provenance)
    || value.resourceProfile !== TSC_RESOURCE_PROFILE || !Array.isArray(value.sources) || !Array.isArray(value.results)) return fail();
  const plan = planTscSources(request.sources, request.limits);
  if (value.sources.length !== plan.unique.length || value.results.length !== request.sources.length) return fail();
  let nodes = 0;
  let bytes = 0;
  const sources: TscSourceValue[] = [];
  for (const [index, source] of value.sources.entries()) {
    if (!record(source) || !record(source.metrics) || !keys(source.metrics, ["nodes", "depth", "canonicalBytes"])) return fail();
    const m = source.metrics;
    if (!integer(m.nodes) || !integer(m.depth) || !integer(m.canonicalBytes) || (m.nodes === 0) !== (m.depth === 0)) return fail();
    checkTscLimit(request.limits, "maxSourceNodes", m.nodes);
    checkTscLimit(request.limits, "maxDepth", m.depth);
    nodes += m.nodes;
    checkTscLimit(request.limits, "maxBatchNodes", nodes);
    const metrics = Object.freeze({ nodes: m.nodes, depth: m.depth, canonicalBytes: m.canonicalBytes });
    if (source.kind === "canonical") {
      if (!keys(source, ["kind", "canonical", "removedComments", "removedDocstrings", "metrics"])
        || typeof source.canonical !== "string" || !integer(source.removedComments) || !integer(source.removedDocstrings)
        || source.removedComments + source.removedDocstrings > m.nodes || m.nodes < 1 || m.depth < 1
        || Buffer.byteLength(source.canonical) !== m.canonicalBytes) return fail();
      validateCanonical(source.canonical, plan.unique[index], request.limits);
      bytes += m.canonicalBytes;
      checkTscLimit(request.limits, "maxBatchCanonicalBytes", bytes);
      sources.push({ kind: "canonical", canonical: source.canonical, removedComments: source.removedComments,
        removedDocstrings: source.removedDocstrings, metrics });
    } else if (source.kind === "exact") {
      if (!keys(source, ["kind", "reason", "issues", "metrics"]) || m.canonicalBytes !== 0
        || !["unsupported-language", "invalid-utf8", "nul-binary", "syntax-error", "unsupported-trivia"].includes(String(source.reason))
        || !Array.isArray(source.issues) || source.issues.length > 8) return fail();
      const parsed = source.reason === "syntax-error" || source.reason === "unsupported-trivia";
      if (parsed !== (m.nodes > 0) || parsed !== (source.issues.length > 0)
        || (source.reason === "unsupported-language") !== (tscLanguageForPath(plan.unique[index].path) === undefined)) return fail();
      const issues: SyntaxIssue[] = [];
      for (const issue of source.issues) {
        if (!record(issue) || !keys(issue, ["kind", "nodeType", "startIndex", "endIndex"])
          || !["error", "missing", "unsupported-trivia"].includes(String(issue.kind)) || typeof issue.nodeType !== "string"
          || issue.nodeType.length > 128 || !integer(issue.startIndex) || !integer(issue.endIndex)
          || issue.startIndex > issue.endIndex || issue.endIndex > plan.unique[index].content.byteLength) return fail();
        issues.push(Object.freeze(issue) as unknown as SyntaxIssue);
      }
      sources.push({ kind: "exact", reason: source.reason as SourceFallbackReason, issues: Object.freeze(issues), metrics });
    } else return fail();
  }
  return Object.freeze(value.results.map((entry, index) => {
    if (!record(entry) || !keys(entry, ["id", "sourceIndex"]) || entry.id !== request.sources[index].id
      || entry.sourceIndex !== plan.indexes[index]) return fail();
    return Object.freeze({ id: request.sources[index].id, ...sources[plan.indexes[index]] });
  }));
}
