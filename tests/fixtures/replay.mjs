const timestamp = "2026-01-01T00:00:00Z";
export const root = (id = "root", parentId = null) => ({
  id, parentId, timestamp, type: "custom", customType: "swe-replay-root", data: {},
});
export const step = (id, parentId, paragraphs = 1) => ({
  id, parentId, timestamp, type: "message", message: {
    role: "assistant", content: [
      { type: "thinking", thinking: Array(paragraphs).fill("Private reasoning.").join("\n\n") },
      { type: "text", text: "Visible answer." },
    ],
  },
});
export const snapshot = (id, parentId, stepId, files, iteration = 1, rootEntryId = "root") => ({
  id, parentId, timestamp, type: "custom", customType: "swe-replay-turn-files",
  data: { rootEntryId, iteration, turnIndex: 0, messageEntryId: stepId, files },
});
export const decision = (id, parentId, data) => ({
  id, parentId, timestamp, type: "custom", customType: "swe-replay-exploit-log", data,
});
export function selectionTrace() {
  const shortProbability = 1 / (1 + Math.exp(2));
  return {
    policyVersion: 1, eligibilityPolicy: "passed-trajectory-occurrences",
    states: [{
      files: ["/repo/a"],
      candidates: [
        { stepId: "a2", multiplicity: 1 },
        { stepId: "b2", multiplicity: 1 },
      ],
      probability: 1,
    }],
    selectedStateIndex: 0,
    candidates: [
      { stepId: "a2", reasoningScore: 1, probability: shortProbability },
      { stepId: "b2", reasoningScore: 3, probability: 1 - shortProbability },
    ],
    selectedStepId: "b2",
  };
}
export function archive() {
  return [
    root(),
    step("a1", "root"), snapshot("s1", "a1", "a1", ["/repo/a"]),
    step("a2", "s1", 1), snapshot("s2", "a2", "a2", ["/repo/a", "/repo/b"]),
    step("b1", "root"), snapshot("t1", "b1", "b1", ["/repo/a"], 2),
    step("b2", "t1", 3), snapshot("t2", "b2", "b2", ["/repo/a", "/repo/c"], 2),
    decision("decision", "t2", {
      rootEntryId: "root", iteration: 3,
      states: [{
        files: ["/repo/a"],
        candidates: [
          { stepId: "a2", multiplicity: 1 },
          { stepId: "b2", multiplicity: 1 },
        ],
      }],
      selection: {
        state: {
          files: ["/repo/a"],
          candidates: [
            { stepId: "a2", multiplicity: 1 },
            { stepId: "b2", multiplicity: 1 },
          ],
        },
        stepId: "b2", reasoningScore: 3,
      },
      trace: selectionTrace(),
    }),
  ];
}
