import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ReplayWorkspace, WorkspaceSnapshot } from "./workspace";

export const EVALUATION_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 16_000;

export interface RegressionEvaluation {
  rootEntryId: string;
  iteration: number;
  terminalEntryId: string;
  snapshotOid: string;
  status: "passed" | "failed" | "inconclusive";
  exitCode?: number;
  killed?: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
}

/** Check captured status against execution evidence, without executing anything. */
export function isConsistentRegressionOutcome(
  evaluation: Pick<RegressionEvaluation, "status" | "exitCode" | "killed" | "error">,
): boolean {
  if (evaluation.status === "passed") return evaluation.exitCode === 0 && !evaluation.killed && evaluation.error === undefined;
  if (evaluation.status === "failed") return Number.isInteger(evaluation.exitCode) && evaluation.exitCode !== 0
    && !evaluation.killed && evaluation.error === undefined;
  return evaluation.status === "inconclusive";
}

/** Direct extension execution: no model tool calls or exploration tracking. */
export async function evaluateSnapshot(
  pi: Pick<ExtensionAPI, "exec">,
  workspace: ReplayWorkspace,
  snapshot: WorkspaceSnapshot,
  cwd: string,
  command: string,
  iteration: number,
  terminalEntryId: string,
): Promise<RegressionEvaluation> {
  const started = Date.now();
  const evaluation: RegressionEvaluation = {
    rootEntryId: snapshot.rootEntryId, iteration, terminalEntryId,
    snapshotOid: snapshot.oid, status: "inconclusive", stdout: "", stderr: "", durationMs: 0,
  };
  try {
    await workspace.withEvaluationWorkspace(snapshot, cwd, async (directory) => {
      const result = await pi.exec("bash", ["-lc", command], {
        cwd: directory, timeout: EVALUATION_TIMEOUT_MS,
      });
      evaluation.exitCode = result.code;
      evaluation.killed = result.killed;
      evaluation.stdout = result.stdout.slice(-OUTPUT_LIMIT);
      evaluation.stderr = result.stderr.slice(-OUTPUT_LIMIT);
      evaluation.status = result.killed ? "inconclusive" : result.code === 0 ? "passed" : "failed";
    });
  } catch (error) {
    evaluation.status = "inconclusive";
    evaluation.error = String(error).slice(-OUTPUT_LIMIT);
  }
  evaluation.durationMs = Date.now() - started;
  return evaluation;
}

/** Passing descendant trajectories keep shared prefix steps eligible. */
export function eligibleStepIds(
  entries: readonly SessionEntry[], rootEntryId: string, terminalEntryIds: readonly string[],
): Map<string, number> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const eligible = new Map<string, number>();

  for (const terminal of terminalEntryIds) {
    const path = new Set<string>();
    let id: string | null = terminal;

    while (id && id !== rootEntryId && !path.has(id)) {
      path.add(id);
      const entry = byId.get(id);
      if (!entry || (entry.type === "custom" && entry.customType === "swe-replay-root")) break;
      id = entry.parentId;
    }

    if (id === rootEntryId) {
      for (const stepId of path) {
        eligible.set(stepId, (eligible.get(stepId) ?? 0) + 1);
      }
    }
  }
  return eligible;
}
