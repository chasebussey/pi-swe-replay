import {
  AGENTLESS_NORMALIZATION_PROVENANCE, TSC_NORMALIZATION_PROVENANCE,
  isSupportedNormalizationContract, type FrozenNormalizationContract, type NormalizationChoice,
} from "./normalization-policy";
import { tscLimits, TSC_RESOURCE_PROFILE, type TscLimits } from "./tree-sitter-limits";
import { tscWorkspaceLimits, TSC_WORKSPACE_RESOURCE_PROFILE, type TscWorkspaceLimits } from "./tsc-workspace-limits";

export type NormalizationExecution =
  | { readonly schemaVersion: 1; readonly backend: "agentless"; readonly timeoutMs: number }
  | { readonly schemaVersion: 1; readonly backend: "tsc"; readonly timeoutMs: number;
      readonly sourceResourceProfile: typeof TSC_RESOURCE_PROFILE; readonly sourceLimits: TscLimits;
      readonly workspaceResourceProfile: typeof TSC_WORKSPACE_RESOURCE_PROFILE; readonly workspaceLimits: TscWorkspaceLimits };

export interface ResolvedNormalization {
  readonly normalizationContract: FrozenNormalizationContract;
  readonly normalizationExecution: NormalizationExecution;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const timeout = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 60_000;

/** Execution shape/caps only; record ownership and root/base association are separate. */
export function isSupportedNormalizationExecution(value: unknown): value is NormalizationExecution {
  if (!object(value) || value.schemaVersion !== 1 || !timeout(value.timeoutMs)) return false;
  if (value.backend === "agentless") return Object.keys(value).length === 3;
  if (value.backend !== "tsc" || value.sourceResourceProfile !== TSC_RESOURCE_PROFILE
    || value.workspaceResourceProfile !== TSC_WORKSPACE_RESOURCE_PROFILE
    || !object(value.sourceLimits) || !object(value.workspaceLimits)
    || Object.keys(value).length !== 7) return false;

  try {
    const sources = tscLimits(value.sourceLimits);
    const workspace = tscWorkspaceLimits(value.workspaceLimits);
    return Object.keys(value.sourceLimits).length === Object.keys(sources).length
      && Object.keys(value.workspaceLimits).length === Object.keys(workspace).length;
  } catch {
    return false;
  }
}

/** One owner for the within-record policy/execution pairing invariant. */
export function isSupportedResolvedNormalization(value: unknown): value is ResolvedNormalization {
  return object(value) && isSupportedNormalizationContract(value.normalizationContract)
    && isSupportedNormalizationExecution(value.normalizationExecution)
    && value.normalizationContract.backend === value.normalizationExecution.backend;
}

export function sameNormalizationExecution(a: NormalizationExecution, b: NormalizationExecution): boolean {
  if (a.backend !== b.backend || a.timeoutMs !== b.timeoutMs) return false;
  if (a.backend === "agentless" || b.backend === "agentless") return true;
  return Object.keys(a.sourceLimits).every((name) => a.sourceLimits[name as keyof TscLimits] === b.sourceLimits[name as keyof TscLimits])
    && Object.keys(a.workspaceLimits).every((name) => a.workspaceLimits[name as keyof TscWorkspaceLimits] === b.workspaceLimits[name as keyof TscWorkspaceLimits]);
}

/** Explicit choice required: the command layer alone supplies the user-facing default. */
export function resolveNormalization(
  choice: NormalizationChoice,
  execution: { timeoutMs?: number; sourceLimits?: Partial<TscLimits>; workspaceLimits?: Partial<TscWorkspaceLimits> } = {},
): ResolvedNormalization {
  const timeoutMs = execution.timeoutMs ?? 60_000;
  if (!timeout(timeoutMs)) throw new TypeError("Normalization timeout must be 1..60000ms.");
  if (choice !== "agentless" && choice !== "tsc") throw new TypeError("Unsupported normalization choice.");
  if (choice === "agentless" && (execution.sourceLimits !== undefined || execution.workspaceLimits !== undefined)) {
    throw new TypeError("TSC resource limits cannot be applied to the Agentless backend.");
  }
  const normalizationContract: FrozenNormalizationContract = choice === "agentless"
    ? Object.freeze({ schemaVersion: 1, backend: "agentless", provenance: AGENTLESS_NORMALIZATION_PROVENANCE })
    : Object.freeze({ schemaVersion: 1, backend: "tsc", provenance: TSC_NORMALIZATION_PROVENANCE });
  const normalizationExecution: NormalizationExecution = choice === "agentless"
    ? Object.freeze({ schemaVersion: 1, backend: "agentless", timeoutMs })
    : Object.freeze({ schemaVersion: 1, backend: "tsc", timeoutMs, sourceResourceProfile: TSC_RESOURCE_PROFILE,
        sourceLimits: tscLimits(execution.sourceLimits), workspaceResourceProfile: TSC_WORKSPACE_RESOURCE_PROFILE,
        workspaceLimits: tscWorkspaceLimits(execution.workspaceLimits) });
  return Object.freeze({ normalizationContract, normalizationExecution });
}

/** Validate and take an immutable snapshot before creating entries or touching Git. */
export function snapshotNormalization(value: ResolvedNormalization): ResolvedNormalization {
  if (!isSupportedResolvedNormalization(value)) {
    throw new TypeError("Invalid or unsupported normalization contract/execution.");
  }
  const execution = value.normalizationExecution;
  return resolveNormalization(value.normalizationContract.backend, execution.backend === "tsc"
    ? { timeoutMs: execution.timeoutMs, sourceLimits: execution.sourceLimits, workspaceLimits: execution.workspaceLimits }
    : { timeoutMs: execution.timeoutMs });
}
