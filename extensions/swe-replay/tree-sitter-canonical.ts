import type { Node } from "web-tree-sitter";
import type { TscLanguage } from "./normalization-policy";
import { docstringStatement, isCommentNode } from "./tree-sitter-documentation";
import { literalChildren, protectedLiteralFragment, syntaxChildren, type CanonicalChild } from "./tree-sitter-literals";

export type CanonicalSyntax =
  | readonly ["token", string, string]
  | readonly ["fragment", string, string]
  | readonly ["node", string, readonly CanonicalEdge[]];
export type CanonicalEdge = readonly [string | null, CanonicalSyntax];

export interface SyntaxIssue {
  kind: "error" | "missing" | "unsupported-trivia";
  nodeType: string;
  /** UTF-16 indices into the decoded, BOM-peeled source, as in web-tree-sitter. */
  startIndex: number;
  endIndex: number;
}

export type SyntaxClassification = {
  excludedNodeIds: ReadonlySet<number>;
  removedComments: number;
  removedDocstrings: number;
  issues: readonly SyntaxIssue[];
  hasSyntaxError: boolean;
};

export type SyntaxCanonicalization =
  | { kind: "canonical"; root: CanonicalSyntax; classification: SyntaxClassification }
  | { kind: "exact"; reason: "syntax-error" | "unsupported-trivia"; issues: readonly SyntaxIssue[] };

const MAX_SOURCE_ISSUES = 8;

/** Classify the unmodified tree, including errors in nodes that will be omitted. */
export function classifySyntaxTree(root: Node, source: string, language: TscLanguage): SyntaxClassification {
  const excluded = new Set<number>();
  const issues: SyntaxIssue[] = [];
  let removedComments = 0;
  let removedDocstrings = 0;
  let hasSyntaxError = root.hasError;
  const pending = [root];
  const report = (issue: SyntaxIssue) => {
    if (issues.length < MAX_SOURCE_ISSUES) {
      issues.push(issue);
    } else if (issue.kind !== "unsupported-trivia"
      && !issues.some((recorded) => recorded.kind !== "unsupported-trivia")) {
      // Keep at least one actual parse error when earlier trivia filled the cap.
      issues[MAX_SOURCE_ISSUES - 1] = issue;
    }
  };
  const checkGap = (startIndex: number, endIndex: number, nodeType: string) => {
    // A leading marker was already peeled by the source adapter. Grammars may
    // otherwise ignore U+FEFF as trivia; do not silently erase it from identity.
    if (source.slice(startIndex, endIndex).includes("\uFEFF")) {
      report({ kind: "unsupported-trivia", nodeType, startIndex, endIndex });
    }
  };
  checkGap(0, root.startIndex, root.type);
  checkGap(root.endIndex, source.length, root.type);

  while (pending.length) {
    const node = pending.pop()!;
    if (node.isError || node.isMissing) {
      hasSyntaxError = true;
      report({ kind: node.isMissing ? "missing" : "error", nodeType: node.type,
        startIndex: node.startIndex, endIndex: node.endIndex });
    }

    if (isCommentNode(node, language)) {
      excluded.add(node.id);
      removedComments++;
    }
    const docstring = docstringStatement(node, language);
    if (docstring) {
      excluded.add(docstring.id);
      removedDocstrings++;
    }

    const children = node.children;
    if (children.length && !protectedLiteralFragment(node, language)
      && !(language === "python" && node.type === "format_specifier")) {
      let position = node.startIndex;
      for (const child of children) {
        checkGap(position, child.startIndex, node.type);
        position = child.endIndex;
      }
      checkGap(position, node.endIndex, node.type);
    }
    // Reverse pushes preserve source order for bounded error evidence.
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }

  if (root.hasError && !issues.some((issue) => issue.kind !== "unsupported-trivia")) {
    report({ kind: "error", nodeType: root.type, startIndex: root.startIndex, endIndex: root.endIndex });
  }
  return { excludedNodeIds: excluded, removedComments, removedDocstrings, issues, hasSyntaxError };
}

type Visit = { kind: "visit"; node: Node };
type Finish = { kind: "finish"; node: Node; children: CanonicalChild[] };

/**
 * Core-only API for a caller-owned live tree. No parsing, source execution, worker,
 * or policy selection. Omission never rewrites/reparses or reclassifies ownership.
 */
export function canonicalizeSyntaxTree(
  root: Node, source: string, language: TscLanguage,
  omittedNodes: ReadonlySet<Node> = new Set(),
): SyntaxCanonicalization {
  const omittedNodeIds = new Set<number>();
  for (const node of omittedNodes) {
    if (node.tree !== root.tree) throw new Error("Cannot omit a node from another tree.");
    if (node.id === root.id) throw new Error("Cannot omit the canonical root.");
    omittedNodeIds.add(node.id);
  }

  const classification = classifySyntaxTree(root, source, language);
  if (classification.hasSyntaxError || classification.issues.length) {
    return { kind: "exact", reason: classification.hasSyntaxError ? "syntax-error" : "unsupported-trivia",
      issues: classification.issues };
  }

  const values = new Map<number, CanonicalSyntax | null>();
  const work: (Visit | Finish)[] = [{ kind: "visit", node: root }];
  while (work.length) {
    const operation = work.pop()!;
    const node = operation.node;
    if (operation.kind === "finish") {
      const edges: CanonicalEdge[] = [];
      for (const child of operation.children) {
        const value: CanonicalSyntax | null | undefined = child.kind === "fragment"
          ? ["fragment", child.name, child.text] : values.get(child.node.id);
        if (value === undefined) throw new Error("Missing canonical child result.");
        if (value !== null) edges.push([child.field, value]);
      }
      values.set(node.id, ["node", node.type, edges]);
      continue;
    }

    if (classification.excludedNodeIds.has(node.id) || omittedNodeIds.has(node.id)) {
      values.set(node.id, null);
      continue;
    }
    if (protectedLiteralFragment(node, language)) {
      values.set(node.id, ["fragment", node.type, node.text]);
      continue;
    }

    const children = literalChildren(node, language, source) ?? syntaxChildren(node);
    if (node.childCount === 0 && node.id !== root.id) {
      values.set(node.id, ["token", node.type, node.text]);
      continue;
    }

    work.push({ kind: "finish", node, children });
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index];
      if (child.kind === "syntax") work.push({ kind: "visit", node: child.node });
    }
  }

  const canonical = values.get(root.id);
  if (!canonical) throw new Error("Canonical traversal did not produce a root.");
  return { kind: "canonical", root: canonical, classification };
}
