import { lineageAncestors, type IterationLineage, type LineageNode } from "./iteration-lineage";

export interface ShapeNode {
  kind: "root" | "iteration" | "bundle";
  iteration?: number;
  unknownOrigin: boolean;
  members: number[];
  children: ShapeNode[];
  x: number;
  y: number;
}

export interface SearchShape {
  width: number;
  height: number;
  nodes: ShapeNode[];
  edges: { parent: ShapeNode; child: ShapeNode }[];
  coveringNode: Map<number, ShapeNode>;
  bundled: boolean;
}

interface SubtreeSize { leaves: number }

/** Allocate a bounded number of leaf lanes independently of selection and live status. */
function laneBudgets(nodes: readonly LineageNode[], budget: number, sizes: Map<number, SubtreeSize>): number[] {
  const budgets = nodes.map(() => 1);
  let remaining = budget - nodes.length;
  while (remaining > 0) {
    let allocated = false;
    for (let index = 0; index < nodes.length && remaining > 0; index++) {
      if (budgets[index] >= sizes.get(nodes[index].iteration)!.leaves) continue;
      budgets[index]++;
      remaining--;
      allocated = true;
    }
    if (!allocated) break;
  }
  return budgets;
}

/** Fixed-canvas vertical topology. Bundles summarize real subtrees, never invent edges. */
export function layoutSearchShape(lineage: IterationLineage, width: number, height: number): SearchShape {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  const shape: SearchShape = { width, height, nodes: [], edges: [], coveringNode: new Map(), bundled: false };
  if (width === 0 || height === 0) return shape;

  const sizes = new Map<number, SubtreeSize>();
  const ordered = [lineage.roots[0], ...lineage.rows.map((row) => row.node)];
  for (let index = ordered.length - 1; index >= 0; index--) {
    const node = ordered[index];
    const children = node.children.map((child) => sizes.get(child.iteration)!);
    sizes.set(node.iteration, {
      leaves: children.length ? children.reduce((sum, child) => sum + child.leaves, 0) : 1,
    });
  }

  const leafBudget = Math.floor((width - 1) / 4) + 1;
  const maxDepth = Math.floor((height - 1) / 3);
  const bundle = (sources: readonly LineageNode[], depth: number): ShapeNode => {
    const members: number[] = [];
    const pending = [...sources];
    while (pending.length) {
      const node = pending.pop()!;
      members.push(node.iteration);
      for (const child of node.children) pending.push(child);
    }
    shape.bundled = true;
    return { kind: "bundle", unknownOrigin: false, members, children: [], x: 0, y: depth * 3 };
  };

  const projectForest = (sources: readonly LineageNode[], budget: number, depth: number): ShapeNode[] => {
    // Overflow siblings share one lane; distinct roots remain disconnected in the drawing.
    if (sources.length > budget) {
      const visible = sources.slice(0, budget - 1).map((node) => project(node, 1, depth));
      return [...visible, bundle(sources.slice(budget - 1), depth)];
    }
    const budgets = laneBudgets(sources, budget, sizes);
    return sources.map((node, index) => project(node, budgets[index], depth));
  };
  const project = (source: LineageNode, budget: number, depth: number): ShapeNode => {
    if (depth >= maxDepth && source.children.length > 0) return bundle([source], depth);
    return {
      kind: source.iteration === 0 ? "root" : "iteration", iteration: source.iteration,
      unknownOrigin: source.iteration !== 0 && source.parentIteration === undefined,
      members: [source.iteration], x: 0, y: depth * 3,
      children: projectForest(source.children, budget, depth + 1),
    };
  };

  const roots = projectForest(lineage.roots, leafBudget, 0);
  let lane = 0;
  const place = (node: ShapeNode) => {
    for (const child of node.children) place(child);
    node.x = node.children.length
      ? Math.floor((node.children[0].x + node.children.at(-1)!.x) / 2)
      : lane++ * 4;
    shape.nodes.push(node);
    for (const member of node.members) shape.coveringNode.set(member, node);
    for (const child of node.children) shape.edges.push({ parent: node, child });
  };
  // Projected depth is bounded by terminal height; traversing the full lineage above is iterative.
  for (const root of roots) place(root);
  // Give small trees breathing room, then tighten to four-column lanes as they grow.
  const spacing = lane > 1 ? Math.min(10, Math.floor((width - 1) / (lane - 1))) : 4;
  const offset = Math.floor((width - ((lane - 1) * spacing + 1)) / 2);
  for (const node of shape.nodes) node.x = Math.round(node.x * spacing / 4) + offset;
  return shape;
}

