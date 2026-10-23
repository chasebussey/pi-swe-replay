import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  normalizePythonPatches,
  type PythonNormalizationOptions,
  type PythonNormalizationResult,
  type PythonPatchFile,
} from "./python-normalization";
import { PATCH_IDENTITY_POLICY, type NormalizationProvenance } from "./normalization-policy";
import type { ReplayWorkspace, WorkspaceContentTree, WorkspaceTreeFile } from "./workspace";

export { PATCH_IDENTITY_POLICY } from "./normalization-policy";

export interface PatchNormalizationResult extends NormalizationProvenance {
  patches: {
    baseTreeOid: string;
    candidateTreeOid: string;
    keyHash: string;
    rawEmpty: boolean;
    normalizationEmpty: boolean;
    diagnostics: PythonNormalizationResult["patches"][number]["diagnostics"];
  }[];
}

function utf8(bytes: Buffer): string | undefined {
  try {
    // Preserve BOMs as source characters, and never substitute invalid bytes.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function pythonPath(bytes: Buffer): string | undefined {
  const path = utf8(bytes);
  if (!path?.endsWith(".py") || path.includes("\\") || path.includes("\0") || /^[a-z]:/i.test(path)
    || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    return undefined;
  }
  return path;
}

function source(file: WorkspaceTreeFile | null): string | undefined {
  if (!file) return "";
  if (!["100644", "100755"].includes(file.mode) || !file.content || file.content.includes(0)) return undefined;
  return utf8(file.content);
}

function exact(file: WorkspaceTreeFile | null): unknown {
  if (!file) return null;
  return file.content === null
    ? [file.mode, "object", file.oid]
    : [file.mode, "bytes", file.content.toString("base64")];
}

/**
 * Initial-workspace-relative grouping only: never export these identities as patches.
 * Byte-sorted paths and domain-tagged JSON frame the upstream Python key separately
 * from exact byte/mode/existence components. Diagnostics do not affect identity.
 * A hard failure rejects the whole batch; no partial results are returned.
 */
export async function normalizeWorkspacePatches(
  workspace: ReplayWorkspace,
  base: WorkspaceContentTree,
  candidates: readonly WorkspaceContentTree[],
  options: PythonNormalizationOptions = {},
): Promise<PatchNormalizationResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Normalization timeout must be positive and finite.");
  options.signal?.throwIfAborted();

  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("Patch normalization timed out.")), timeoutMs);
  try {
    // One deadline covers tree/blob reads as well as the Python worker and diffs.
    return await normalizeTrees(workspace, base, candidates, { signal: controller.signal, timeoutMs });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function normalizeTrees(
  workspace: ReplayWorkspace,
  base: WorkspaceContentTree,
  candidates: readonly WorkspaceContentTree[],
  options: PythonNormalizationOptions,
): Promise<PatchNormalizationResult> {
  // Validate the entire batch before starting Git work.
  if (candidates.some((candidate) => candidate.rootEntryId !== base.rootEntryId)) {
    throw new Error("Cannot normalize content trees from different replay runs.");
  }

  const prepared: { files: PythonPatchFile[]; exact: unknown[]; rawEmpty: boolean }[] = [];
  for (const candidate of candidates) {
    const changes = await workspace.treeChanges(base, candidate, options.signal);
    const files: PythonPatchFile[] = [];
    const components: unknown[] = [];
    for (const change of changes) {
      const path = pythonPath(change.path);
      const before = source(change.before);
      const after = source(change.after);
      const pathBytes = change.path.toString("base64");
      if (path !== undefined && before !== undefined && after !== undefined) {
        files.push({ path, before, after });
        const beforeMode = change.before?.mode ?? null;
        const afterMode = change.after?.mode ?? null;
        if (beforeMode !== afterMode) components.push(["metadata", pathBytes, beforeMode, afterMode]);
      } else {
        components.push(["exact", pathBytes, exact(change.before), exact(change.after)]);
      }
    }
    prepared.push({ files, exact: components, rawEmpty: changes.length === 0 });
  }

  // One interpreter worker for all eligible sources, not one per file/candidate.
  const { patches: pythonPatches, ...python } = await normalizePythonPatches(prepared, options);
  const patches = prepared.map((patch, index) => {
    const normalized = pythonPatches[index];
    const normalizationEmpty = normalized.empty && patch.exact.length === 0;
    const key = JSON.stringify([PATCH_IDENTITY_POLICY, normalized.key, patch.exact]);
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    return {
      baseTreeOid: base.treeOid, candidateTreeOid: candidates[index].treeOid,
      keyHash, rawEmpty: patch.rawEmpty, normalizationEmpty, diagnostics: normalized.diagnostics,
    };
  });
  options.signal?.throwIfAborted();
  return { policy: PATCH_IDENTITY_POLICY, python, patches };
}
