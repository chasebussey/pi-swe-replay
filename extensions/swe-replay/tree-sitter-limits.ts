/** Operational caps, never part of successful equivalence identities. */
export const TSC_RESOURCE_PROFILE = "bounded-tsc-sources-v1";
export const TSC_NORMALIZATION_LIMITS = Object.freeze({
  maxSources: 512,
  maxUniqueSources: 256,
  maxPathBytes: 4096,
  maxSourceBytes: 512 * 1024,
  maxBatchBytes: 8 * 1024 * 1024,
  maxUniqueBytes: 4 * 1024 * 1024,
  maxSourceNodes: 100_000,
  maxBatchNodes: 500_000,
  maxDepth: 256,
  maxSourceCanonicalBytes: 4 * 1024 * 1024,
  maxBatchCanonicalBytes: 16 * 1024 * 1024,
  maxResponseBytes: 48 * 1024 * 1024,
  workerHeapMb: 256,
  workerStackMb: 4,
});
export type TscLimits = { readonly [K in keyof typeof TSC_NORMALIZATION_LIMITS]: number };
export type TscLimitName = keyof TscLimits;

export class TscResourceError extends Error {
  readonly code = "resource-limit";
  constructor(readonly limit: TscLimitName, readonly actual: number, readonly maximum: number) {
    super(`TSC resource limit ${limit}: ${actual} exceeds ${maximum}.`);
    this.name = "TscResourceError";
  }
}

/** Overrides can tighten caps for controlled workloads/tests, never relax them. */
export function tscLimits(overrides: Partial<TscLimits> = {}): TscLimits {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new TypeError("Invalid TSC limits.");
  const limits = { ...TSC_NORMALIZATION_LIMITS } as { -readonly [K in TscLimitName]: number };
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, name) || typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0
      || value > TSC_NORMALIZATION_LIMITS[name as TscLimitName]
      || name === "workerHeapMb" && value < 64 || name === "workerStackMb" && value < 2) {
      throw new TypeError(`Invalid TSC limit: ${name}.`);
    }
    limits[name as TscLimitName] = value;
  }
  return Object.freeze(limits);
}

export function checkTscLimit(limits: TscLimits, name: TscLimitName, actual: number): void {
  if (actual > limits[name]) throw new TscResourceError(name, actual, limits[name]);
}

export interface TscBatchUsage { nodes: number; canonicalBytes: number }
export class TscTraversalBudget {
  nodes = 0;
  depth = 0;
  canonicalBytes = 0;
  constructor(
    readonly limits: TscLimits = TSC_NORMALIZATION_LIMITS,
    readonly batch: TscBatchUsage = { nodes: 0, canonicalBytes: 0 },
  ) {}

  visit(depth: number): void {
    checkTscLimit(this.limits, "maxDepth", depth);
    checkTscLimit(this.limits, "maxSourceNodes", this.nodes + 1);
    checkTscLimit(this.limits, "maxBatchNodes", this.batch.nodes + 1);
    this.nodes++;
    this.batch.nodes++;
    this.depth = Math.max(this.depth, depth);
  }

  children(count: number, pending: number): void {
    // Check before Node.children materializes a potentially wide JS array.
    checkTscLimit(this.limits, "maxSourceNodes", this.nodes + pending + count);
    checkTscLimit(this.limits, "maxBatchNodes", this.batch.nodes + pending + count);
  }

  output(bytes: number): void {
    checkTscLimit(this.limits, "maxSourceCanonicalBytes", bytes);
    this.canonicalBytes = bytes;
  }
}