export type ShapeTone = "muted" | "accent" | "success" | "dim";
export interface ShapeHighlight {
  selectedIteration?: number;
  activeIteration?: number;
  representativeIteration?: number;
  pulse: boolean;
}

// Connection masks: north=1, east=2, south=4, west=8.
const connectors: Record<number, string> = {
  1: "│", 2: "─", 3: "└", 4: "│", 5: "│", 6: "┌", 7: "├",
  8: "─", 9: "┘", 10: "─", 11: "┴", 12: "┐", 13: "┤", 14: "┬", 15: "┼",
};

/** Paint only. Highlight/pulse changes never change geometry or consume randomness. */
export function renderSearchShape(
  shape: SearchShape,
  lineage: IterationLineage,
  highlight: ShapeHighlight,
  style: (tone: ShapeTone, text: string) => string,
): string[] {
  const { width, height } = shape;
  if (!width || !height) return [];
  const cells = Array.from({ length: height }, () => Array<number>(width).fill(0));
  const tones = Array.from({ length: height }, () => Array<ShapeTone>(width).fill("muted"));
  const selectedPath = new Set([...lineageAncestors(lineage, highlight.selectedIteration)]
    .map((id) => shape.coveringNode.get(id)));
  const active = highlight.activeIteration === undefined ? undefined : shape.coveringNode.get(highlight.activeIteration);
  const representative = highlight.representativeIteration === undefined ? undefined : shape.coveringNode.get(highlight.representativeIteration);

  const connect = (x: number, y: number, nextX: number, nextY: number, accent: boolean) => {
    const dx = Math.sign(nextX - x);
    const dy = Math.sign(nextY - y);
    while (x !== nextX || y !== nextY) {
      const forward = dx > 0 ? 2 : dx < 0 ? 8 : dy > 0 ? 4 : 1;
      const reverse = dx > 0 ? 8 : dx < 0 ? 2 : dy > 0 ? 1 : 4;
      cells[y][x] |= forward;
      cells[y + dy][x + dx] |= reverse;
      if (accent) { tones[y][x] = "accent"; tones[y + dy][x + dx] = "accent"; }
      x += dx;
      y += dy;
    }
  };
  for (const { parent, child } of shape.edges) {
    const accent = selectedPath.has(parent) && selectedPath.has(child);
    const junctionY = parent.y + 2;
    connect(parent.x, parent.y, parent.x, junctionY, accent);
    connect(parent.x, junctionY, child.x, junctionY, accent);
    connect(child.x, junctionY, child.x, child.y, accent);
  }

  const glyphs = cells.map((row) => row.map((mask) => connectors[mask] ?? " "));
  for (const node of shape.nodes) {
    let glyph = node.unknownOrigin ? "?" : "●";
    if (node.kind === "root") glyph = "◆";
    if (node.kind === "bundle") {
      const count = node.members.length;
      glyph = count > 32 ? "▓" : count > 8 ? "▒" : "░";
    }

    let tone: ShapeTone = selectedPath.has(node) ? "accent" : "muted";
    if (node === active) {
      tone = highlight.pulse ? "accent" : "dim";
      if (node.kind === "iteration") glyph = highlight.pulse ? "◉" : "◎";
    }
    if (node === representative) {
      tone = "success";
      if (node.kind === "iteration") glyph = "★";
    }
    glyphs[node.y][node.x] = glyph;
    tones[node.y][node.x] = tone;
  }

  return glyphs.map((row, y) => {
    // Style runs rather than individual cells; keep state free of theme-dependent strings.
    let rendered = "";
    let start = 0;
    while (start < width) {
      const tone = tones[y][start];
      let end = start + 1;
      while (end < width && tones[y][end] === tone) end++;
      rendered += style(tone, row.slice(start, end).join(""));
      start = end;
    }
    return rendered;
  });
}
