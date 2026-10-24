import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";
import { overviewArchive } from "./fixtures/overview.mjs";
import { root, archive as legacyArchive } from "./fixtures/replay.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { buildReplayView, replaySummary } = await jiti.import("../extensions/swe-replay/visualization-model.ts");
const { ReplayDashboard } = await jiti.import("../extensions/swe-replay/ui/dashboard.ts");
const entry = (entries, id) => entries.find((entry) => entry.id === id);
const view = (entries) => buildReplayView(entries, "root", ["root", "step-2", "candidate-2", "restoration"]);
const theme = { fg: (_, text) => text };

function freeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

test("overview projects captured votes, exclusions and archived winner restoration without writes or sampling", (t) => {
  const entries = freeze(overviewArchive());
  const before = JSON.stringify(entries);
  t.mock.method(Math, "random", () => { throw new Error("must not sample"); });
  const result = view(entries);
  const overview = result.overview;
  assert.equal(overview.headline, "Selected iteration 2 · workspace and conversation restored");
  assert.deepEqual(overview.groups.map((g) => [g.label, g.votes, g.iterations, g.selected]), [
    ["G1", 2, [2, 4], true], ["G2", 1, [1], false],
  ]);
  assert.equal(overview.eligibleCount, 3);
  assert.equal(overview.baseline.status, "passed");
  assert.equal(overview.iterations[2].approach, "Exploit");
  assert.equal(overview.iterations[2].targetStepId, "step-1");
  assert.equal(overview.iterations[0].approach, "Explore");
  assert.match(overview.iterations[2].vote, /regression-failed/);
  assert.match(overview.iterations[4].vote, /raw-empty/);
  assert.equal(overview.iterations[1].representative, true);
  assert.deepEqual(overview.diagnostics, []);
  assert.equal(JSON.stringify(entries), before);
  assert.deepEqual(view([...entries].reverse()).overview, overview);
  const summary = replaySummary(result);
  assert.match(summary, /Selected iteration 2/);
  assert.match(summary, /G1: 2 votes/);
  assert.doesNotMatch(summary, /PRIVATE OUTPUT|BASELINE OUTPUT/);
});

test("overview distinguishes no winner, failed restoration, missing completion and finalization errors", () => {
  assert.match(view(overviewArchive({ noWinner: true })).overview.headline, /No qualifying patch/);
  const failed = view(overviewArchive({ restoration: "failed" })).overview;
  assert.match(failed.headline, /restoration failed/);
  assert.ok(failed.notes.includes("Navigation cancelled"));
  assert.ok(failed.notes.some((n) => n.includes("conversation restored")));
  for (const restoration of [false, "started"]) {
    assert.match(view(overviewArchive({ restoration })).overview.headline, /restoration not confirmed/);
  }
  const entries = overviewArchive({ selection: false });
  assert.match(view(entries).overview.headline, /Run incomplete/);
  assert.equal(view(entries).overview.groups.length, 0);
  assert.equal(view(entries).overview.iterations[0].vote, "not recorded");
  entries.push({ id: "error", parentId: "evaluation-5", type: "custom", customType: "swe-replay-finalization-error",
    data: { schemaVersion: 1, rootEntryId: "root", phase: "normalization", error: "Worker failed" } });
  assert.match(view(entries).overview.headline, /Finalization failed/);
  assert.ok(view(entries).overview.notes.includes("normalization: Worker failed"));
});

test("baseline failure remains visible without pretending candidate evaluation or selection happened", () => {
  const entries = overviewArchive({ selection: false }).filter((e) => ["root", "base", "baseline"].includes(e.id));
  entry(entries, "baseline").data.status = "failed";
  entry(entries, "baseline").data.exitCode = 1;
  const overview = view(entries).overview;
  assert.match(overview.headline, /Baseline failed/);
  assert.equal(overview.baseline.status, "failed");
  assert.equal(overview.iterations.length, 0);
  assert.ok(overview.diagnostics.some((d) => d.includes("missing-or-invalid-passing-baseline")));
});

test("inconclusive or missing evaluation cannot validate a persisted final decision", () => {
  for (const change of [
    (entries) => { entry(entries, "evaluation-2").data.status = "inconclusive"; },
    (entries) => { entries.splice(entries.indexOf(entry(entries, "evaluation-2")), 1); },
  ]) {
    const entries = overviewArchive();
    change(entries);
    const overview = view(entries).overview;
    assert.match(overview.headline, /Outcome unavailable/);
    assert.ok(overview.diagnostics.some((d) => d.includes("final-selection")));
    assert.equal(overview.groups.length, 0);
  }
});

test("invalid, unsupported, inconsistent or ambiguous final selections remain unavailable", () => {
  const changes = [
    (p) => { p.schemaVersion = 2; },
    (p) => { p.baseEntryId = "other"; },
    (p) => { p.identityEntryIds.pop(); },
    (p) => { p.decision.policy.voting = "future"; },
    (p) => { p.decision.policy.equivalence = "future"; },
    (p) => { p.decision.groups[0].votes++; },
    (p) => { p.decision.groups[0].candidateEntryIds[0] = "candidate-3"; },
    (p) => { p.decision.selectedCandidateEntryId = "candidate-1"; },
    (p) => { p.decision.groups.reverse(); },
    (p) => { p.decision.candidates = null; },
    (p) => { p.decision.eligibleCount = -1; },
    (p) => { p.decision.candidates[0].exclusionReasons = ["future-reason"]; },
    (p) => { p.decision.diagnostics = [{}]; },
    (p) => { p.decision.groups[0].iterations = null; },
    (p) => { p.decision.tiedGroupKeyHashes = ["unsupported"]; },
  ];
  for (const change of changes) {
    const entries = overviewArchive();
    change(entry(entries, "selection").data);
    const overview = view(entries).overview;
    assert.equal(overview.headline, "Outcome unavailable · invalid or unsupported final selection");
    assert.deepEqual(overview.groups, []);
    assert.ok(overview.diagnostics.includes("Invalid, ambiguous, or unsupported final-selection record."));
  }
  const entries = overviewArchive();
  entries.push({ ...entry(entries, "selection"), id: "duplicate-selection" });
  assert.match(view(entries).overview.headline, /Outcome unavailable/);
});

