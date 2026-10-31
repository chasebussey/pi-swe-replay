import type { LiveIteration } from "../live-state";

export interface LineageNode {
  /** Zero is the replay root, not an iteration. */
  iteration: number;
  parentIteration?: number;
  children: LineageNode[];
}

export interface LineageRow {
  node: LineageNode;
  depth: number;
  prefix: string;
}

export interface IterationLineage {
  /** The replay root followed by any iterations whose exploitation origin is unavailable. */
  roots: LineageNode[];
  byIteration: Map<number, LineageNode>;
  rows: LineageRow[];
  /** Only ancestry affects geometry; regression/tool/selection changes do not. */
  signature: string;
}

/** A display projection of captured generating-iteration provenance, not a sampling policy. */
export function buildIterationLineage(iterations: readonly LiveIteration[]): IterationLineage {
  const root: LineageNode = { iteration: 0, children: [] };
  const byIteration = new Map<number, LineageNode>([[0, root]]);
  const sources = new Map<number, LiveIteration>();
  for (const row of iterations) {
    if (!Number.isSafeInteger(row.iteration) || row.iteration <= 0 || sources.has(row.iteration)) continue;
    sources.set(row.iteration, row);
    byIteration.set(row.iteration, { iteration: row.iteration, children: [] });
  }

  const ordered = [...sources.values()].sort((a, b) => a.iteration - b.iteration);
  const roots = [root];
  for (const row of ordered) {
    const node = byIteration.get(row.iteration)!;
    const source = row.sourceIteration;
    const parent = row.approach !== "exploit" ? root
      : source !== undefined && source > 0 && source < row.iteration ? byIteration.get(source) : undefined;

    if (parent) {
      node.parentIteration = parent.iteration;
      parent.children.push(node);
    } else {
      // Never attach an unknown, self-referential, or future source to the replay root.
      roots.push(node);
    }
  }

  const rows: LineageRow[] = [];
  const pending = roots.map((node) => ({ node, depth: 0, continuation: [] as boolean[], last: true })).reverse();
  while (pending.length > 0) {
    const { node, depth, continuation, last } = pending.pop()!;
    if (node.iteration !== 0) {
      const indent = continuation.map((continues) => continues ? "│  " : "   ").join("");
      const connector = node.parentIteration === undefined ? "?─ " : last ? "└─ " : "├─ ";
      rows.push({ node, depth, prefix: `${indent}${depth > 6 ? "… " : ""}${connector}` });
    }

    const nextContinuation = node.iteration === 0 ? [] : [...continuation, !last].slice(0, 5);
    for (let index = node.children.length - 1; index >= 0; index--) {
      pending.push({ node: node.children[index], depth: depth + 1, continuation: nextContinuation, last: index === node.children.length - 1 });
    }
  }

  const signature = ordered.map((row) => `${row.iteration}:${byIteration.get(row.iteration)!.parentIteration ?? "?"}`).join(";");
  return { roots, byIteration, rows, signature };
}

export function lineageAncestors(lineage: IterationLineage, iteration?: number): Set<number> {
  const ancestors = new Set<number>();
  let node = iteration === undefined ? undefined : lineage.byIteration.get(iteration);
  while (node) {
    ancestors.add(node.iteration);
    node = node.parentIteration === undefined ? undefined : lineage.byIteration.get(node.parentIteration);
  }
  return ancestors;
}
