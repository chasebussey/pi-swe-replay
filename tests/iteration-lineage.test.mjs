import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { buildIterationLineage, lineageAncestors } = await jiti.import("../extensions/swe-replay/ui/iteration-lineage.ts");
const { layoutSearchShape, renderSearchShape } = await jiti.import("../extensions/swe-replay/ui/search-shape.ts");
const row = (iteration, approach = "explore", sourceIteration) => ({ iteration, approach, sourceIteration, completed: false });
const forest = () => [row(1), row(2), row(3, "exploit", 1), row(4, "exploit", 1), row(5, "exploit", 2), row(6, "exploit", 4)];
const plain = (_tone, text) => text;
const paint = (shape, lineage, highlight = {}) => renderSearchShape(shape, lineage, { pulse: false, ...highlight }, plain);

function assertBounded(shape) {
  for (const node of shape.nodes) {
    assert.ok(node.x >= 0 && node.x < shape.width);
    assert.ok(node.y >= 0 && node.y < shape.height);
  }
  for (const { parent, child } of shape.edges) {
    assert.equal(child.y - parent.y, 3);
  }
}

test("iteration tree follows generating provenance, with exploration and fallback at the replay root", () => {
  const lineage = buildIterationLineage([...forest(), row(7, "fallback", 4)]);
  assert.deepEqual(lineage.rows.map(({ node }) => node.iteration), [1, 3, 4, 6, 2, 5, 7]);
  assert.deepEqual(lineage.roots[0].children.map((node) => node.iteration), [1, 2, 7]);
  assert.deepEqual(lineage.rows.map(({ prefix }) => prefix), ["├─ ", "│  ├─ ", "│  └─ ", "│     └─ ", "├─ ", "│  └─ ", "└─ "]);
  assert.deepEqual([...lineageAncestors(lineage, 6)], [6, 4, 1, 0]);
  assert.equal(lineage.byIteration.get(7).parentIteration, 0);
});

test("missing, self, and future exploitation origins stay disconnected, never inferred as exploration", () => {
  const lineage = buildIterationLineage([row(1), row(2, "exploit"), row(3, "exploit", 99),
    row(4, "exploit", 4), row(5, "exploit", 6), row(6, "exploit", 2)]);
  assert.deepEqual(lineage.roots.map((node) => node.iteration), [0, 2, 3, 4, 5]);
  assert.deepEqual(lineage.roots[0].children.map((node) => node.iteration), [1]);
  assert.deepEqual([...lineageAncestors(lineage, 6)], [6, 2]);
  for (const id of [2, 3, 4, 5]) assert.equal(lineage.rows.find(({ node }) => node.iteration === id).prefix, "?─ ");
  const shape = layoutSearchShape(lineage, 61, 13);
  assert.equal(shape.coveringNode.get(2).unknownOrigin, true);
  assert.ok(!shape.edges.some(({ parent, child }) => parent.iteration === 0 && child.iteration === 2));
  assert.ok(paint(shape, lineage).join("\n").includes("?"));
});

test("lineage ordering is deterministic, ignores invalid IDs, and deduplicates repeated iteration observations", () => {
  const input = [row(3, "exploit", 1), row(1), row(2), row(3, "explore"), row(0), row(-1), row(1.5)];
  const lineage = buildIterationLineage(input);
  assert.deepEqual(lineage.rows.map(({ node }) => node.iteration), [1, 3, 2]);
  assert.equal(lineage.byIteration.get(3).parentIteration, 1);
  const settled = buildIterationLineage(input.map((value) => ({ ...value, completed: true, regression: "failed" })));
  assert.equal(lineage.signature, settled.signature);
});

test("vertical silhouette draws root, downward forks, and unlabeled iteration nodes", () => {
  const lineage = buildIterationLineage([row(1), row(2)]);
  const shape = layoutSearchShape(lineage, 13, 4);
  assert.equal(shape.bundled, false);
  assert.deepEqual(paint(shape, lineage), [
    "      ◆      ",
    "      │      ",
    " ┌────┴────┐ ",
    " ●         ● ",
  ]);
  assertBounded(shape);
});

test("empty and zero-size graphs fit without fabricating iterations", () => {
  const lineage = buildIterationLineage([]);
  assert.equal(lineage.rows.length, 0);
  assert.deepEqual(paint(layoutSearchShape(lineage, 0, 12), lineage), []);
  assert.deepEqual(paint(layoutSearchShape(lineage, 12, 0), lineage), []);
  const shape = layoutSearchShape(lineage, 7, 4);
  assert.equal(shape.nodes.length, 1);
  assert.equal(shape.nodes[0].kind, "root");
  assert.match(paint(shape, lineage)[0], /◆/);
});

