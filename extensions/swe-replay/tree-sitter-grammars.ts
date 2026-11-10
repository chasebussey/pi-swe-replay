import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TSC_GRAMMAR_SOURCE_POLICY, TSC_LANGUAGES, type TscLanguage } from "./normalization-policy";

type GrammarPin = typeof TSC_LANGUAGES[number];
export type GrammarAcquisitionCode = "invalid-request" | "cache-miss" | "cache-error"
  | "network-error" | "http-error" | "invalid-redirect" | "integrity-error" | "timeout";

export class GrammarAcquisitionError extends Error {
  constructor(
    readonly code: GrammarAcquisitionCode, message: string,
    readonly httpStatus?: number, readonly responseBody?: string,
  ) {
    super(message);
    this.name = "GrammarAcquisitionError";
  }
}

export interface GrammarAcquisitionOptions {
  cacheDir?: string;
  offline?: boolean;
  signal?: AbortSignal;
  /** Includes cache verification, download, and atomic cache installation. */
  timeoutMs?: number;
  /** Transport injection, not an alternate URL/source configuration. */
  fetch?: typeof globalThis.fetch;
}

export interface VerifiedGrammarAsset {
  readonly language: TscLanguage;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly sourcePolicy: typeof TSC_GRAMMAR_SOURCE_POLICY;
  readonly repository: string;
  readonly releaseTag: string;
  readonly asset: string;
  readonly cacheStatus: "hit" | "downloaded" | "repaired";
}

export const TSC_GRAMMAR_ACQUISITION_LIMITS = Object.freeze({
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 120_000,
  maxRedirects: 3,
  maxErrorBodyBytes: 2048,
  maxRegistryAssetBytes: 8 * 1024 * 1024,
});
const {
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS, maxTimeoutMs: MAX_TIMEOUT_MS,
  maxRedirects: MAX_REDIRECTS, maxErrorBodyBytes: MAX_ERROR_BYTES,
  maxRegistryAssetBytes: MAX_ASSET_BYTES,
} = TSC_GRAMMAR_ACQUISITION_LIMITS;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RELEASE_HOSTS = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

function grammarPin(language: TscLanguage): GrammarPin {
  const pin = TSC_LANGUAGES.find((entry) => entry.language === language);
  if (!pin) throw new GrammarAcquisitionError("invalid-request", "No approved Tree-sitter grammar for the requested language.");
  if (!/^tree-sitter\/tree-sitter-[a-z0-9-]+$/.test(pin.repository)
    || !/^v\d+\.\d+\.\d+$/.test(pin.releaseTag) || !/^tree-sitter-[a-z0-9-]+\.wasm$/.test(pin.asset)
    || !/^[0-9a-f]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.bytes) || pin.bytes <= 0 || pin.bytes > MAX_ASSET_BYTES) {
    throw new GrammarAcquisitionError("invalid-request", "Invalid approved Tree-sitter release registry entry.");
  }
  return pin;
}

/** Only checked-in registry entries can select a repository, tag or artifact. */
export function tscGrammarReleaseUrl(language: TscLanguage): string {
  const pin = grammarPin(language);
  return `https://github.com/${pin.repository}/releases/download/${pin.releaseTag}/${pin.asset}`;
}

export function defaultTscGrammarCacheDir(): string {
  const root = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return resolve(root, "pi-swe-replay", "tsc", "grammars");
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup failure must not replace the original HTTP/redirect diagnostic.
  }
}

function approvedRedirect(location: string, current: string): string {
  let target: URL;
  try {
    target = new URL(location, current);
  } catch {
    throw new GrammarAcquisitionError("invalid-redirect", "Invalid grammar release redirect.");
  }
  if (target.protocol !== "https:" || target.username || target.password || target.port || target.hash
    || !RELEASE_HOSTS.has(target.hostname)) {
    throw new GrammarAcquisitionError("invalid-redirect", "Grammar redirect is not an approved GitHub release-asset host.");
  }
  return target.href;
}

async function errorBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_ERROR_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const retained = value.subarray(0, MAX_ERROR_BYTES - total);
      parts.push(Buffer.from(retained));
      total += retained.byteLength;
    }
    return Buffer.concat(parts).toString("utf8");
  } finally {
    try { await reader.cancel(); } catch { /* Keep the HTTP status/body evidence. */ }
    reader.releaseLock();
  }
}

async function downloadResponse(pin: GrammarPin, fetcher: typeof fetch, signal: AbortSignal): Promise<Response> {
  let url = tscGrammarReleaseUrl(pin.language);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetcher(url, { method: "GET", redirect: "manual", credentials: "omit", signal });
    } catch {
      signal.throwIfAborted();
      // Do not leak signed redirect query strings through transport errors.
      throw new GrammarAcquisitionError("network-error", `Could not fetch the approved ${pin.language} grammar release.`);
    }

    if (response.redirected) {
      await cancelBody(response);
      throw new GrammarAcquisitionError("invalid-redirect", "Grammar transport followed a redirect without validation.");
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await cancelBody(response);
      if (!location || redirects === MAX_REDIRECTS) {
        throw new GrammarAcquisitionError("invalid-redirect", "Missing grammar redirect target or too many redirects.");
      }
      url = approvedRedirect(location, url);
      continue;
    }
    if (response.status !== 200) {
      const body = await errorBody(response);
      signal.throwIfAborted();
      throw new GrammarAcquisitionError("http-error", `Grammar release returned HTTP ${response.status}.`, response.status, body);
    }
    return response;
  }
  throw new GrammarAcquisitionError("invalid-redirect", "Too many grammar release redirects.");
}

