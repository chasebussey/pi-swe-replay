import { createJiti } from "jiti";
import { step, snapshot as turnFiles } from "./replay.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { readReplayArchive, completedSelectionInputs } = await jiti.import("../../extensions/swe-replay/replay-records.ts");
const { selectFinalPatch } = await jiti.import("../../extensions/swe-replay/final-selection.ts");
const oid = (n, size = 40) => n.toString(16).padStart(size, "0");

/** Complete persisted evidence; selection is captured by the producer, not the UI. */
export function overviewArchive({ count = 5, selection = true, restoration = "restored", noWinner = false, normalizationEmpty = false } = {}) {
  const entries = [];
  const add = (id, parentId, customType, data) => {
    entries.push({ id, parentId, timestamp: "2026-01-01T00:00:00Z", type: "custom", customType, data });
  };
  const execution = { testCommand: "npm ci && npm test", testTimeoutMs: 600000, cwd: "/repo" };
  const envelope = { schemaVersion: 1, rootEntryId: "root" };
  const snapshot = (stepId, n) => ({ rootEntryId: "root", stepId, oid: oid(n), ref: `refs/swe-replay/${n}` });
  const tree = (snapshot, n) => ({ rootEntryId: "root", snapshotOid: snapshot.oid, treeOid: oid(n), ref: `refs/swe-replay/trees/${n}` });
  const initial = snapshot("root", 1);
  const baseTree = tree(initial, 2);
  add("root", null, "swe-replay-root", { schemaVersion: 1, prompt: "Fix parser handling", requestedPatchCount: count, ...execution });
  add("base", "root", "swe-replay-base", { ...envelope, ...execution, requestedCount: count,
    snapshot: initial, tree: baseTree, baseTreeOid: baseTree.treeOid });
  add("baseline", "base", "swe-replay-evaluation", { ...envelope, ...execution, iteration: 0,
    terminalEntryId: "base", snapshotOid: initial.oid, status: "passed", exitCode: 0,
    stdout: "BASELINE OUTPUT", stderr: "", durationMs: 10 });

  for (let i = 1; i <= count; i++) {
    if (i === 3 || i === 4) {
      add(`decision-${i}`, `evaluation-${i - 1}`, "swe-replay-exploit-log", { rootEntryId: "root", iteration: i,
        selection: { stepId: "step-1", reasoningScore: 1 }, states: [{ files: ["/repo/a"], candidates: [{ stepId: "step-1", multiplicity: 1 }] }] });
    }
    entries.push(step(`step-${i}`, "root"));
    entries.push(turnFiles(`files-${i}`, `step-${i}`, `step-${i}`, ["/repo/a"], i));
    const s = snapshot(`files-${i}`, 10 + i);
    const rawEmpty = noWinner || i === 5;
    const candidateTree = tree(s, rawEmpty ? 2 : 20 + i);
    add(`candidate-${i}`, `files-${i}`, "swe-replay-candidate", { ...envelope, iteration: i,
      terminalEntryId: `files-${i}`, snapshot: s });
    add(`evaluation-${i}`, `candidate-${i}`, "swe-replay-evaluation", { ...envelope, ...execution,
      candidateEntryId: `candidate-${i}`, iteration: i, terminalEntryId: `files-${i}`, snapshotOid: s.oid,
      status: i === 3 ? "failed" : "passed", exitCode: i === 3 ? 1 : 0,
      stdout: `PRIVATE OUTPUT ${i}`, stderr: "", durationMs: 100 + i });
    add(`identity-${i}`, `evaluation-${count}`, "swe-replay-patch-identity", { ...envelope,
      candidateEntryId: `candidate-${i}`, tree: candidateTree, normalization: {
        policy: "complete-tree-agentless-mixed-v1", baseTreeOid: baseTree.treeOid, candidateTreeOid: candidateTree.treeOid,
        keyHash: oid(i === 2 || i === 4 ? 4 : 3, 64), rawEmpty, normalizationEmpty: rawEmpty || normalizationEmpty, diagnostics: [],
        python: { policy: "agentless-python-pyodide-v2", upstreamRevision: "5ce5888b9f149beaace393957a55ea8ee46c9f71",
          pyodideVersion: "314.0.7", pythonVersion: "3.14.2", gitDiffPolicy: "fixed-myers-three-context-v1" },
      } });
  }
  if (selection) {
    const parsed = readReplayArchive(entries, "root");
    if (parsed.status !== "available") throw new Error(JSON.stringify(parsed));
    const archive = parsed.archive;
    const decision = selectFinalPatch(archive.base, completedSelectionInputs(archive), archive.evaluations);
    add("selection", `identity-${count}`, "swe-replay-final-selection", { ...envelope, baseEntryId: "base",
      candidateEntryIds: archive.candidates.map((c) => c.entryId), identityEntryIds: archive.identities.map((i) => i.entryId),
      evaluationEntryIds: ["baseline", ...archive.evaluations.map((e) => e.entryId)], decision });
    if (decision.status === "selected" && restoration) {
      const winner = entries.find((entry) => entry.id === decision.selectedCandidateEntryId);
      const association = { ...envelope, policy: "selected-candidate-context-v1", selectionEntryId: "selection",
        candidateEntryId: winner.id, targetSnapshotOid: winner.data.snapshot.oid, fromEntryId: "selection" };
      add("attempt", "selection", "swe-replay-restoration", { ...association, status: "started", backupEntryId: "backup", backup: initial });
      if (restoration !== "started") add("restoration", winner.id, "swe-replay-restoration", {
        ...association, status: restoration, attemptEntryId: "attempt", backupEntryId: "backup",
        ...(restoration === "failed" ? { error: "Navigation cancelled", workspaceRecovery: "not-needed", contextRecovery: "restored", recoveryErrors: [] } : {}),
      });
    }
  }
  return entries;
}
