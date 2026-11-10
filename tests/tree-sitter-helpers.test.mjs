import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { before, after } from "node:test";
import { createJiti } from "jiti";
import { sourceCore, createTscParsers, fixtureBytes } from "./helpers/tsc-parsers.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { tscHelperResidual } = await jiti.import("../extensions/swe-replay/tree-sitter-helpers.ts");
const corpus = JSON.parse(readFileSync(new URL("./fixtures/tsc/helper-pairs.json", import.meta.url), "utf8"));
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

function source(language, content) {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  const result = sourceCore.canonicalizeTscSource(parsers.get(language), language, bytes);
  assert.equal(result.kind, "canonical", JSON.stringify(result));
  return result.source;
}
function frame(language, baseline, candidate) {
  return tscHelperResidual(language, source(language, baseline), source(language, candidate));
}
function compare(language, baseline, a, b, equivalent, helpers) {
  const first = frame(language, baseline, a);
  const second = frame(language, baseline, b);
  assert.equal(JSON.stringify(first) === JSON.stringify(second), equivalent);
  if (helpers !== undefined) assert.equal(first[3].length, helpers);
  return first;
}

for (const item of corpus) {
  test(`helper corpus: ${item.id}${item.acceptedOrderingRisk ? " (accepted ordering risk, not semantic safety)" : ""}`, () => {
    const baseline = fixtureBytes(item.baseline);
    const a = fixtureBytes(item.candidateA);
    const b = fixtureBytes(item.candidateB);
    const first = compare(item.language, baseline, a, b, item.expected === "equivalent");
    assert.deepEqual(frame(item.language, baseline, a), first, "repeat with freshly parsed sources");
    const reverse = frame(item.language, baseline, b);
    assert.equal(JSON.stringify(reverse) === JSON.stringify(first), item.expected === "equivalent", item.rationale);
  });
}

test("empty helper collections use the same baseline-relative frame and retain existing function edits/order", () => {
  const baseline = "def f():\n return 1\ndef g():\n return 2\n";
  const result = compare("python", baseline, baseline, baseline, true, 0);
  assert.deepEqual(result, ["canonical", source("python", baseline), source("python", baseline), []]);
  compare("python", baseline, "def f():\n return 3\ndef g():\n return 2\n", "def g():\n return 2\ndef f():\n return 3\n", false, 0);
  assert.notDeepEqual(frame("python", "x=1", "x=2"), frame("python", "x=0", "x=2"), "baseline participates in the frame");
});

test("duplicate guards inspect both sources, including no-body and unsupported wrappers", () => {
  for (const baseline of ["function f(x:number):number;\nfunction f(x:any){return x;}\n",
    "export default function f(){}\nfunction f(){}\n",
    "declare function f():void;\nexport function f(){}\n"]) {
    const result = compare("typescript", baseline, `function h(){}\n${baseline}`, `${baseline}function h(){}\n`, false, 0);
    assert.deepEqual(result[2], source("typescript", `function h(){}\n${baseline}`));
  }
  compare("typescript", "", "function f(x:number):number;\nfunction f(x:any){return x;}\nfunction h(){}\n",
    "function h(){}\nfunction f(x:number):number;\nfunction f(x:any){return x;}\n", false, 0);
  compare("python", "def f():\n pass\ndef f():\n pass\n", "def h():\n pass\nx=1", "x=1\ndef h():\n pass\n", false, 0);
});

test("unsupported top-level forms stay residual without disabling independent supported helpers", () => {
  for (const unsupported of ["export default function f(){}\n", "declare function f():void;\n",
    "export declare function f():void;\n", "function f():void;\n", "const f=()=>1;\n",
    "class C { f(){} }\n", "namespace N { export function f(){} }\n"]) {
    const baseline = "const x=1;\n";
    const h = "function h(){}\n";
    const result = compare("typescript", baseline, `${h}${unsupported}${baseline}`, `${unsupported}${baseline}${h}`, true, 1);
    assert.deepEqual(result[2], source("typescript", unsupported + baseline));
  }
  compare("typescript", "", "export default function f(){}\nconst x=1;", "const x=1;\nexport default function f(){}", false, 0);
  const nested = "def outer():\n def inner():\n  return 1\n return inner()\n";
  compare("python", nested, `def h():\n pass\n${nested}`, `${nested}def h():\n pass\n`, true, 1);
});

test("baseline names reserved by unsupported forms cannot be extracted as new helpers", () => {
  for (const baseline of ["declare function f():void;\n", "export default function f(){}\n", "function f():void;\n",
    "export declare function f():void;\n"]) {
    compare("typescript", baseline, "function f(){}\nconst x=1;", "const x=1;\nfunction f(){}", false, 0);
  }
});

