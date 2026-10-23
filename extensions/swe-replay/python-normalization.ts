import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

import {
  BUNDLED_PYTHON_VERSION, PYODIDE_VERSION, PYTHON_NORMALIZATION_PROVENANCE,
  type PythonNormalizationProvenance,
} from "./normalization-policy";

export {
  AGENTLESS_REVISION, BUNDLED_PYTHON_VERSION, PYODIDE_VERSION, PYTHON_NORMALIZATION_POLICY,
} from "./normalization-policy";

const exec = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60_000;

export interface PythonPatchFile {
  path: string;
  before: string;
  after: string;
}

export interface PythonPatchInput {
  /** Caller-supplied order is preserved, as in Agentless. The tree adapter must sort paths. */
  files: readonly PythonPatchFile[];
  /** Agentless short-circuits empty raw patches even when the supplied sources are invalid. */
  rawPatch?: string;
}

export interface PythonNormalizationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PythonNormalizationDiagnostic {
  kind: "exact-content-fallback";
  path: string;
  pythonType: "SyntaxError" | "IndentationError" | "TabError";
  message: string;
}

export interface PythonNormalizationResult extends PythonNormalizationProvenance {
  patches: { key: string; empty: boolean; diagnostics: PythonNormalizationDiagnostic[] }[];
}

interface AgentlessFile extends PythonPatchFile {
  kind: "agentless";
  onlyNewFunctions: boolean;
}

interface ExactFile extends PythonPatchFile {
  kind: "exact";
  diagnostic: PythonNormalizationDiagnostic;
}

type PreparedFile = AgentlessFile | ExactFile;

interface WorkerFailure {
  message: string;
  pythonType?: string;
  path?: string;
  patchIndex?: number;
}

type WorkerResult = { patches: PreparedFile[][] } | { error: WorkerFailure };

export class PythonNormalizationError extends Error {
  readonly pythonType?: string;
  readonly filePath?: string;
  readonly patchIndex?: number;

  constructor(failure: WorkerFailure) {
    const location = failure.path ? ` for ${failure.path} (patch ${failure.patchIndex})` : "";
    const type = failure.pythonType ? `${failure.pythonType}: ` : "";
    super(`Python normalization failed${location}: ${type}${failure.message}`);
    this.name = "PythonNormalizationError";
    this.pythonType = failure.pythonType;
    this.filePath = failure.path;
    this.patchIndex = failure.patchIndex;
  }
}

function validatePatches(patches: readonly PythonPatchInput[]): void {
  for (const patch of patches) {
    if (patch.rawPatch !== undefined && typeof patch.rawPatch !== "string") {
      throw new Error("Python normalization rawPatch must be a string.");
    }

    const paths = new Set<string>();
    for (const file of patch.files) {
      if (typeof file.path !== "string") throw new Error("Python normalization path must be a string.");
      if (typeof file.before !== "string" || typeof file.after !== "string") {
        throw new Error(`Python normalization sources must be strings: ${file.path}`);
      }

      const parts = file.path.split("/");
      if (!file.path.endsWith(".py") || isAbsolute(file.path) || /^[a-z]:/i.test(file.path)
        || file.path.includes("\\") || file.path.includes("\0")
        || parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
        throw new Error(`Invalid Python normalization path: ${file.path}`);
      }
      if (paths.has(file.path)) throw new Error(`Duplicate Python normalization path: ${file.path}`);
      paths.add(file.path);
    }
  }
}

