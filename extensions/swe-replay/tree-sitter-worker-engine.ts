import { canonicalizeTscSource, tscLanguageForPath } from "./tree-sitter-source";
import { createOfflineTscParsers } from "./tree-sitter-runtime";
import { checkTscLimit, TSC_RESOURCE_PROFILE, TscTraversalBudget } from "./tree-sitter-limits";
import { TSC_WORKER_PROTOCOL, planTscSources, validateTscWorkerRequest, type TscSourceValue, type TscWorkerSuccess } from "./tree-sitter-protocol";

export interface TscWorkerProgress { type: "progress"; phase: "starting" | "assets-verified" | "canonicalizing"; id?: string }

/** One invocation per disposable worker. Only return data after the entire batch succeeds. */
export async function processTscWorkerRequest(input: unknown, progress: (event: TscWorkerProgress) => void): Promise<Uint8Array> {
  const request = validateTscWorkerRequest(input);
  progress({ type: "progress", phase: "starting" });
  const parsers = await createOfflineTscParsers(request.assets);
  try {
    progress({ type: "progress", phase: "assets-verified" });
    const plan = planTscSources(request.sources, request.limits);
    const usage = { nodes: 0, canonicalBytes: 0 };
    const sources: TscSourceValue[] = [];
    for (const source of plan.unique) {
      progress({ type: "progress", phase: "canonicalizing", id: source.id });
      const budget = new TscTraversalBudget(request.limits, usage);
      const language = tscLanguageForPath(source.path);
      const parser = language ? parsers.get(language) : undefined;
      const result = canonicalizeTscSource(parser, language, source.content, budget);
      const metrics = { nodes: budget.nodes, depth: budget.depth, canonicalBytes: 0 };
      if (result.kind === "canonical") {
        // The core calculates lengths incrementally, before this single serialization.
        const canonical = JSON.stringify(result.source);
        const bytes = Buffer.byteLength(canonical);
        if (bytes !== result.serializedBytes) throw new Error("Canonical byte accounting mismatch.");
        usage.canonicalBytes += bytes;
        checkTscLimit(request.limits, "maxBatchCanonicalBytes", usage.canonicalBytes);
        sources.push({ kind: "canonical", canonical, removedComments: result.removedComments,
          removedDocstrings: result.removedDocstrings, metrics: { ...metrics, canonicalBytes: bytes } });
      } else {
        sources.push({ kind: "exact", reason: result.reason, issues: result.issues, metrics });
      }
    }
    const response: TscWorkerSuccess = {
      protocolVersion: TSC_WORKER_PROTOCOL, type: "success", provenance: request.provenance,
      resourceProfile: TSC_RESOURCE_PROFILE, sources,
      results: request.sources.map((source, index) => ({ id: source.id, sourceIndex: plan.indexes[index] })),
    };
    const json = JSON.stringify(response);
    checkTscLimit(request.limits, "maxResponseBytes", json.length);
    const encoded = new TextEncoder().encode(json);
    checkTscLimit(request.limits, "maxResponseBytes", encoded.byteLength);
    return encoded;
  } finally {
    for (const parser of parsers.values()) parser.delete();
  }
}