test("dense sibling forests are bundled into a bounded canvas without losing coverage", () => {
  const lineage = buildIterationLineage(Array.from({ length: 10000 }, (_, index) => row(index + 1)));
  const shape = layoutSearchShape(lineage, 61, 16);
  assert.equal(shape.bundled, true);
  assert.equal(shape.coveringNode.size, 10001);
  assert.equal(shape.nodes.length, 17); // Root, 15 distinct children, one sibling bundle.
  assert.equal(shape.coveringNode.get(10000).kind, "bundle");
  assertBounded(shape);
  const lines = paint(shape, lineage, { selectedIteration: 10000, activeIteration: 10000 });
  assert.equal(lines.length, 16);
  assert.ok(lines.every((line) => visibleWidth(line) === 61));
  assert.match(lines.join("\n"), /▓/);
});

test("deep lineages avoid full-tree recursion and keep a bounded indentation and silhouette", () => {
  const lineage = buildIterationLineage(Array.from({ length: 10000 }, (_, index) => index === 0 ? row(1) : row(index + 1, "exploit", index)));
  assert.equal(lineage.rows.at(-1).depth, 10000);
  assert.ok(lineage.rows.every(({ prefix }) => prefix.length < 25));
  const shape = layoutSearchShape(lineage, 41, 13);
  assert.equal(shape.bundled, true);
  assert.equal(shape.coveringNode.size, 10001);
  assert.equal(shape.nodes.length, 5); // Root, three visible iterations, one depth bundle.
  assertBounded(shape);
  assert.ok(paint(shape, lineage).every((line) => visibleWidth(line) === 41));
});

test("all graph sizes stay bounded and every iteration belongs to exactly one visible node or bundle", () => {
  const lineage = buildIterationLineage(forest());
  for (const width of [1, 2, 4, 13, 32, 70]) {
    for (const height of [1, 2, 3, 4, 7, 10, 20]) {
      const shape = layoutSearchShape(lineage, width, height);
      assertBounded(shape);
      const members = shape.nodes.flatMap((node) => node.members);
      assert.equal(new Set(members).size, members.length);
      assert.equal(members.length, lineage.byIteration.size);
      assert.equal(paint(shape, lineage).length, height);
      assert.ok(paint(shape, lineage).every((line) => visibleWidth(line) === width));
    }
  }
});

test("selection, pulse, and captured winner highlighting do not mutate geometry or sample randomness", (t) => {
  t.mock.method(Math, "random", () => { throw new Error("must not sample"); });
  const lineage = buildIterationLineage(forest());
  const shape = layoutSearchShape(lineage, 41, 13);
  const before = structuredClone(shape);
  const first = paint(shape, lineage, { selectedIteration: 6, activeIteration: 6, pulse: true });
  const second = paint(shape, lineage, { selectedIteration: 2, activeIteration: 6, pulse: false });
  assert.match(first.join("\n"), /◉/);
  assert.match(second.join("\n"), /◎/);
  assert.doesNotMatch(first.join("\n"), /★/);
  const finished = paint(shape, lineage, { selectedIteration: 2, representativeIteration: 2 });
  assert.match(finished.join("\n"), /★/);
  assert.doesNotMatch(finished.join("\n"), /◉|◎/);
  assert.deepEqual(shape, before);

  const tones = [];
  renderSearchShape(shape, lineage, { selectedIteration: 6, pulse: false }, (tone, text) => { tones.push({ tone, text }); return text; });
  assert.ok(tones.some(({ tone, text }) => tone === "accent" && text.includes("◆")));
  assert.ok(tones.some(({ tone, text }) => tone === "accent" && /│|─|┴/.test(text)));
  assert.ok(tones.some(({ tone }) => tone === "muted"));
});

test("a hidden selected representative highlights its bundle without claiming an individual visible winner", () => {
  const lineage = buildIterationLineage(Array.from({ length: 100 }, (_, index) => row(index + 1)));
  const shape = layoutSearchShape(lineage, 21, 7);
  const tones = [];
  const lines = renderSearchShape(shape, lineage, { selectedIteration: 100, representativeIteration: 100, pulse: false },
    (tone, text) => { tones.push({ tone, text }); return text; });
  assert.doesNotMatch(lines.join("\n"), /★/);
  assert.ok(tones.some(({ tone, text }) => tone === "success" && /░|▒|▓/.test(text)));
});
