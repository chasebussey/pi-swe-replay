import type { TscLanguage } from "./normalization-policy";
import type { CanonicalEdge, CanonicalSyntax } from "./tree-sitter-canonical";
import type { CanonicalSource } from "./tree-sitter-source";

export type AddedHelper = readonly [name: string, declaration: CanonicalSyntax];
export type CanonicalFileContent = readonly [
  "canonical", baseline: CanonicalSource, residual: CanonicalSource, helpers: readonly AddedHelper[],
];

interface Declaration {
  name: string;
  extractable: boolean;
}
interface DeclarationInventory {
  names: ReadonlySet<string>;
  declarations: ReadonlyMap<number, Declaration>;
  duplicateNames: boolean;
}

function edges(node: CanonicalSyntax): readonly CanonicalEdge[] {
  return node[0] === "node" ? node[2] : [];
}

function field(node: CanonicalSyntax, name: string): CanonicalSyntax | undefined {
  return edges(node).find(([label]) => label === name)?.[1];
}

/** Only unwrap known top-level declaration wrappers; never search nested scopes. */
function declaration(node: CanonicalSyntax, language: TscLanguage): Declaration | undefined {
  let definition = node;
  let supportedWrapper = true;
  if (language === "python" && node[1] === "decorated_definition") {
    const wrapped = field(node, "definition");
    if (!wrapped) return undefined;
    definition = wrapped;
  }
  if (language === "typescript") {
    if (definition[1] === "export_statement") {
      supportedWrapper = !edges(definition).some(([, child]) => child[0] === "token" && child[1] === "default");
      const wrapped = field(definition, "declaration") ?? field(definition, "value");
      if (!wrapped) return undefined;
      definition = wrapped;
    }
    if (definition[1] === "ambient_declaration") {
      supportedWrapper = false;
      const wrapped = edges(definition).find(([, child]) => child[0] === "node")?.[1];
      if (!wrapped) return undefined;
      definition = wrapped;
    }
  }

  const functionTypes = language === "python" ? ["function_definition"]
    : ["function_declaration", "generator_function_declaration", "function_signature", "function_expression", "generator_function"];
  if (!functionTypes.includes(definition[1])) return undefined;
  const name = field(definition, "name");
  if (!name || name[0] !== "token" || name[1] !== "identifier") return undefined;

  const concreteType = language === "python" ? definition[1] === "function_definition"
    : definition[1] === "function_declaration" || definition[1] === "generator_function_declaration";
  return { name: name[2], extractable: supportedWrapper && concreteType && field(definition, "body") !== undefined };
}

function inventory(root: CanonicalSyntax, language: TscLanguage): DeclarationInventory {
  const names = new Set<string>();
  const declarations = new Map<number, Declaration>();
  let duplicateNames = false;
  edges(root).forEach(([, node], index) => {
    const found = declaration(node, language);
    if (!found) return;
    if (names.has(found.name)) duplicateNames = true;
    names.add(found.name);
    declarations.set(index, found);
  });
  return { names, declarations, duplicateNames };
}

/**
 * Pure P3 projection of trusted canonical sources from the original parsed trees.
 * Documentation ownership and syntax health MUST already have been classified by
 * the source adapter. Subtract canonical declaration subtrees, not rewritten source:
 * strings exposed at the start of the residual can never become new docstrings.
 * Paired exact fallback, path/metadata identity and bounded worker IPC belong to
 * the complete-tree adapter; this function neither parses nor supplies patch text.
 */
export function tscHelperResidual(
  language: TscLanguage, baseline: CanonicalSource, candidate: CanonicalSource,
): CanonicalFileContent {
  const rootType = language === "python" ? "module" : "program";
  for (const source of [baseline, candidate]) {
    if (source[2][0] !== "node" || source[2][1] !== rootType) {
      throw new Error("TSC helper source root does not match the declared language.");
    }
  }
  const before = inventory(baseline[2], language);
  const after = inventory(candidate[2], language);
  const guarded = before.duplicateNames || after.duplicateNames;
  const residualEdges: CanonicalEdge[] = [];
  const additions: { helper: AddedHelper; sortKey: Buffer }[] = [];
  for (const [index, edge] of edges(candidate[2]).entries()) {
    const found = after.declarations.get(index);
    if (!guarded && found?.extractable && !before.names.has(found.name)) {
      const helper: AddedHelper = [found.name, edge[1]];
      additions.push({ helper, sortKey: Buffer.from(JSON.stringify(helper), "utf8") });
    } else {
      residualEdges.push(edge);
    }
  }

  additions.sort((a, b) => Buffer.compare(a.sortKey, b.sortKey));
  const residual: CanonicalSource = ["source", candidate[1], ["node", rootType, residualEdges]];
  return ["canonical", baseline, residual, additions.map(({ helper }) => helper)];
}
