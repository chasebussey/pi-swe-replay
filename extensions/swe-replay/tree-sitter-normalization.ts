import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { TSC_LANGUAGES, tscSourceProvenance, type TscSourceProvenance, type TscLanguage } from "./normalization-policy";
import { ensureTscGrammar, type GrammarAcquisitionOptions } from "./tree-sitter-grammars";
import { tscLanguageForPath } from "./tree-sitter-source";
import { tscLimits, TSC_RESOURCE_PROFILE, type TscLimits } from "./tree-sitter-limits";
import { TSC_WORKER_PROTOCOL, prepareTscSources, type TscSourceInput, type TscNormalizedSource, type TscWorkerRequest } from "./tree-sitter-protocol";
import { executeTscWorker, TscNormalizationError } from "./tree-sitter-worker-client";
import type { TscWorkerProgress } from "./tree-sitter-worker-engine";

export type TscNormalizationProgress = TscWorkerProgress | { type: "progress"; phase: "provisioning"; language: TscLanguage };
export interface TscNormalizationOptions {
  signal?: AbortSignal;
  /** End-to-end, including host grammar acquisition. May only tighten the 60s default. */
  timeoutMs?: number;
  limits?: Partial<TscLimits>;
  grammar?: Omit<GrammarAcquisitionOptions, "signal">;
  onProgress?: (event: TscNormalizationProgress) => void;
}
export interface TscNormalizationBatch {
  readonly provenance: TscSourceProvenance;
  readonly resourceProfile: typeof TSC_RESOURCE_PROFILE;
  readonly limits: TscLimits;
  readonly results: readonly TscNormalizedSource[];
}

/** Source-level bounded API only: helper extraction/tree identity/voting remain separate. */
export async function normalizeTscSources(
  input: readonly TscSourceInput[], options: TscNormalizationOptions = {},
): Promise<TscNormalizationBatch> {
  const { signal, onProgress, timeoutMs = 60_000 } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new TypeError("TSC timeout must be 1..60000ms.");
  const limits = tscLimits(options.limits);
  const grammar = { ...options.grammar };
  signal?.throwIfAborted();
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const timeout = () => new TscNormalizationError("timeout", "TSC normalization batch timed out.");
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeout()), timeoutMs);
  const assertActive = () => {
    if (signal?.aborted) onAbort();
    if (!controller.signal.aborted && performance.now() >= deadline) controller.abort(timeout());
    controller.signal.throwIfAborted();
  };

  try {
    assertActive();
    const sources = prepareTscSources(input, limits, true, assertActive);
    const needed = new Set(sources.map((source) => tscLanguageForPath(source.path)).filter((language) => language !== undefined));
    const provenance = tscSourceProvenance([...needed]);
    const base: Omit<TscNormalizationBatch, "results"> = { provenance, resourceProfile: TSC_RESOURCE_PROFILE, limits };
    if (!sources.length) { assertActive(); return Object.freeze({ ...base, results: Object.freeze([]) }); }
    const assets: TscWorkerRequest["assets"][number][] = [];
    for (const pin of TSC_LANGUAGES) {
      if (!needed.has(pin.language)) continue;
      assertActive();
      onProgress?.({ type: "progress", phase: "provisioning", language: pin.language });
      assertActive();
      const asset = await ensureTscGrammar(pin.language, { ...grammar, signal: controller.signal });
      assets.push({ language: pin.language, path: asset.path });
    }
    assertActive();

    const request: TscWorkerRequest = { protocolVersion: TSC_WORKER_PROTOCOL, resourceProfile: TSC_RESOURCE_PROFILE, sources, assets, provenance, limits };
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => {
      const key = name.toUpperCase();
      return !["NODE_OPTIONS", "NODE_PATH"].includes(key) && !key.startsWith("JITI_");
    }));
    const worker = new Worker(join(__dirname, "tree-sitter-normalization-worker.mjs"), {
      execArgv: [], env,
      resourceLimits: { maxOldGenerationSizeMb: limits.workerHeapMb, stackSizeMb: limits.workerStackMb },
    });
    const results = await executeTscWorker(worker, request, controller.signal, onProgress);
    assertActive();
    return Object.freeze({ ...base, results });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
