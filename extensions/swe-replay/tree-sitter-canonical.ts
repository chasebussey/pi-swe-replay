import type { Node } from "web-tree-sitter";
import type { TscLanguage } from "./normalization-policy";
import { docstringStatement, isCommentNode } from "./tree-sitter-documentation";
import { literalChildren, protectedLiteralFragment, syntaxChildren, type CanonicalChild } from "./tree-sitter-literals";
import { checkTscLimit, TscTraversalBudget } from "./tree-sitter-limits";

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
export interface SyntaxClassification {
  excludedNodeIds: ReadonlySet<number>;
  removedComments: number;
  removedDocstrings: number;
  issues: readonly SyntaxIssue[];
  hasSyntaxError: boolean;
}
export type SyntaxCanonicalization =
  | { kind: "canonical"; root: CanonicalSyntax; serializedBytes: number; classification: SyntaxClassification }
  | { kind: "exact"; reason: "syntax-error" | "unsupported-trivia"; issues: readonly SyntaxIssue[] };

const MAX_SOURCE_ISSUES = 8;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Inspect the entire original tree within limits, before documentation filtering. */
export function classifySyntaxTree(
  root: Node, source: string, language: TscLanguage, budget = new TscTraversalBudget(),
): SyntaxClassification {
  checkTscLimit(budget.limits, "maxSourceBytes", Buffer.byteLength(source));
  const issues: SyntaxIssue[] = [];
  let hasSyntaxError = root.hasError;
  const original: Node[] = [];
  const pending = [{ node: root, depth: 1 }];
  const report = (issue: SyntaxIssue) => {
    if (issues.length < MAX_SOURCE_ISSUES) issues.push(issue);
    else if (issue.kind !== "unsupported-trivia" && !issues.some((recorded) => recorded.kind !== "unsupported-trivia")) {
      issues[MAX_SOURCE_ISSUES - 1] = issue;
    }
  };
  const checkGap = (startIndex: number, endIndex: number, nodeType: string) => {
    if (source.slice(startIndex, endIndex).includes("\uFEFF")) {
      report({ kind: "unsupported-trivia", nodeType, startIndex, endIndex });
    }
  };
  checkGap(0, root.startIndex, root.type);
  checkGap(root.endIndex, source.length, root.type);

  while (pending.length) {
    const { node, depth } = pending.pop()!;
    budget.visit(depth);
    budget.children(node.childCount, pending.length);
    original.push(node);
    if (node.isError || node.isMissing) {
      hasSyntaxError = true;
      report({ kind: node.isMissing ? "missing" : "error", nodeType: node.type,
        startIndex: node.startIndex, endIndex: node.endIndex });
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
    for (let index = children.length - 1; index >= 0; index--) pending.push({ node: children[index], depth: depth + 1 });
  }
  if (root.hasError && !issues.some((issue) => issue.kind !== "unsupported-trivia")) {
    report({ kind: "error", nodeType: root.type, startIndex: root.startIndex, endIndex: root.endIndex });
  }

  // Only classify after all nodes/depth have passed the health/resource walk.
  const excluded = new Set<number>();
  let removedComments = 0;
  let removedDocstrings = 0;
  if (!hasSyntaxError && !issues.length) {
    for (const node of original) {
      if (isCommentNode(node, language)) { excluded.add(node.id); removedComments++; }
      const docstring = docstringStatement(node, language);
      if (docstring) { excluded.add(docstring.id); removedDocstrings++; }
    }
  }
  return { excludedNodeIds: excluded, removedComments, removedDocstrings, issues, hasSyntaxError };
}

type Operation = { kind: "visit"; node: Node } | { kind: "finish"; node: Node; children: CanonicalChild[] };
interface SizedSyntax { syntax: CanonicalSyntax; bytes: number }

/** Caller owns the live tree. Omission cannot reparse or change original ownership. */
export function canonicalizeSyntaxTree(
  root: Node, source: string, language: TscLanguage,
  omittedNodes: ReadonlySet<Node> = new Set(), budget = new TscTraversalBudget(),
): SyntaxCanonicalization {
  const omittedNodeIds = new Set<number>();
  for (const node of omittedNodes) {
    if (node.tree !== root.tree) throw new Error("Cannot omit a node from another tree.");
    if (node.id === root.id) throw new Error("Cannot omit the canonical root.");
    omittedNodeIds.add(node.id);
  }

  const classification = classifySyntaxTree(root, source, language, budget);
  if (classification.hasSyntaxError || classification.issues.length) {
    return { kind: "exact", reason: classification.hasSyntaxError ? "syntax-error" : "unsupported-trivia", issues: classification.issues };
  }

  const values = new Map<number, SizedSyntax | null>();
  const work: Operation[] = [{ kind: "visit", node: root }];
  const leaf = (syntax: CanonicalSyntax): SizedSyntax => {
    const bytes = jsonBytes(syntax);
    budget.output(bytes);
    return { syntax, bytes };
  };
  while (work.length) {
    const operation = work.pop()!;
    const node = operation.node;
    if (operation.kind === "finish") {
      const edges: CanonicalEdge[] = [];
      let bytes = jsonBytes(["node", node.type, []]);
      for (const child of operation.children) {
        const value = child.kind === "fragment" ? leaf(["fragment", child.name, child.text]) : values.get(child.node.id);
        if (value === undefined) throw new Error("Missing canonical child result.");
        if (value === null) continue;
        bytes += jsonBytes([child.field, null]) - 4 + value.bytes + (edges.length ? 1 : 0);
        budget.output(bytes);
        edges.push([child.field, value.syntax]);
      }
      budget.output(bytes);
      values.set(node.id, { syntax: ["node", node.type, edges], bytes });
      continue;
    }

    if (classification.excludedNodeIds.has(node.id) || omittedNodeIds.has(node.id)) {
      values.set(node.id, null);
      continue;
    }
    if (protectedLiteralFragment(node, language)) {
      values.set(node.id, leaf(["fragment", node.type, node.text]));
      continue;
    }
    const children = literalChildren(node, language, source) ?? syntaxChildren(node);
    if (node.childCount === 0 && node.id !== root.id) {
      values.set(node.id, leaf(["token", node.type, node.text]));
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
  return { kind: "canonical", root: canonical.syntax, serializedBytes: canonical.bytes, classification };
}
