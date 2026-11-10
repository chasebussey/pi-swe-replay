import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { TSC_PATCH_PROVENANCE, tscPatchProvenanceFrame, type TscPatchProvenance } from "./normalization-policy";
import { normalizeTscSources, type TscNormalizationOptions } from "./tree-sitter-normalization";
import { tscHelperResidual, type CanonicalFileContent } from "./tree-sitter-helpers";
import type { SyntaxIssue } from "./tree-sitter-canonical";
import { tscLanguageForPath, type CanonicalSource, type SourceFallbackReason } from "./tree-sitter-source";
import { tscLimits } from "./tree-sitter-limits";
import { TscNormalizationError } from "./tree-sitter-worker-client";
import type { TscSourceInput, TscNormalizedSource } from "./tree-sitter-protocol";
import { TSC_WORKSPACE_RESOURCE_PROFILE, TscWorkspaceBudget, tscWorkspaceLimits, type TscWorkspaceLimits } from "./tsc-workspace-limits";
import type { ReplayWorkspace, WorkspaceContentTree, WorkspaceTreeChange, WorkspaceTreeFile } from "./workspace";

export interface TscPatchNormalizationOptions extends TscNormalizationOptions {
  workspaceLimits?: Partial<TscWorkspaceLimits>;
}
export interface TscPatchDiagnostic {
  kind: "exact-content-fallback";
  pathBase64: string;
  side: "before" | "after";
  reason: SourceFallbackReason | "unsupported-kind";
  issues: readonly SyntaxIssue[];
}
export interface TscPatchNormalizationResult {
  policy: TscPatchProvenance["policy"];
  tsc: TscPatchProvenance;
  execution: { resourceProfile: typeof TSC_WORKSPACE_RESOURCE_PROFILE; limits: TscWorkspaceLimits };
  patches: {
    baseTreeOid: string;
    candidateTreeOid: string;
    keyHash: string;
    rawEmpty: boolean;
    normalizationEmpty: boolean;
    diagnostics: TscPatchDiagnostic[];
    diagnosticsTruncated: number;
  }[];
}

type ExactFileValue = readonly ["object" | "bytes", string] | null;
type ExactFileContent = readonly ["exact", ExactFileValue, ExactFileValue];
type FileComponent = readonly [string, string | null, string | null, CanonicalFileContent | ExactFileContent | null];

const MAX_DIAGNOSTICS = 32;
const regular = (file: WorkspaceTreeFile | null) => !file || file.mode === "100644" || file.mode === "100755";
function exactValue(file: WorkspaceTreeFile | null): ExactFileValue {
  if (!file) return null;
  if (file.content === null) return ["object", file.oid];
  return ["bytes", file.content.toString("base64")];
}
const sameContent = (a: WorkspaceTreeFile | null, b: WorkspaceTreeFile | null) => {
  if (!a || !b) return a === b;
  if (a.content === null || b.content === null) return a.content === b.content && a.oid === b.oid;
  return a.content.equals(b.content);
};
function exactSize(file: WorkspaceTreeFile | null): number {
  if (!file) return 4;
  if (file.content === null) return file.oid.length + 32;
  return 4 * Math.ceil(file.content.length / 3) + 32;
}

/**
 * Complete-tree TSC producer; policy choice and captured compatibility belong to
 * the contract/archive layers. Reads retained trees, never HEAD/worktree files, and never returns
 * canonical data as source to restore. One deadline and fatal failure domain cover
 * bounded reads, offline source workers, original-tree projection and hashing.
 */
