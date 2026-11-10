import type { Worker } from "node:worker_threads";
import { TscResourceError, type TscLimitName } from "./tree-sitter-limits";
import { decodeTscWorkerSuccess, planTscSources, type TscNormalizedSource, type TscWorkerRequest } from "./tree-sitter-protocol";
import type { TscWorkerProgress } from "./tree-sitter-worker-engine";

export class TscNormalizationError extends Error {
  constructor(readonly code: "protocol" | "infrastructure" | "timeout" | "worker-oom", message: string) {
    super(message);
    this.name = "TscNormalizationError";
  }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));

/** Owns a caller-created worker for its whole lifetime, including all failure paths. */
export async function executeTscWorker(
  worker: Worker, request: TscWorkerRequest, signal: AbortSignal,
  onProgress?: (event: TscWorkerProgress) => void,
): Promise<readonly TscNormalizedSource[]> {
  let onAbort = () => {};
  // Early validation/pre-abort can enter termination before the promise listeners
  // exist. Keep an error listener installed throughout ownership, including that gap.
  worker.on("error", () => {});
  try {
    signal.throwIfAborted();
    const unique = planTscSources(request.sources, request.limits).unique;
    return await new Promise<readonly TscNormalizedSource[]>((resolve, reject) => {
      let finished = false;
      let phase = 0;
      let sourceIndex = 0;
      const fail = (error: unknown) => { if (!finished) { finished = true; reject(error); } };
      onAbort = () => fail(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      worker.once("error", (error) => {
        const oom = error instanceof Error && "code" in error && error.code === "ERR_WORKER_OUT_OF_MEMORY";
        const detail = error instanceof Error ? error.message.slice(0, 1024) : "unknown failure";
        fail(new TscNormalizationError(oom ? "worker-oom" : "infrastructure",
          oom ? "TSC worker exceeded its JavaScript heap guard." : `TSC worker failed: ${detail}`));
      });
      worker.once("exit", (code) => fail(new TscNormalizationError("infrastructure", `TSC worker exited before a result (code ${code}).`)));
      worker.on("message", (message: unknown) => {
        if (finished) return;
        let progress: TscWorkerProgress | undefined;
        try {
          if (record(message) && message.type === "progress") {
            if (message.phase === "starting" && phase === 0 && keys(message, ["type", "phase"])) phase = 1;
            else if (message.phase === "assets-verified" && phase === 1 && keys(message, ["type", "phase"])) phase = 2;
            else if (message.phase === "canonicalizing" && phase === 2 && keys(message, ["type", "phase", "id"])
              && sourceIndex < unique.length && message.id === unique[sourceIndex].id) sourceIndex++;
            else throw new Error("Invalid worker progress.");
            progress = message as unknown as TscWorkerProgress;
          } else if (record(message) && message.type === "failure") {
            if (typeof message.message !== "string" || message.message.length > 2048) throw new Error("Invalid worker error.");
            if (message.code === "resource-limit" && keys(message, ["type", "code", "message", "limit", "actual", "maximum"])
              && typeof message.limit === "string" && Object.hasOwn(request.limits, message.limit)
              && typeof message.actual === "number" && Number.isSafeInteger(message.actual)
              && message.maximum === request.limits[message.limit as TscLimitName] && message.actual > Number(message.maximum)) {
              fail(new TscResourceError(message.limit as TscLimitName, message.actual, Number(message.maximum)));
            } else if (message.code === "infrastructure" && keys(message, ["type", "code", "message"])) {
              fail(new TscNormalizationError("infrastructure", message.message));
            } else throw new Error("Invalid worker failure.");
          } else {
            if (phase !== 2 || sourceIndex !== unique.length) throw new Error("Unexpected worker result order.");
            const results = decodeTscWorkerSuccess(message, request);
            finished = true;
            resolve(results);
          }
        } catch (error) {
          fail(error instanceof TscResourceError ? error : new TscNormalizationError("protocol", "Invalid TSC worker response."));
        }
        if (progress && !finished) {
          try { onProgress?.(progress); } catch (error) { fail(error); }
        }
      });

      if (signal.aborted) onAbort();
      else if (worker.threadId === -1) fail(new TscNormalizationError("infrastructure", "TSC worker is already terminated."));
      else {
        try { worker.postMessage(request); } catch {
          fail(new TscNormalizationError("protocol", "Could not send the TSC worker request."));
        }
      }
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
    await worker.terminate();
    worker.removeAllListeners();
  }
}
