# pi-swe-replay

A [Pi coding agent](https://github.com/earendil-works/pi) extension implementing the foundations of SWE-Replay.

## Commands

- `/swe-replay <n> <prompt>` starts a replay run requesting `n` candidate patches.
- `/inspect-session` displays persisted SWE-Replay entries on the active session branch.

The first iteration explores; later iterations independently choose exploration or exploitation with equal probability. Exploration returns to the run's conversation root and sends the prompt again.

**This is a scaffold, not a complete patch-generation workflow.** Exploitation selects and logs a step in `swe-replay-exploit-log`, but does not yet restore or resume it. With no eligible states, it logs the reason and falls back to exploration. Workspace restoration, patch capture, regression filtering, and evaluation are not implemented. Conversation navigation does not restore files. Run experiments only in disposable repositories/sessions.

## Exploration states

Successful `read`, `write`, and `edit` accesses are persisted as cumulative, sorted, absolute file paths in `swe-replay-turn-files` entries at each turn's end.

For exploitation, completed steps across all branches of the current replay run are grouped into:

```typescript
interface ExplorationState {
  files: string[];
  candidateStepIds: string[];
}
```

`files` is the sorted, deduplicated set explored **before** the step, obtained from its ancestor snapshots, not its own end-of-turn snapshot. Empty states are skipped. Candidate IDs identify assistant message entries and can be looked up with `sessionManager.getEntry(id)`; they are not snapshot entry IDs. Shared steps are counted once, and sibling branches do not inherit each other's files. The rollup is reconstructed from existing session entries without changing the persisted file-snapshot format.

Selection uses two-stage softmax: `1 / candidate count` for states, then reasoning paragraph count for steps. All recorded completed steps are provisionally eligible; regression filtering is pending. Shell-based file accesses are not tracked.

## Reasoning scores

`reasoningScore(stepId, sessionManager)` looks up a candidate's assistant message and returns its visible thinking paragraph count, for use as the step-selection softmax logit. Blank lines (including whitespace-only lines) separate paragraphs; single newlines do not. Counts are summed across thinking blocks. Ordinary assistant text, tool calls, and redacted reasoning are excluded. A valid step without visible reasoning scores zero; missing IDs and non-assistant entries throw. The selected step's score is logged with its state and ID.

## Use locally

```bash
npm ci
pi --extension ./extensions/index.ts
```

## Checks

```bash
npx --no-install tsc --noEmit
node --test tests/*.test.mjs
```

The tests use Node.js's built-in test runner and `jiti`, the TypeScript loader installed with Pi, without emitting build artifacts.