async function cachedGrammarValid(filename: string, pin: GrammarPin, signal: AbortSignal): Promise<"valid" | "missing" | "invalid"> {
  let file;
  try {
    const entry = await lstat(filename);
    if (!entry.isFile() || entry.size !== pin.bytes) return "invalid";
    file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    if (errorCode(error) === "ELOOP") return "invalid";
    throw error;
  }

  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== pin.bytes) return "invalid";
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > pin.bytes) return "invalid";
      hash.update(buffer.subarray(0, bytesRead));
    }
    return total === pin.bytes && hash.digest("hex") === pin.sha256 ? "valid" : "invalid";
  } finally {
    await file.close();
  }
}

async function installDownload(
  response: Response, filename: string, pin: GrammarPin, signal: AbortSignal,
): Promise<void> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > pin.bytes)) {
    await cancelBody(response);
    throw new GrammarAcquisitionError("integrity-error", "Grammar response exceeds the pinned asset size.");
  }
  if (!response.body) throw new GrammarAcquisitionError("integrity-error", "Grammar release has no response body.");

  const temporary = `${filename}.${randomUUID()}.tmp`;
  const reader = response.body.getReader();
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let total = 0;
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > pin.bytes) throw new GrammarAcquisitionError("integrity-error", "Grammar download exceeds the pinned asset size.");
      hash.update(value);
      await file.writeFile(value);
    }
    if (total !== pin.bytes || hash.digest("hex") !== pin.sha256) {
      throw new GrammarAcquisitionError("integrity-error", "Grammar download does not match its pinned size and SHA-256.");
    }
    signal.throwIfAborted();
    await file.sync();
    await file.close();
    file = undefined;
    signal.throwIfAborted();
    await rename(temporary, filename);
  } finally {
    try { await reader.cancel(); } catch { /* Preserve the primary failure. */ }
    reader.releaseLock();
    try { await file?.close(); } finally { await rm(temporary, { force: true }); }
  }
}

/**
 * Provision pinned grammar bytes in the host, before offline worker execution.
 * Unsupported paths are handled by source classification, not this API. A known
 * grammar's acquisition failure must reject normalization, never become a vote.
 * A path receipt is not permanent trust: workers must rehash the bytes they load.
 */
export async function ensureTscGrammar(
  language: TscLanguage, options: GrammarAcquisitionOptions = {},
): Promise<VerifiedGrammarAsset> {
  const pin = grammarPin(language);
  const { cacheDir, offline = false, signal, fetch: injectedFetch } = options;
  const fetcher = injectedFetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new GrammarAcquisitionError("invalid-request", `Grammar timeout must be an integer from 1 to ${MAX_TIMEOUT_MS}ms.`);
  }
  if (cacheDir !== undefined && (typeof cacheDir !== "string" || !cacheDir)) {
    throw new GrammarAcquisitionError("invalid-request", "Grammar cache directory must be a nonempty path.");
  }
  if (typeof offline !== "boolean" || injectedFetch !== undefined && typeof injectedFetch !== "function") {
    throw new GrammarAcquisitionError("invalid-request", "Invalid grammar acquisition options.");
  }
  signal?.throwIfAborted();
  const directory = resolve(cacheDir ?? defaultTscGrammarCacheDir());
  const filename = join(directory, `${pin.sha256}.wasm`);

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new GrammarAcquisitionError("timeout", "Grammar acquisition timed out.")), timeoutMs);
  let phase: "cache" | "download" = "cache";
  try {
    if (signal?.aborted) onAbort();
    controller.signal.throwIfAborted();
    const cached = await cachedGrammarValid(filename, pin, controller.signal);
    if (cached !== "valid") {
      if (offline) throw new GrammarAcquisitionError("cache-miss", `No verified cached ${language} grammar is available offline.`);
      if (typeof fetcher !== "function") throw new GrammarAcquisitionError("network-error", "No HTTP transport is available for grammar acquisition.");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      controller.signal.throwIfAborted();
      phase = "download";
      const response = await downloadResponse(pin, fetcher, controller.signal);
      await installDownload(response, filename, pin, controller.signal);
    }
    controller.signal.throwIfAborted();
    return Object.freeze({ language, path: filename, sha256: pin.sha256, bytes: pin.bytes,
      sourcePolicy: TSC_GRAMMAR_SOURCE_POLICY, repository: pin.repository,
      releaseTag: pin.releaseTag, asset: pin.asset,
      cacheStatus: cached === "valid" ? "hit" : cached === "invalid" ? "repaired" : "downloaded" });
  } catch (error) {
    controller.signal.throwIfAborted();
    if (error instanceof GrammarAcquisitionError) throw error;
    const cacheFailure = phase === "cache" || error instanceof Error && "syscall" in error;
    throw new GrammarAcquisitionError(cacheFailure ? "cache-error" : "network-error",
      cacheFailure ? "Could not verify or install the grammar cache." : "Grammar acquisition failed before a verified asset was installed.");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
