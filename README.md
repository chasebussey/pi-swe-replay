# pi-swe-replay

A [Pi coding agent](https://github.com/earendil-works/pi) extension implementing the foundations of SWE-Replay.

## Commands

- `/swe-replay <n> <prompt>` starts a replay run requesting `n` candidate patches.
- `/inspect-session` displays persisted SWE-Replay entries on the active session branch.
- `/swe-replay-view` opens a read-only inspector across archived branches (text summary outside TUI mode).

The first iteration explores; later iterations independently choose exploration or exploitation with equal probability. Exploration returns to the run's conversation root, restores its initial workspace, and sends the prompt again.

**This is a scaffold, not a complete patch-generation workflow.** Exploitation selects and logs a step in `swe-replay-exploit-log`, navigates the conversation immediately **before** that assistant message without summarizing, and restores the matching workspace. The previous turn's tool results and tracking snapshots remain in context, while the selected step and its results stay archived on the original branch. It then starts a replacement trajectory with a hidden, empty `swe-replay-continue` custom message and waits for agent settlement, tracking files and workspace snapshots as usual. This adds an empty user-role message to model context rather than a textual continuation instruction; provider support still needs live smoke testing. With no eligible states, it logs the reason and falls back to exploration. Patch capture, regression filtering, and evaluation are not implemented. Run experiments only in disposable repositories/sessions.

## Workspace snapshots

A Git repository with an existing HEAD and no submodules or unresolved index conflicts is required. At the replay root and after every agent turn, SWE-Replay creates a stash-shaped Git snapshot containing the index, tracked working-tree changes, and untracked files (excluding ignored files). Capture uses temporary indexes and does not clean or alter workspace files. Snapshot OIDs, retaining refs, the replay root ID, and completed assistant step ID are persisted in `swe-replay-workspace` entries. Exploitation resolves the preceding snapshot through the selected step's ancestors; it never restores that step's own post-turn state or a sibling branch's state. Older steps without snapshots cannot be restored.

**Restoration replaces current tracked and untracked state**, removing later non-ignored files and restoring staged changes. It uses `git reset --hard HEAD`, `git clean -fd`, and `git stash apply --index`. Before restoration, a recovery snapshot is retained in a `swe-replay-workspace-backup` entry. A changed HEAD or ignored-file collision causes restoration to refuse; Git errors stop the replay rather than silently continuing. A failed apply can leave a partially restored workspace; the recovery snapshot remains available.

Snapshots are retained under `refs/swe-replay/*`, not the user's stash list, and survive Git garbage collection. They are not automatically deleted; remove these refs manually when the associated sessions/backups are no longer needed. A snapshot can be inspected with `git show <oid>` or applied with `git stash apply --index <oid>` in a suitable clean workspace. No environment state, ignored-file contents, nested repositories, external files, or other non-Git mutations are captured. Avoid concurrent external edits during replay.

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

Selection uses two-stage softmax: `1 / candidate count` for states, then reasoning paragraph count for steps. All recorded completed steps are provisionally eligible; regression filtering is pending. Shell-based file accesses are not tracked. Non-context `swe-replay-step-boundary` entries anchor assistant steps so future navigation can retain the preceding empty custom message (Pi otherwise navigates before custom messages).

## Reasoning scores

`reasoningScore(stepId, sessionManager)` looks up a candidate's assistant message and returns its visible thinking paragraph count, for use as the step-selection softmax logit. Blank lines (including whitespace-only lines) separate paragraphs; single newlines do not. Counts are summed across thinking blocks. Ordinary assistant text, tool calls, and redacted reasoning are excluded. A valid step without visible reasoning scores zero; missing IDs and non-assistant entries throw. Each selection logs a versioned trace containing state probabilities, the selected state's candidate scores/probabilities, and the chosen IDs. Selection math stays private to the selector.

## Inspector

Use Tab to switch Runs/Trajectories/Decisions, ↑↓ to select, Enter to open a run or toggle detail focus, PgUp/PgDn to scroll details, and Escape to go back/close. Press `r` on a step to reveal/hide its message and visible reasoning. `*` marks the active branch; `f` counts pre-step files and `r` counts reasoning paragraphs. Decision probabilities and scores come from recorded selection traces; older logs show probabilities as unavailable. Reopen to refresh; inspection never navigates or restores the session. In Decisions, `step-selected` means an exploitation replacement target was selected, not that generation completed; `explore-fallback` means exploitation found no eligible target and fell back to exploration. Decision logs do not record generation completion or patch evaluation, including for older sessions.

See [implementation progress](docs/visualization-implementation.md) and [design](docs/visualization-design.md).

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