async function prepareInWorker(patches: readonly PythonPatchInput[], signal: AbortSignal): Promise<PreparedFile[][]> {
  signal.throwIfAborted();
  const worker = new Worker(join(__dirname, "python-normalization-worker.mjs"), {
    // Do not inherit Pi/Node loader or eval flags into the plain-ESM worker.
    execArgv: [],
    workerData: { patches, pyodideVersion: PYODIDE_VERSION, pythonVersion: BUNDLED_PYTHON_VERSION },
  });
  let onAbort = () => {};

  try {
    return await new Promise<PreparedFile[][]>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      worker.once("message", (result: WorkerResult) => {
        if ("error" in result) reject(new PythonNormalizationError(result.error));
        else resolve(result.patches);
      });
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Python normalization worker exited before returning a result (code ${code}).`)));
      if (signal.aborted) onAbort();
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Always release the embedded interpreter, including after startup errors/abort.
    await worker.terminate();
    worker.removeAllListeners();
  }
}

async function normalizedDiff(file: AgentlessFile, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "swe-replay-normalization-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_COUNT: "0",
    GIT_ATTR_NOSYSTEM: "1", GIT_DEFAULT_HASH: "sha1",
  });
  const git = async (...args: string[]) => {
    // Git also reads default XDG attributes/ignore files without global config.
    const result = await exec("git", [
      "-c", `core.attributesFile=${devNull}`, "-c", `core.excludesFile=${devNull}`, ...args,
    ], { cwd: directory, env, signal, maxBuffer: 32 * 1024 * 1024 });
    return result.stdout;
  };

  try {
    await git("init", "--template=");
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.before, "utf8");
    // The diff compares index to working tree: no synthetic commit or identity needed.
    await git("--literal-pathspecs", "add", "--", file.path);
    await writeFile(target, file.after, "utf8");
    const diff = await git(
      "-c", "core.quotePath=true", "diff", "--no-ext-diff", "--no-textconv", "--no-color",
      "--no-renames", "--diff-algorithm=myers", "--no-indent-heuristic", "--unified=3",
      "--inter-hunk-context=0", "--abbrev=7", "--src-prefix=a/", "--dst-prefix=b/", ".",
    );

    // Python splitlines() omits the trailing newline; preserve that upstream quirk.
    if (file.onlyNewFunctions) {
      return diff.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
        .filter((line) => line.startsWith("+") || line.startsWith("-")).join("\n");
    }
    return diff;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Preserve upstream keys unless actual source changes need exact-content fallback. */
async function assemblePatch(files: readonly PreparedFile[], signal: AbortSignal): Promise<PythonNormalizationResult["patches"][number]> {
  const diagnostics: PythonNormalizationDiagnostic[] = [];
  const components: (["agentless", string] | ["exact", string, string, string])[] = [];
  let normalizedSegment = "";
  let hasExactChanges = false;

  for (const file of files) {
    signal.throwIfAborted();
    if (file.kind === "agentless") {
      normalizedSegment += await normalizedDiff(file, signal);
      continue;
    }

    diagnostics.push(file.diagnostic);
    // Unchanged invalid source is still a no-op, not a nonempty voting key.
    if (file.before === file.after) continue;

    if (normalizedSegment) components.push(["agentless", normalizedSegment]);
    normalizedSegment = "";
    components.push(["exact", file.path, file.before, file.after]);
    hasExactChanges = true;
  }

  let key = normalizedSegment;
  if (hasExactChanges) {
    if (normalizedSegment) components.push(["agentless", normalizedSegment]);
    // Domain-tagged JSON cannot collide with upstream diff keys ("diff --git" or
    // "---" prefixes). Frame raw sources, paths and normalized segments separately.
    key = JSON.stringify(["exact-python-source-v1", components]);
  }

  return { key, empty: !key.trim(), diagnostics };
}

/**
 * Normalize a batch in one disposable, offline CPython/WASM worker. No snapshot
 * source is executed, no host Python is needed, and the active checkout is unused.
 * Syntax errors use original source on both sides, with recorded diagnostics;
 * runtime, resource and infrastructure errors remain fatal to the batch.
 */
export async function normalizePythonPatches(
  patches: readonly PythonPatchInput[], options: PythonNormalizationOptions = {},
): Promise<PythonNormalizationResult> {
  validatePatches(patches);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Normalization timeout must be positive and finite.");
  options.signal?.throwIfAborted();

  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("Python normalization timed out.")), timeoutMs);

  try {
    const prepared = patches.length ? await prepareInWorker(patches, controller.signal) : [];
    const normalized: PythonNormalizationResult["patches"] = [];
    for (const files of prepared) {
      normalized.push(await assemblePatch(files, controller.signal));
    }
    controller.signal.throwIfAborted();

    return { ...PYTHON_NORMALIZATION_PROVENANCE, patches: normalized };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
