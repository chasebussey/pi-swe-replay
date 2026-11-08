import type { Node } from "web-tree-sitter";
import type { TscLanguage } from "./normalization-policy";

/** Explicit grammar kinds, never a generic isExtra check that could erase code. */
export function isCommentNode(node: Node, language: TscLanguage): boolean {
  return node.type === "comment" || language === "typescript"
    && ["hash_bang_line", "html_comment"].includes(node.type);
}

function isDocstringExpression(expression: Node): boolean {
  const pending = [expression];
  while (pending.length) {
    const node = pending.pop()!;
    if (["expression_statement", "parenthesized_expression", "concatenated_string"].includes(node.type)) {
      const children = node.namedChildren.filter((child) => !isCommentNode(child, "python"));
      if (!children.length || node.type !== "concatenated_string" && children.length !== 1) return false;
      for (const child of children) pending.push(child);
      continue;
    }

    if (node.type !== "string") return false;
    const prefix = /^([a-z]*)(?:'|")/i.exec(node.text)?.[1];
    if (prefix === undefined || /[bft]/i.test(prefix)) return false;
  }
  return true;
}

/** Identify ownership on the original tree, not on already filtered siblings. */
export function docstringStatement(body: Node, language: TscLanguage): Node | undefined {
  if (language !== "python") return;
  const eligible = body.type === "module" || body.type === "block"
    && ["function_definition", "class_definition"].includes(body.parent?.type ?? "");
  if (!eligible) return;

  const first = body.namedChildren.find((child) => !isCommentNode(child, language));
  return first?.type === "expression_statement" && isDocstringExpression(first) ? first : undefined;
}
