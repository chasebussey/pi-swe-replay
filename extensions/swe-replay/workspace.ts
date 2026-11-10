import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);

export interface WorkspaceSnapshot {
  rootEntryId: string;
  /** The completed assistant step, or the replay root for the initial state. */
  stepId: string;
  oid: string;
  ref: string;
}

/** A complete content tree; its ref retains tracked and nonignored untracked blobs. */
export interface WorkspaceContentTree {
  rootEntryId: string;
  snapshotOid: string;
  treeOid: string;
  ref: string;
}

export interface WorkspaceTreeFile {
  mode: string;
  oid: string;
  /** Null for non-blob entries (for example gitlinks); their OID is exact identity. */
  content: Buffer | null;
}

/** Optional caller-owned caps, checked before changed blobs are materialized. */
export interface WorkspaceTreeReadBudget {
  readonly maxListingBytes: number;
  listing(bytes: number): void;
  entry(path: Buffer, count: number): void;
  change(path: Buffer, count: number, beforeMode: string | null, afterMode: string | null): void;
  blob(path: Buffer, mode: string, size: number, oid: string): void;
}

export interface WorkspaceTreeChange {
  /** Raw Git path bytes, not a potentially lossy UTF-8 decoding. */
  path: Buffer;
  before: WorkspaceTreeFile | null;
  after: WorkspaceTreeFile | null;
}

/**
 * Git stash-shaped commits, built with temporary indexes: capture never cleans the workspace.
 * Known limitation: restoration cannot undo mutations outside the captured Git state,
 * such as package installs in ignored node_modules directories or global environment changes.
 */
export class ReplayWorkspace {
  private constructor(private readonly cwd: string) {}

