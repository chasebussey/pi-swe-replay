import type { Node } from "web-tree-sitter";
import type { TscLanguage } from "./normalization-policy";

export type SyntaxChild = { kind: "syntax"; node: Node; field: string | null };
export type FragmentChild = { kind: "fragment"; name: string; text: string; field: null };
export type CanonicalChild = SyntaxChild | FragmentChild;

/** Literal content is indivisible, even if a grammar exposes escape subnodes. */
export function protectedLiteralFragment(node: Node, language: TscLanguage): boolean {
  return language === "python" ? node.type === "string_content"
    : ["string_fragment", "regex_pattern"].includes(node.type);
}

export function syntaxChildren(node: Node): SyntaxChild[] {
  return node.children.map((child, index) => ({
    kind: "syntax", node: child, field: node.fieldNameForChild(index),
  }));
}

/** Format-spec text such as >, widths, and whitespace can live in parser gaps. */
function formatSpecifierChildren(node: Node, source: string): CanonicalChild[] {
  const result: CanonicalChild[] = [];
  let position = node.startIndex;
  for (const child of syntaxChildren(node)) {
    if (position < child.node.startIndex) {
      result.push({ kind: "fragment", name: "format_specifier_text",
        text: source.slice(position, child.node.startIndex), field: null });
    }
    result.push(child);
    position = child.node.endIndex;
  }

  if (position < node.endIndex) {
    result.push({ kind: "fragment", name: "format_specifier_text",
      text: source.slice(position, node.endIndex), field: null });
  }
  return result;
}

function isTemplateInterpolation(node: Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type !== "string") continue;
    const start = parent.children.find((child) => child.type === "string_start");
    return !!start && /^[a-z]*t[a-z]*['"]/i.test(start.text);
  }
  return false;
}

function interpolationChildren(node: Node, source: string): CanonicalChild[] {
  const children = syntaxChildren(node);
  const debug = children.some((child) => child.node.type === "=");
  const template = isTemplateInterpolation(node);
  if (!debug && !template) return children;

  const opening = children[0]?.node;
  const suffix = children.find((child) => ["type_conversion", "format_specifier", "}"].includes(child.node.type))?.node;
  if (opening?.type !== "{" || !suffix) throw new Error("Unsupported Python interpolation shape.");

  // Debug f-strings display this source prefix. Python 3.14 t-strings also retain
  // expression source as observable metadata, even without a debug '=' token.
  const prefix: FragmentChild = {
    kind: "fragment", name: debug ? "python_debug_prefix" : "python_template_expression",
    text: source.slice(opening.endIndex, suffix.startIndex), field: null,
  };
  return [children[0], prefix, ...children.slice(1)];
}

/** Undefined means ordinary syntax traversal; this never prints or trims source. */
export function literalChildren(node: Node, language: TscLanguage, source: string): CanonicalChild[] | undefined {
  if (language !== "python") return undefined;
  if (node.type === "format_specifier") return formatSpecifierChildren(node, source);
  if (["interpolation", "format_expression"].includes(node.type)) return interpolationChildren(node, source);
  return undefined;
}
