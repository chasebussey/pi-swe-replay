import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";
import { overviewArchive } from "./fixtures/overview.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { buildReplayView, replaySummary } = await jiti.import("../extensions/swe-replay/visualization-model.ts");
const { ReplayDashboard } = await jiti.import("../extensions/swe-replay/ui/dashboard.ts");
const theme = { fg: (_, text) => text };

for (const backend of [undefined, "agentless", "tsc"]) {
  test(`captured ${backend ?? "legacy"} policy and fallback diagnostics display without sampling or mutation`, (t) => {
    const entries = overviewArchive({ normalization: backend });
    const identity = entries.find((entry) => entry.id === "identity-2").data.normalization;
    identity.diagnostics.push(backend === "tsc" ? {
      kind: "exact-content-fallback", pathBase64: Buffer.from("bad\x1b.py").toString("base64"),
      side: "after", reason: "syntax-error", issues: [{ kind: "error", nodeType: "ERROR", startIndex: 1, endIndex: 2 }],
    } : { kind: "exact-content-fallback", path: "bad\x1b.py", pythonType: "SyntaxError", message: "invalid syntax" });
    if (backend === "tsc") identity.diagnosticsTruncated = 3;
    const before = JSON.stringify(entries);
    t.mock.method(Math, "random", () => assert.fail("inspection must not sample"));
    const view = buildReplayView(entries, "root", ["root", "restoration"]);
    const policy = backend === "tsc" ? "complete-tree-tsc-mixed-v1" : "complete-tree-agentless-mixed-v1";
    assert.equal(view.overview.normalizationPolicy, policy);
    assert.match(view.overview.headline, /workspace and conversation restored/);
    const summary = replaySummary(view);
    assert.ok(summary.includes(policy));
    assert.match(summary, /Exact fallback: bad/);
    assert.match(summary, backend === "tsc" ? /3 additional fallback diagnostics omitted at capture/ : /SyntaxError/);
    if (!backend) assert.match(summary, /legacy read-only/);
    else assert.match(summary, /Execution:/);

    const dashboard = new ReplayDashboard([view], theme, () => {}, () => {}, () => 50, () => "");
    assert.match(dashboard.render(180).join("\n"), new RegExp(policy));
    dashboard.handleInput("\x1b[B");
    dashboard.handleInput("\x1b[B");
    assert.match(dashboard.render(180).join("\n"), /Exact fallback: bad\?/);
    for (const width of [30, 60, 100, 180]) {
      assert.ok(dashboard.render(width).every((line) => visibleWidth(line) <= width));
    }
    assert.equal(JSON.stringify(entries), before);
  });
}

test("unsupported or mismatched captured policy stays unavailable with diagnostics", () => {
  const entries = overviewArchive({ normalization: "tsc" });
  entries.find((entry) => entry.id === "root").data.normalizationContract.provenance.policy = "future";
  const view = buildReplayView(entries, "root", []);
  assert.equal(view.overview.normalizationPolicy, undefined);
  assert.match(replaySummary(view), /Equivalence: unavailable/);
  assert.ok(view.overview.diagnostics.length > 0);
});