  private async git(args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
    const result = await exec("git", args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "SWE-Replay", GIT_AUTHOR_EMAIL: "swe-replay@localhost",
        GIT_COMMITTER_NAME: "SWE-Replay", GIT_COMMITTER_EMAIL: "swe-replay@localhost",
        ...env,
      },
      maxBuffer: 32 * 1024 * 1024,
    });
    return result.stdout;
  }

  static async open(cwd: string): Promise<ReplayWorkspace> {
    const workspace = new ReplayWorkspace(cwd);
    const root = (await workspace.git(["rev-parse", "--show-toplevel"])).trim();
    const result = new ReplayWorkspace(root);
    await result.git(["rev-parse", "--verify", "HEAD"]);
    // Stashes do not capture submodule worktrees or unresolved index stages.
    if ((await result.git(["ls-files", "--stage"])).split("\n").some((line) => line.startsWith("160000 "))) {
      throw new Error("SWE-Replay workspace snapshots do not support submodules.");
    }
    if ((await result.git(["ls-files", "--unmerged"])).trim()) {
      throw new Error("Resolve index conflicts before starting SWE-Replay.");
    }
    return result;
  }

  async capture(rootEntryId: string, stepId: string): Promise<WorkspaceSnapshot> {
    const dir = await mkdtemp(join(tmpdir(), "swe-replay-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    try {
      const head = (await this.git(["rev-parse", "HEAD"])).trim();
      const indexTree = (await this.git(["write-tree"])).trim();
      const index = (await this.git(["commit-tree", indexTree, "-p", head, "-m", "SWE-Replay index"])).trim();
      await this.git(["read-tree", indexTree], env);
      await this.git(["add", "-u", "--", "."], env);
      const tree = (await this.git(["write-tree"], env)).trim();
      const untracked = await this.git(["ls-files", "--others", "--exclude-standard", "-z"]);
      const parents = ["-p", head, "-p", index];
      if (untracked) {
        await this.git(["read-tree", "--empty"], env);
        const paths = join(dir, "paths");
        await writeFile(paths, untracked);
        await this.git(["--literal-pathspecs", "add", `--pathspec-from-file=${paths}`, "--pathspec-file-nul"], env);
        const untrackedTree = (await this.git(["write-tree"], env)).trim();
        const commit = (await this.git(["commit-tree", untrackedTree, "-m", "SWE-Replay untracked"])).trim();
        parents.push("-p", commit);
      }
      const oid = (await this.git(["commit-tree", tree, ...parents, "-m", `SWE-Replay ${rootEntryId} after ${stepId}`])).trim();
      const ref = `refs/swe-replay/${randomUUID()}`;
      await this.git(["update-ref", ref, oid]);
      return { rootEntryId, stepId, oid, ref };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Merge the stash's tracked tree and optional untracked tree without staging real files. */
  async contentTree(snapshot: WorkspaceSnapshot): Promise<WorkspaceContentTree> {
    const dir = await mkdtemp(join(tmpdir(), "swe-replay-tree-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };

    try {
      const parents = (await this.git(["rev-list", "--parents", "-n", "1", snapshot.oid])).trim().split(/\s+/);
      if (parents.length !== 3 && parents.length !== 4) {
        throw new Error("Expected a SWE-Replay stash-shaped workspace snapshot.");
      }

      await this.git(["read-tree", `${snapshot.oid}^{tree}`], env);
      if (parents.length === 4) {
        // --prefix merges disjoint paths into the temporary index, refusing overlaps.
        await this.git(["read-tree", "--prefix=", `${snapshot.oid}^3`], env);
      }

      const treeOid = (await this.git(["write-tree"], env)).trim();
      const ref = `refs/swe-replay/trees/${randomUUID()}`;
      await this.git(["update-ref", ref, treeOid]);

      return { rootEntryId: snapshot.rootEntryId, snapshotOid: snapshot.oid, treeOid, ref };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Read immutable changes in Git byte-path order, without consulting working-tree files. */
  async treeChanges(
    base: WorkspaceContentTree, candidate: WorkspaceContentTree, signal?: AbortSignal,
    budget?: WorkspaceTreeReadBudget,
  ): Promise<WorkspaceTreeChange[]> {
    if (base.rootEntryId !== candidate.rootEntryId) {
      throw new Error("Cannot compare content trees from different replay runs.");
    }

    const gitBytes = async (args: string[], maxBuffer = 32 * 1024 * 1024) => {
      signal?.throwIfAborted();
      const result = await exec("git", args, {
        cwd: this.cwd, encoding: "buffer", signal, maxBuffer: Math.max(1, maxBuffer),
      });
      return result.stdout;
    };
    const list = async (treeOid: string) => {
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(treeOid)) throw new Error("Invalid content tree OID.");
      const output = await gitBytes(["ls-tree", "-r", "-z", ...(budget ? ["-l"] : []), "--full-tree", treeOid], budget?.maxListingBytes);
      budget?.listing(output.length);
      const entries = new Map<string, { path: Buffer; mode: string; type: string; oid: string; size: number | undefined }>();
      let start = 0;
      while (start < output.length) {
        const end = output.indexOf(0, start);
        const tab = output.indexOf(9, start);
        if (end < 0 || tab < start || tab > end) throw new Error("Malformed Git tree listing.");
        const [mode, type, oid, rawSize] = output.subarray(start, tab).toString("ascii").trim().split(/\s+/);
        const size = budget && type === "blob" ? Number(rawSize) : undefined;
        if (size !== undefined && (!/^\d+$/.test(rawSize) || !Number.isSafeInteger(size))) {
          throw new Error("Invalid Git blob size.");
        }
        const path = output.subarray(tab + 1, end);
        budget?.entry(path, entries.size + 1);
        entries.set(path.toString("base64"), { path, mode, type, oid, size });
        start = end + 1;
      }
      return entries;
    };

    const before = await list(base.treeOid);
    const after = await list(candidate.treeOid);
    const paths = [...new Set([...before.keys(), ...after.keys()])];
    paths.sort((a, b) => Buffer.compare(Buffer.from(a, "base64"), Buffer.from(b, "base64")));
    const read = async (entry: ReturnType<typeof before.get>): Promise<WorkspaceTreeFile | null> => {
      if (!entry) return null;
      if (budget && entry.type === "blob") {
        if (entry.size === undefined) throw new Error("Missing bounded Git blob size.");
        budget.blob(entry.path, entry.mode, entry.size, entry.oid);
      }
      const content = entry.type === "blob"
        ? await gitBytes(["cat-file", "blob", entry.oid], budget ? entry.size : undefined) : null;
      if (content !== null && entry.size !== undefined && content.length !== entry.size) {
        throw new Error("Git blob size changed during immutable read.");
      }
      return { mode: entry.mode, oid: entry.oid, content };
    };

    const changed = paths.filter((path) => {
      const left = before.get(path);
      const right = after.get(path);
      return left?.mode !== right?.mode || left?.oid !== right?.oid;
    });
    for (const [index, path] of changed.entries()) {
      budget?.change(Buffer.from(path, "base64"), index + 1, before.get(path)?.mode ?? null, after.get(path)?.mode ?? null);
    }

    const changes: WorkspaceTreeChange[] = [];
    for (const path of changed) {
      signal?.throwIfAborted();
      changes.push({ path: Buffer.from(path, "base64"), before: await read(before.get(path)), after: await read(after.get(path)) });
    }
    return changes;
  }

  /** Exact content patch relative to the initial workspace, not HEAD; never a normalized key. */
  async exportPatch(base: WorkspaceContentTree, candidate: WorkspaceContentTree): Promise<Buffer> {
    if (base.rootEntryId !== candidate.rootEntryId) {
      throw new Error("Cannot export a patch between different replay runs.");
    }

    const result = await exec("git", [
      "-c", "core.quotePath=true", "diff",
      "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-color",
      "--no-renames", "--no-relative", "--diff-algorithm=myers", "--no-indent-heuristic",
      "--unified=3", "--inter-hunk-context=0", "--src-prefix=a/", "--dst-prefix=b/",
      "--line-prefix=", "--output-indicator-new=+", "--output-indicator-old=-",
      "--output-indicator-context= ", base.treeOid, candidate.treeOid, "--",
    ], { cwd: this.cwd, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });

    return result.stdout;
  }

  /** Materialize a snapshot without replacing files in the active checkout. */
  async withEvaluationWorkspace<T>(snapshot: WorkspaceSnapshot, cwd: string, evaluate: (directory: string) => Promise<T>): Promise<T> {
    // Git may canonicalize aliases such as macOS /var -> /private/var.
    // Resolve both paths before computing an offset into the disposable worktree.
    const offset = relative(await realpath(this.cwd), await realpath(cwd));
    if (isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`)) {
      throw new Error("Evaluation working directory must be inside the replay repository.");
    }
    const dir = await mkdtemp(join(tmpdir(), "swe-replay-evaluation-"));
    const root = join(dir, "repo");
    let added = false;
    try {
      await this.git(["worktree", "add", "--detach", root, `${snapshot.oid}^1`]);
      added = true;
      await exec("git", ["stash", "apply", "--index", snapshot.oid], { cwd: root });
      return await evaluate(join(root, offset));
    } finally {
      try {
        if (added) await this.git(["worktree", "remove", "--force", root]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }

  async assertHeadUnchanged(snapshot: WorkspaceSnapshot): Promise<void> {
    const base = (await this.git(["rev-parse", `${snapshot.oid}^1`])).trim();
    if (base !== (await this.git(["rev-parse", "HEAD"])).trim()) {
      throw new Error("Cannot restore a SWE-Replay snapshot after HEAD has changed.");
    }
  }

  /** Caller must retain a current-state backup before this destructive operation. */
  async restore(snapshot: WorkspaceSnapshot, beforeMutation?: () => void): Promise<void> {
    await this.assertHeadUnchanged(snapshot);
    const base = (await this.git(["rev-parse", `${snapshot.oid}^1`])).trim();
    // Avoid overwriting ignored files, including directory/file collisions.
    const target = (await this.git(["ls-tree", "-r", "--name-only", "-z", snapshot.oid])).split("\0").filter(Boolean);
    // reset --hard visits HEAD's paths even if the final snapshot deletes them.
    target.push(...(await this.git(["ls-tree", "-r", "--name-only", "-z", base])).split("\0").filter(Boolean));
    const parents = (await this.git(["rev-list", "--parents", "-n", "1", snapshot.oid])).trim().split(/\s+/);
    if (parents.length === 4) {
      target.push(...(await this.git(["ls-tree", "-r", "--name-only", "-z", `${snapshot.oid}^3`])).split("\0").filter(Boolean));
    }
    const ignored = (await this.git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    if (ignored.some((file) => target.some((path) => file === path || file.startsWith(`${path}/`) || path.startsWith(`${file}/`)))) {
      throw new Error("Ignored files would obstruct SWE-Replay workspace restoration.");
    }
    // Let transactional callers distinguish a preflight refusal from a partial apply.
    beforeMutation?.();
    await this.git(["reset", "--hard", "HEAD"]);
    await this.git(["clean", "-fd"]);
    await this.git(["stash", "apply", "--index", snapshot.oid]);
  }
}

/** Find the nearest recorded state BEFORE a selected assistant step, never its own snapshot. */
export function preStepSnapshot(entries: readonly SessionEntry[], rootEntryId: string, stepId: string): WorkspaceSnapshot {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let entry = byId.get(stepId);
  if (!entry || entry.type !== "message" || entry.message.role !== "assistant") {
    throw new Error(`Invalid replay step: ${stepId}`);
  }
  let ancestorId = entry.parentId;
  const visited = new Set<string>();
  while (ancestorId && !visited.has(ancestorId)) {
    visited.add(ancestorId);
    entry = byId.get(ancestorId);
    if (!entry) break;
    if (entry.type === "custom" && entry.customType === "swe-replay-workspace") {
      const data = entry.data as WorkspaceSnapshot;
      if (data?.rootEntryId === rootEntryId && typeof data.oid === "string" && typeof data.ref === "string") return data;
    }
    if (entry.id === rootEntryId || (entry.type === "custom" && entry.customType === "swe-replay-root")) break;
    ancestorId = entry.parentId;
  }
  throw new Error(`No pre-step workspace snapshot for ${stepId}; older trajectories cannot be restored.`);
}
