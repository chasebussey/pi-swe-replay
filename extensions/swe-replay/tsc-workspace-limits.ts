import type { WorkspaceTreeReadBudget } from "./workspace";
import { tscLanguageForPath } from "./tree-sitter-source";
import { checkTscLimit, type TscLimits } from "./tree-sitter-limits";

/** Operational read/framing caps, never part of successful identity bytes. */
export const TSC_WORKSPACE_RESOURCE_PROFILE = "bounded-tsc-workspace-v1";
export const TSC_WORKSPACE_LIMITS = Object.freeze({
  maxCandidates: 128,
  maxTreeEntries: 100_000,
  maxTreeListingBytes: 16 * 1024 * 1024,
  maxBatchListingBytes: 64 * 1024 * 1024,
  maxChangedFiles: 256,
  maxBatchChangedFiles: 256,
  maxBlobBytes: 8 * 1024 * 1024,
  maxReadBytes: 32 * 1024 * 1024,
  maxIdentityBytes: 32 * 1024 * 1024,
});
export type TscWorkspaceLimits = { readonly [K in keyof typeof TSC_WORKSPACE_LIMITS]: number };

export class TscWorkspaceResourceError extends Error {
  readonly code = "resource-limit";
  constructor(readonly limit: keyof TscWorkspaceLimits, readonly actual: number, readonly maximum: number) {
    super(`TSC workspace limit ${limit}: ${actual} exceeds ${maximum}.`);
    this.name = "TscWorkspaceResourceError";
  }
}

export function tscWorkspaceLimits(overrides: Partial<TscWorkspaceLimits> = {}): TscWorkspaceLimits {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new TypeError("Invalid TSC workspace limits.");
  const limits = { ...TSC_WORKSPACE_LIMITS } as { -readonly [K in keyof TscWorkspaceLimits]: number };
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, name) || typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0
      || value > TSC_WORKSPACE_LIMITS[name as keyof TscWorkspaceLimits]) {
      throw new TypeError(`Invalid TSC workspace limit: ${name}.`);
    }
    limits[name as keyof TscWorkspaceLimits] = value;
  }
  return Object.freeze(limits);
}

export class TscWorkspaceBudget implements WorkspaceTreeReadBudget {
  private listingBytes = 0;
  private changedFiles = 0;
  private readBytes = 0;
  private potentialSources = 0;
  private sourceBytes = 0;
  private uniqueBytes = 0;
  private uniqueSources = new Set<string>();
  constructor(readonly limits: TscWorkspaceLimits, readonly sourceLimits: TscLimits, readonly assertActive: () => void) {}

  get maxListingBytes(): number {
    this.assertActive();
    return Math.min(this.limits.maxTreeListingBytes, this.limits.maxBatchListingBytes - this.listingBytes);
  }

  check(name: keyof TscWorkspaceLimits, actual: number): void {
    this.assertActive();
    if (actual > this.limits[name]) throw new TscWorkspaceResourceError(name, actual, this.limits[name]);
  }

  listing(bytes: number): void {
    this.listingBytes += bytes;
    this.check("maxBatchListingBytes", this.listingBytes);
  }

  entry(path: Buffer, count: number): void {
    this.check("maxTreeEntries", count);
    checkTscLimit(this.sourceLimits, "maxPathBytes", path.length);
  }

  change(path: Buffer, count: number, beforeMode: string | null, afterMode: string | null): void {
    this.check("maxChangedFiles", count);
    this.check("maxBatchChangedFiles", ++this.changedFiles);
    const regular = (mode: string | null) => mode === null || mode === "100644" || mode === "100755";
    if (tscLanguageForPath(path) && regular(beforeMode) && regular(afterMode)) {
      // Reserve both envelopes (including a missing side) before blob allocation.
      // Invalid/binary inputs may later fall back, but cannot bypass this bound.
      this.potentialSources += 2;
      checkTscLimit(this.sourceLimits, "maxSources", this.potentialSources);
      this.sourceBytes += 2 * (path.length + 32); // Bound generated source IDs too.
      checkTscLimit(this.sourceLimits, "maxBatchBytes", this.sourceBytes);
      if (beforeMode === null || afterMode === null) this.reserveUnique(`${tscLanguageForPath(path)}:empty`, 0);
    }
  }

  private reserveUnique(key: string, size: number): void {
    if (this.uniqueSources.has(key)) return;
    checkTscLimit(this.sourceLimits, "maxUniqueSources", this.uniqueSources.size + 1);
    this.uniqueBytes += size;
    checkTscLimit(this.sourceLimits, "maxUniqueBytes", this.uniqueBytes);
    this.uniqueSources.add(key);
  }

  blob(path: Buffer, mode: string, size: number, oid: string): void {
    this.check("maxBlobBytes", size);
    const language = tscLanguageForPath(path);
    if ((mode === "100644" || mode === "100755") && language) {
      checkTscLimit(this.sourceLimits, "maxSourceBytes", size);
      this.sourceBytes += size;
      checkTscLimit(this.sourceLimits, "maxBatchBytes", this.sourceBytes);
      this.reserveUnique(`${language}:${size === 0 ? "empty" : oid}`, size);
    }
    this.readBytes += size;
    this.check("maxReadBytes", this.readBytes);
  }
}