test("full declaration identity preserves decorators, exports, async, generators, types and signatures", () => {
  const python = "@deco\nasync def hé(x: int = 1):\n yield x\n";
  const typescript = "export async function* hé(x:number=1):Generator<number>{yield x;}\n";
  for (const [language, helper, variants] of [
    ["python", python, [python.replace("@deco", "@other"), python.replace("async ", ""), python.replace("yield", "return"), python.replace("int", "str"), python.replace("= 1", "= 2")]],
    ["typescript", typescript, [typescript.replace("export ", ""), typescript.replace("async ", ""), typescript.replace("function*", "function"), typescript.replace("x:number", "x:string"), typescript.replace("=1", "=2")]],
  ]) {
    const baseline = language === "python" ? "x=0\n" : "const x=0;\n";
    compare(language, baseline, helper + baseline, baseline + helper, true, 1);
    for (const other of variants) compare(language, baseline, helper + baseline, other + baseline, false, 1);
  }
});

test("subtraction preserves original docstring ownership and never promotes exposed strings", () => {
  const helper = 'def h():\n "helper docs"\n return 1\n';
  const original = helper + '"ordinary"\nx=1\n';
  const result = frame("python", "x=1\n", original);
  assert.equal(result[3].length, 1);
  assert.match(JSON.stringify(result[2]), /ordinary/);
  assert.doesNotMatch(JSON.stringify(result[3]), /helper docs/);
  assert.notDeepEqual(result[2], source("python", '"ordinary"\nx=1\n'), "reparse would incorrectly erase the exposed string");
  compare("python", "x=1\n", original, '"ordinary"\nx=1\n' + helper, false, 1);
  compare("python", '"module docs"\nx=1\n', '"changed docs"\n' + original,
    '"other docs"\n"ordinary"\nx=1\n' + helper, true, 1);
});

test("Unicode helper collections sort by UTF-8 tuple bytes, preserve EOF and encoding markers", () => {
  const a = "def é():\n return 1\n";
  const b = "def α():\n return 2\n";
  const c = "def z():\n return 3\n";
  const d = "def Ａ():\n return 4\n";
  const e = "def 𝒜():\n return 5\n";
  const baseline = "x=0\n";
  const candidates = [a + b + baseline + c + d + e, e + c + baseline + b + d + a, d + b + a + e + c + baseline];
  const frames = candidates.map((candidate) => frame("python", baseline, candidate));
  assert.deepEqual(frames[0], frames[1]);
  assert.deepEqual(frames[1], frames[2]);
  assert.deepEqual(frames[0][3].map(([name]) => name), ["z", "é", "α", "Ａ", "𝒜"], "UTF-8 byte order, not UTF-16 string order");
  compare("python", baseline, a + baseline, baseline + a.trimEnd(), true, 1);
  compare("python", baseline, a + baseline, "\uFEFF" + baseline + a, false, 1);
});

test("TypeScript helper-order triples retain identical residual edits and ordered existing code", () => {
  const baseline = "function existing(){return 1;}\nconst x=0;\n";
  const changed = "function existing(){return 2;}\nconst x=1;\n";
  const a = "export function a(){return 3;}\n";
  const b = "async function b(){return 4;}\n";
  const variants = [a + b + changed, b + changed + a, changed + a + b];
  const frames = variants.map((candidate) => frame("typescript", baseline, candidate));
  assert.deepEqual(frames[0], frames[1]);
  assert.deepEqual(frames[1], frames[2]);
  assert.deepEqual(frames[0][2], source("typescript", changed));
  compare("typescript", baseline, a + changed, a + "const x=1;\nfunction existing(){return 2;}\n", false, 1);
});

test("helper projection does not mutate original canonical trees and rejects mismatched roots", () => {
  const baseline = source("python", "x=1\n");
  const candidate = source("python", "def h():\n pass\nx=1\n");
  const saved = JSON.stringify([baseline, candidate]);
  const freeze = (value) => { if (Array.isArray(value)) { value.forEach(freeze); Object.freeze(value); } };
  freeze(baseline);
  freeze(candidate);
  const first = tscHelperResidual("python", baseline, candidate);
  assert.equal(JSON.stringify([baseline, candidate]), saved);
  assert.deepEqual(tscHelperResidual("python", baseline, candidate), first);
  assert.throws(() => tscHelperResidual("typescript", baseline, candidate), /declared language/);
});
