import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { before, after } from "node:test";
import { core, sourceCore, policy, createTscParsers, fixtureBytes } from "./helpers/tsc-parsers.mjs";

const { canonicalizeTscSource, tscLanguageForPath } = sourceCore;
const { canonicalizeSyntaxTree } = core;
const corpus = JSON.parse(readFileSync(new URL("./fixtures/tsc/source-pairs.json", import.meta.url), "utf8"));
const contract = JSON.parse(readFileSync(new URL("./fixtures/tsc/contract.json", import.meta.url), "utf8"));
let parsers;
let oldFetch;
before(async () => {
  oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Runtime network forbidden in TSC tests"); };
  parsers = await createTscParsers();
});
after(() => {
  for (const parser of parsers?.values() ?? []) parser.delete();
  globalThis.fetch = oldFetch;
});

function normalize(language, content) {
  const selected = language === "unknown" ? undefined : language;
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return canonicalizeTscSource(parsers.get(selected), selected, bytes);
}
function key(result) {
  assert.equal(result.kind, "canonical", JSON.stringify(result));
  return JSON.stringify(result.source);
}
function pair(language, before, after, equivalent) {
  const a = normalize(language, before);
  const b = normalize(language, after);
  assert.equal(key(a) === key(b), equivalent, `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  return [a, b];
}

// Source-level only. Paired exact comparison here is a harness expectation, not
// the future complete-tree adapter, worker batch API, or helper extraction.
for (const item of corpus) {
  test(`canonical corpus: ${item.id}`, () => {
    const before = fixtureBytes(item.before);
    const after = fixtureBytes(item.after);
    const a = normalize(item.language, before);
    const b = normalize(item.language, after);
    if (item.expected === "fallback-required") {
      assert.ok(a.kind === "exact" || b.kind === "exact", item.id);
      assert.notDeepEqual(before, after);
      assert.deepEqual(normalize(item.language, before), a, "fallback repeat evidence");
      assert.deepEqual(normalize(item.language, after), b, "fallback reverse-side evidence");
      return;
    }
    assert.equal(key(a) === key(b), item.expected === "equivalent", item.rationale);
    assert.equal(key(normalize(item.language, before)), key(a), "repeat must recompute the same frame");
    assert.equal(key(normalize(item.language, after)), key(b), "reverse-side normalization must be stable");
  });
}

test("core framing retains containers, fields and anonymous operator terminals", () => {
  const assignment = ["node", "assignment", [
    ["left", ["token", "identifier", "x"]],
    [null, ["token", "=", "="]],
    ["right", ["token", "integer", "1"]],
  ]];
  const expression = ["node", "expression_statement", [[null, assignment]]];
  assert.deepEqual(normalize("python", "x = 1\n").source,
    ["source", "utf8", ["node", "module", [[null, expression]]]]);
  assert.deepEqual(normalize("python", "").source, ["source", "utf8", ["node", "module", []]]);
  assert.deepEqual(normalize("typescript", "// only comment\n").source, ["source", "utf8", ["node", "program", []]]);
});

test("shared registry pins match the P0 contract without enabling persisted TSC compatibility", () => {
  assert.equal(policy.TSC_CANONICALIZATION_POLICY, contract.identity.canonicalization);
  assert.equal(policy.TSC_REGISTRY_POLICY, contract.identity.registry);
  for (const pin of [policy.TSC_RUNTIME_ASSET, ...policy.TSC_LANGUAGES]) {
    const fixture = contract.dependencies.find((entry) => entry.package === pin.package);
    for (const field of ["version", "asset", "sha256"]) assert.equal(pin[field], fixture[field], `${pin.package}:${field}`);
    assert.ok(Object.isFrozen(pin));
  }
  assert.equal(policy.isSupportedNormalizationProvenance({ policy: contract.identity.policy }), false);
});

test("registry uses case-sensitive byte suffixes including declaration files and undecodable paths", () => {
  for (const [name, expected] of [["x.py", "python"], ["x.ts", "typescript"], ["x.d.ts", "typescript"],
    ["x.pyi", undefined], ["x.mts", undefined], ["x.cts", undefined], ["x.tsx", undefined],
    ["x.js", undefined], ["x.PY", undefined], ["x.TS", undefined]]) {
    assert.equal(tscLanguageForPath(Buffer.from(name)), expected, name);
  }
  assert.equal(tscLanguageForPath(Buffer.from([0xff, 0x2e, 0x70, 0x79])), "python");
  const storage = Buffer.from("--x.py--");
  assert.equal(tscLanguageForPath(storage.subarray(2, -2)), "python");
});

test("comment adapters include TypeScript hashbang/HTML comment kinds without removing string text", () => {
  pair("typescript", "#!/usr/bin/env node\nconst x = 1;\n", "const x = 1;\n", true);
  pair("typescript", "<!-- explanation\nconst x = 1;\n", "const x = 1;\n", true);
  pair("typescript", 'const x = "<!-- explanation";\n', 'const x = "<!-- changed";\n', false);
});

test("docstring recognition respects original ownership and preserves ordinary strings", () => {
  pair("python", 'def f():\n    ("docs " # note\n     "A")\n    "ordinary"\n',
    'def f():\n    r"docs B"\n    "ordinary"\n', true);
  pair("python", 'class A:\n    "docs"\n    "ordinary A"\n', 'class A:\n    "docs"\n    "ordinary B"\n', false);
  pair("python", 'def f():\n    B"A"\n', 'def f():\n    B"B"\n', false);
  pair("python", 'def f():\n    T"A{x}"\n', 'def f():\n    T"B{x}"\n', false);

  const source = 'def helper():\n    "helper docs"\n    return 1\n"ordinary"\nx = 1\n';
  const tree = parsers.get("python").parse(source);
  try {
    const omitted = new Set([tree.rootNode.namedChildren[0]]);
    const result = canonicalizeSyntaxTree(tree.rootNode, source, "python", omitted);
    assert.equal(result.kind, "canonical");
    assert.equal(result.classification.removedDocstrings, 1);
    assert.match(JSON.stringify(result.root), /ordinary/);
    assert.doesNotMatch(JSON.stringify(result.root), /helper/);
    const reparsed = normalize("python", '"ordinary"\nx = 1\n');
    assert.notDeepEqual(result.root, reparsed.source[2], "subtraction must not promote ordinary text to module documentation");
  } finally {
    tree.delete();
  }
});

test("f-string expressions normalize trivia but debug display prefixes remain exact", () => {
  pair("python", `x = f'{ value + 1!r }'\n`, `x=f'{value+1!r}'\n`, true);
  pair("python", 'x = f"{(value # note\n)}"\n', 'x = f"{(value)}"\n', true);
  pair("python", `x = f'{value = }'\n`, `x = f'{value=}'\n`, false);
  pair("python", `x = f'{value + 1=}'\n`, `x = f'{value+1=}'\n`, false);
  pair("python", `x = f'{value = !r}'\n`, `x = f'{value =!r}'\n`, false);
  pair("python", `x = f'{value!s}'\n`, `x = f'{value!r}'\n`, false);
});

test("format-spec gaps, dynamic widths and nested literals keep their distinct responsibilities", () => {
  pair("python", `x = f'{value:>{width + 1}}'\n`, `x = f'{value:>{width+1}}'\n`, true);
  pair("python", `x = f'{value:>{width}}'\n`, `x = f'{value:<{width}}'\n`, false);
  pair("python", `x = f'{value: >10}'\n`, `x = f'{value:>10}'\n`, false);
  pair("python", `x = f'{value:.2f}'\n`, `x = f'{value:.3f}'\n`, false);
  pair("python", `x = f'{"a  " + value}'\n`, `x = f'{"a " + value}'\n`, false);
  pair("python", `x = f"outer {f'inner {value + 1}'}"\n`, `x = f"outer {f'inner {value+1}'}"\n`, true);
  pair("python", `x = f'{{value}} {value}'\n`, `x = f'value {value}'\n`, false);
  pair("python", `name = '😀'; x = f'{value:😀>{width + 1}}'\n`, `name = '😀'; x = f'{value:😀>{width+1}}'\n`, true);
});

test("Python template strings retain observable interpolation source metadata", () => {
  pair("python", `x = t'{value + 1}'\n`, `x = t'{value+1}'\n`, false);
  pair("python", `x = t'{value}'\n`, `x=t'{value}'\n`, true);
  pair("python", `x = t'{ value }'\n`, `x = t'{value}'\n`, false);
});

test("TypeScript templates preserve tagged raw text, nested fragments, escapes and operator changes", () => {
  pair("typescript", 'const x=tag`a ${value /*note*/ + 1} z`;\n', 'const x = tag`a ${value+1} z`;\n', true);
  pair("typescript", 'const x = `outer ${`inner ${value + 1}`}`;\n', 'const x=`outer ${`inner ${value+1}`}`;\n', true);
  pair("typescript", 'const x = tag`\\n${value}`;\n', 'const x = tag`\n${value}`;\n', false);
  pair("typescript", 'const x = tag`a  \n${value}`;\n', 'const x = tag`a \n${value}`;\n', false);
  pair("typescript", 'const x = `\\${value}`;\n', 'const x = `${value}`;\n', false);
  pair("typescript", 'const x = /a\\/\\/b/g;\n', 'const x = /a\\/\\/b/i;\n', false);
  pair("typescript", 'const x = "a\\\n  b";\n', 'const x = "a\\\n b";\n', false);
});

test("BOM and Unicode handling preserves marker identity without corrupting source offsets", () => {
  pair("python", "\uFEFFcafé = '😀'\nx = café + 'é'\n", "\uFEFFcafé='😀'\nx=café+'é'\n", true);
  pair("typescript", "\uFEFFconst café = `😀 ${value + 1}`;\n", "\uFEFFconst café=`😀 ${value+1}`;\n", true);
  pair("python", "x = '\uFEFF'\n", "x = ''\n", false);
  pair("typescript", "const x = `\uFEFF`;\n", "const x = ``;\n", false);
  for (const language of ["python", "typescript"]) {
    assert.equal(normalize(language, "\uFEFF\uFEFFx = 1\n").kind, "exact");
    const result = normalize(language, "x\uFEFF = 1\n");
    assert.equal(result.kind, "exact");
    assert.ok(["syntax-error", "unsupported-trivia"].includes(result.reason));
  }
});

test("syntax errors and MISSING recovery are checked before omission, with bounded diagnostics", () => {
  const source = "def f(:\n    return 1\n";
  const result = normalize("python", source);
  assert.equal(result.kind, "exact");
  assert.equal(result.reason, "syntax-error");
  assert.ok(result.issues.some((issue) => issue.kind === "missing"));
  const tree = parsers.get("python").parse(source);
  try {
    const omitted = new Set(tree.rootNode.children);
    assert.equal(canonicalizeSyntaxTree(tree.rootNode, source, "python", omitted).kind, "exact");
    assert.throws(() => canonicalizeSyntaxTree(tree.rootNode, source, "python", new Set([tree.rootNode])), /Cannot omit/);
    const foreign = parsers.get("python").parse("x=1");
    try {
      assert.throws(() => canonicalizeSyntaxTree(tree.rootNode, source, "python", new Set([foreign.rootNode])), /another tree/);
    } finally {
      foreign.delete();
    }
  } finally {
    tree.delete();
  }
  const many = normalize("typescript", Array.from({ length: 30 }, () => "function f( {\n").join(""));
  assert.equal(many.kind, "exact");
  assert.ok(many.issues.length > 0 && many.issues.length <= 8);
});

test("bounded trivia evidence never hides the fatal source-error classification", () => {
  const source = Array.from({ length: 20 }, (_, index) => `const x${index}\uFEFF = ${index};\n`).join("") + "function broken( {\n";
  const result = normalize("typescript", source);
  assert.equal(result.kind, "exact");
  assert.equal(result.reason, "syntax-error");
  assert.ok(result.issues.length <= 8);
  assert.ok(result.issues.some((issue) => issue.kind === "error" || issue.kind === "missing"));
});

test("source guards do not parse unsupported, invalid UTF-8 or NUL data", () => {
  const parser = { parse() { throw new Error("must not parse"); } };
  for (const [language, bytes, reason] of [[undefined, Buffer.from("x"), "unsupported-language"],
    ["python", Buffer.from([0xff]), "invalid-utf8"], ["typescript", Buffer.from([0]), "nul-binary"]]) {
    assert.equal(canonicalizeTscSource(parser, language, bytes).reason, reason);
  }
});

test("infrastructure exceptions propagate and parser trees are released on all paths", () => {
  assert.throws(() => canonicalizeTscSource(undefined, "python", Buffer.from("x=1")), /configured parser/);
  assert.throws(() => canonicalizeTscSource({ parse() { throw new Error("parser failed"); } }, "python", Buffer.from("x=1")), /parser failed/);
  assert.throws(() => canonicalizeTscSource({ parse() { return null; } }, "python", Buffer.from("x=1")), /did not return/);

  let deleted = 0;
  for (const source of ["x=1", "def f(:\n pass\n"]) {
    const owned = parsers.get("python").parse(source);
    const parser = { parse() { return { rootNode: owned.rootNode, delete() { owned.delete(); deleted++; } }; } };
    canonicalizeTscSource(parser, "python", Buffer.from(source));
  }
  const owned = parsers.get("python").parse("x=1");
  const parser = { parse() { return { get rootNode() { throw new Error("tree failed"); }, delete() { owned.delete(); deleted++; } }; } };
  assert.throws(() => canonicalizeTscSource(parser, "python", Buffer.from("x=1")), /tree failed/);
  assert.equal(deleted, 3);
});

test("prepared triples and fresh parser instances retain deterministic equality", async () => {
  for (const [language, ids] of [["python", ["py-formatting", "py-documentation-removal", "py-equivalent-triple"]],
    ["typescript", ["ts-formatting", "ts-documentation", "ts-equivalent-triple"]]]) {
    for (const id of ids) {
      const item = corpus.find((entry) => entry.id === `original:${id}`);
      pair(language, fixtureBytes(item.before), fixtureBytes(item.after), true);
    }
  }
  const fresh = await createTscParsers();
  try {
    for (const language of ["python", "typescript"]) {
      const source = Buffer.from(language === "python" ? "x = f'{value + 1}'\n" : "const x = `${value + 1}`;\n");
      assert.equal(key(canonicalizeTscSource(fresh.get(language), language, source)), key(normalize(language, source)));
    }
  } finally {
    for (const parser of fresh.values()) parser.delete();
  }
});