test("restoration requires selection, candidate, snapshot and attempt associations", () => {
  for (const change of [
    (d) => { d.selectionEntryId = "missing"; },
    (d) => { d.candidateEntryId = "candidate-1"; },
    (d) => { d.targetSnapshotOid = "wrong"; },
    (d) => { d.policy = "future"; },
    (d) => { d.attemptEntryId = "missing"; },
    (d) => { d.backupEntryId = "wrong"; },
  ]) {
    const entries = overviewArchive();
    change(entry(entries, "restoration").data);
    const overview = view(entries).overview;
    assert.match(overview.headline, /restoration not confirmed/);
    assert.ok(overview.diagnostics.some((d) => /restoration record|restoration evidence/.test(d)));
  }
});

test("legacy, nested and sibling records do not supply invented outcomes", () => {
  assert.match(view(legacyArchive()).overview.headline, /Outcome unavailable/);
  const entries = overviewArchive();
  entries.push(root("nested", "candidate-1"), { ...entry(entries, "selection"), id: "nested-selection", parentId: "nested" });
  assert.match(view(entries).overview.headline, /Selected iteration 2/);
});

test("ties and normalization-empty exclusions are displayed from captured decisions", () => {
  const tied = view(overviewArchive({ count: 2 })).overview;
  assert.match(tied.headline, /Selected iteration 1/);
  assert.ok(tied.notes.some((n) => n.includes("Top-vote tie")));
  const empty = view(overviewArchive({ normalizationEmpty: true })).overview;
  assert.match(empty.headline, /No qualifying patch/);
  assert.match(empty.iterations[0].vote, /normalization-empty/);
});

test("dashboard starts on Overview, drills into iterations, and reveals regression evidence only on request", () => {
  const result = view(overviewArchive());
  const dashboard = new ReplayDashboard([result], theme, () => {}, () => {}, () => 40, () => "");
  let output = dashboard.render(160).join("\n");
  assert.match(output, /\[Overview\]/);
  assert.match(output, /Selected iteration 2/);
  assert.match(output, /3 eligible votes/);
  assert.match(output, /baseline PASS/);
  assert.doesNotMatch(output, /PRIVATE OUTPUT|BASELINE OUTPUT/);
  dashboard.handleInput("\x1b[B");
  output = dashboard.render(160).join("\n");
  assert.match(output, /ITERATION 1/);
  dashboard.handleInput("e");
  output = dashboard.render(160).join("\n");
  assert.match(output, /PRIVATE OUTPUT 1/);
  dashboard.handleInput("e");
  assert.doesNotMatch(dashboard.render(160).join("\n"), /PRIVATE OUTPUT/);
  dashboard.handleInput("\r");
  output = dashboard.render(160).join("\n");
  assert.match(output, /\[Trajectories\]/);
  assert.match(output, /Step step-1/);
});

test("approaches use run/iteration logs across branches and ambiguous logs stay unknown", () => {
  const entries = overviewArchive();
  const log = entry(entries, "decision-4");
  log.data.selection = null;
  log.data.fallbackReason = "no-eligible-states";
  assert.equal(view(entries).overview.iterations[3].approach, "Explore (fallback)");
  entries.push({ ...log, id: "duplicate-log" });
  const overview = view(entries).overview;
  assert.equal(overview.iterations[3].approach, "Unknown");
  assert.ok(overview.diagnostics.includes("Ambiguous or invalid approach for iteration 4."));
});

test("mismatched regression evidence never confirms a winner", () => {
  for (const change of [
    (d) => { d.snapshotOid = "0".repeat(40); },
    (d) => { d.testCommand = "different command"; },
    (d) => { d.status = "passed"; d.exitCode = 1; },
    (d) => { d.iteration = 4; },
  ]) {
    const entries = overviewArchive();
    change(entry(entries, "evaluation-2").data);
    const overview = view(entries).overview;
    assert.match(overview.headline, /Outcome unavailable/);
    assert.equal(overview.iterations[1].evaluation, undefined);
    assert.ok(overview.diagnostics.includes("Ambiguous or mismatched evaluation for candidate-2."));
  }
});

test("complete overview layouts fit resized terminals and baseline evidence is opt-in", () => {
  const result = view(overviewArchive());
  let height = 40;
  const dashboard = new ReplayDashboard([result], theme, () => {}, () => {}, () => height, () => "");
  assert.doesNotMatch(dashboard.render(160).join("\n"), /BASELINE OUTPUT/);
  dashboard.handleInput("e");
  assert.match(dashboard.render(160).join("\n"), /BASELINE OUTPUT/);
  dashboard.handleInput("\x1b[B");
  assert.doesNotMatch(dashboard.render(160).join("\n"), /BASELINE OUTPUT/);
  for (height of [4, 8, 16, 24, 40]) {
    for (const width of [1, 12, 40, 80, 99, 100, 120, 160]) {
      const lines = dashboard.render(width);
      assert.ok(lines.length <= height);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
  }
});