export async function normalizeTscWorkspacePatches(
  workspace: ReplayWorkspace, base: WorkspaceContentTree, candidates: readonly WorkspaceContentTree[],
  options: TscPatchNormalizationOptions = {},
): Promise<TscPatchNormalizationResult> {
  const { signal, timeoutMs = 60_000 } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new TypeError("TSC timeout must be 1..60000ms.");
  const limits = tscWorkspaceLimits(options.workspaceLimits);
  const sourceLimits = tscLimits(options.limits);
  const sourceOptions = { ...options, grammar: { ...options.grammar } };
  signal?.throwIfAborted();
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const expired = () => new TscNormalizationError("timeout", "TSC workspace normalization timed out.");
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(expired()), timeoutMs);
  const assertActive = () => {
    if (signal?.aborted) onAbort();
    if (!controller.signal.aborted && performance.now() >= deadline) controller.abort(expired());
    controller.signal.throwIfAborted();
  };
  const budget = new TscWorkspaceBudget(limits, sourceLimits, assertActive);

  try {
    budget.check("maxCandidates", candidates.length);
    base = { ...base };
    candidates = candidates.map((candidate) => ({ ...candidate }));
    if (candidates.some((candidate) => candidate.rootEntryId !== base.rootEntryId)) {
      throw new Error("Cannot normalize content trees from different replay runs.");
    }
    const prepared: { change: WorkspaceTreeChange; ids?: readonly [string, string] }[][] = [];
    const sources: TscSourceInput[] = [];
    for (const candidate of candidates) {
      assertActive();
      const changes = await workspace.treeChanges(base, candidate, controller.signal, budget);
      const rows: typeof prepared[number] = [];
      for (const change of changes) {
        assertActive();
        const eligible = tscLanguageForPath(change.path) && regular(change.before) && regular(change.after);
        if (!eligible || sameContent(change.before, change.after)) {
          rows.push({ change });
          continue;
        }
        const ids = [`source-${sources.length}`, `source-${sources.length + 1}`] as const;
        sources.push({ id: ids[0], path: change.path, content: change.before?.content ?? Buffer.alloc(0) },
          { id: ids[1], path: change.path, content: change.after?.content ?? Buffer.alloc(0) });
        rows.push({ change, ids });
      }
      prepared.push(rows);
    }

    assertActive();
    const normalized = await normalizeTscSources(sources, {
      ...sourceOptions, limits: sourceLimits, signal: controller.signal,
      timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
    });
    assertActive();
    const byId = new Map(normalized.results.map((result) => [result.id, result]));
    const provenance = TSC_PATCH_PROVENANCE;
    const provenanceFrame = tscPatchProvenanceFrame(provenance);
    const patches: TscPatchNormalizationResult["patches"] = [];
    for (const [index, rows] of prepared.entries()) {
      const components: FileComponent[] = [];
      const diagnostics: TscPatchDiagnostic[] = [];
      let diagnosticsTruncated = 0;
      let identityBound = Buffer.byteLength(JSON.stringify([provenance.policy, provenanceFrame, base.treeOid, []]));
      budget.check("maxIdentityBytes", identityBound);
      const diagnose = (pathBase64: string, side: "before" | "after", reason: TscPatchDiagnostic["reason"], issues: TscPatchDiagnostic["issues"] = []) => {
        if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push({ kind: "exact-content-fallback", pathBase64, side, reason, issues });
        else diagnosticsTruncated++;
      };
      for (const { change, ids } of rows) {
        assertActive();
        const { before, after } = change;
        const pathBase64 = change.path.toString("base64");
        const beforeMode = before?.mode ?? null;
        const afterMode = after?.mode ?? null;
        let content: CanonicalFileContent | ExactFileContent | null = null;
        if (!sameContent(before, after)) {
          const a = ids ? byId.get(ids[0]) : undefined;
          const b = ids ? byId.get(ids[1]) : undefined;
          if (ids && (!a || !b)) throw new Error("Missing TSC normalized source association.");
          if (a?.kind === "canonical" && b?.kind === "canonical") {
            // Upper bound before decoding/projecting/serializing any identity frame:
            // full baseline + candidate + helper names/wrappers and framing slack.
            identityBound += a.metrics.canonicalBytes + 2 * b.metrics.canonicalBytes + 256;
            budget.check("maxIdentityBytes", identityBound);
            if (a.canonical !== b.canonical) {
              const language = tscLanguageForPath(change.path)!;
              content = tscHelperResidual(language, JSON.parse(a.canonical) as CanonicalSource, JSON.parse(b.canonical) as CanonicalSource);
            }
          } else {
            identityBound += exactSize(before) + exactSize(after) + 256;
            budget.check("maxIdentityBytes", identityBound);
            content = ["exact", exactValue(before), exactValue(after)];
            const report = (side: "before" | "after", file: WorkspaceTreeFile | null, result: TscNormalizedSource | undefined) => {
              if (result?.kind === "exact") diagnose(pathBase64, side, result.reason, result.issues);
              else if (!ids && file) {
                if (!regular(file)) diagnose(pathBase64, side, "unsupported-kind");
                else if (!tscLanguageForPath(change.path)) diagnose(pathBase64, side, "unsupported-language");
              }
            };
            report("before", before, a);
            report("after", after, b);
          }
        }
        identityBound += pathBase64.length + 128;
        budget.check("maxIdentityBytes", identityBound);
        if (content !== null || beforeMode !== afterMode) components.push([pathBase64, beforeMode, afterMode, content]);
      }
      assertActive();
      const frame = [provenance.policy, provenanceFrame, base.treeOid, components];
      const keyHash = createHash("sha256").update(JSON.stringify(frame), "utf8").digest("hex");
      assertActive();
      patches.push({ baseTreeOid: base.treeOid, candidateTreeOid: candidates[index].treeOid, keyHash,
        rawEmpty: rows.length === 0, normalizationEmpty: components.length === 0, diagnostics, diagnosticsTruncated });
    }
    assertActive();
    return { policy: provenance.policy, tsc: provenance,
      execution: { resourceProfile: TSC_WORKSPACE_RESOURCE_PROFILE, limits }, patches };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
