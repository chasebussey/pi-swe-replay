import { TextDecoder } from "node:util";
import type { Parser } from "web-tree-sitter";
import { TSC_LANGUAGES, type TscLanguage } from "./normalization-policy";
import { canonicalizeSyntaxTree, type CanonicalSyntax, type SyntaxIssue } from "./tree-sitter-canonical";
import { checkTscLimit, TscTraversalBudget } from "./tree-sitter-limits";

export type CanonicalSource = readonly ["source", "utf8" | "utf8-bom", CanonicalSyntax];
export type SourceFallbackReason = "unsupported-language" | "invalid-utf8" | "nul-binary"
  | "syntax-error" | "unsupported-trivia";
export type SourceCanonicalization =
  | { kind: "canonical"; source: CanonicalSource; serializedBytes: number; removedComments: number; removedDocstrings: number }
  | { kind: "exact"; reason: SourceFallbackReason; issues: readonly SyntaxIssue[] };

/** Match raw suffix bytes, never decode or rewrite paths used for identity. */
export function tscLanguageForPath(path: Uint8Array): TscLanguage | undefined {
  for (const entry of TSC_LANGUAGES) {
    const suffix = Buffer.from(entry.extension, "ascii");
    if (path.length < suffix.length) continue;
    const ending = Buffer.from(path.buffer, path.byteOffset + path.length - suffix.length, suffix.length);
    if (ending.equals(suffix)) return entry.language;
  }
  return undefined;
}

/**
 * P1 source adapter for an already configured, caller-owned parser. P2 must own
 * offline asset loading, bounded worker execution and batch failure/cleanup.
 * Exact results are instructions to retain original bytes, not replacement text.
 */
export function canonicalizeTscSource(
  parser: Pick<Parser, "parse"> | undefined, language: TscLanguage | undefined, bytes: Uint8Array,
  budget = new TscTraversalBudget(),
): SourceCanonicalization {
  checkTscLimit(budget.limits, "maxSourceBytes", bytes.byteLength);
  const grammar = TSC_LANGUAGES.find((entry) => entry.language === language);
  if (!grammar) return { kind: "exact", reason: "unsupported-language", issues: [] };
  if (bytes.includes(0)) return { kind: "exact", reason: "nul-binary", issues: [] };

  let source: string;
  try {
    // ignoreBOM=true means retain the marker as a source character during decoding.
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError && "code" in error && error.code === "ERR_ENCODING_INVALID_ENCODED_DATA") {
      return { kind: "exact", reason: "invalid-utf8", issues: [] };
    }
    throw error;
  }
  const encoding = source.startsWith("\uFEFF") ? "utf8-bom" : "utf8";
  if (encoding === "utf8-bom") source = source.slice(1);

  if (!parser) throw new Error("TSC source normalization requires a configured parser.");
  const tree = parser.parse(source);
  if (!tree) throw new Error("Tree-sitter did not return a parse tree.");
  try {
    const root = tree.rootNode;
    const result = canonicalizeSyntaxTree(root, source, grammar.language, new Set(), budget);
    if (result.kind === "exact") return result;
    // Malformed input can have an ERROR root; only a successful parse must match.
    if (root.type !== grammar.rootType) throw new Error("TSC parser root does not match the declared language.");
    const serializedBytes = Buffer.byteLength(JSON.stringify(["source", encoding, null])) - 4 + result.serializedBytes;
    budget.output(serializedBytes);
    return { kind: "canonical", source: ["source", encoding, result.root], serializedBytes,
      removedComments: result.classification.removedComments,
      removedDocstrings: result.classification.removedDocstrings };
  } finally {
    tree.delete();
  }
}
