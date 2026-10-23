# Agent guidance

## Project overview

`pi-swe-replay` is a TypeScript extension package for the Pi coding agent. It
implements the exploration/exploitation foundations of
[SWE-Replay v2](https://arxiv.org/html/2601.22129v2), with workspace restoration
and user-command regression validation. Patch export and best-result ranking
are not implemented.

Registered commands:
- `/swe-replay <n> <prompt>` starts a positive number of replay iterations and
  asks for a required regression command through UI input.
- `/swe-replay-view` opens a read-only dashboard across active and archived
  branches; outside TUI mode it provides a summary.
- `/inspect-session` displays SWE-Replay entries on the active session branch.

## Replay and candidate selection

Follow the paper, particularly §§2.1–2.3 and Algorithm 1, while distinguishing
implemented behavior from remaining work.

- The first iteration always explores from the replay root. Later iterations
  independently choose exploration or exploitation with probability 0.5 each.
- Exploration restores the initial workspace and sends the original prompt.
- Exploitation restores context and workspace immediately **before** the selected
  assistant step, then generates a replacement continuation on a new branch.
  Never resume after the selected step.
- Continuation uses a hidden, empty `swe-replay-continue` custom message with
  `triggerTurn: true`. It supplies no textual instruction, but Pi includes an
  empty user-role message; provider compatibility needs live smoke testing.
- If no eligible states exist, exploitation falls back to exploration.

### Regression eligibility

The user command runs through `bash -lc` in a fresh disposable Git worktree,
with a ten-minute timeout, against the baseline and every completed trajectory's
final workspace snapshot. It does not evaluate each intermediate step.

- The baseline must pass before any agent prompt is sent.
- Exit code zero passes; nonzero fails. Killed commands or execution errors are
  inconclusive and stop replay.
- Passing generated trajectories contribute terminal IDs to the run's in-memory
  archive. Failed trajectories contribute no eligibility or sampling weight.
- Shared-prefix steps remain eligible if any passing trajectory contains them.
  A previously recorded terminal still counts after it acquires descendants.
- Persist evaluation evidence outside model context. Do not feed test output to
  the coding agent as an incidental part of selection.

### Multiplicity-weighted selection

Softmax selection applies only to exploitation, not exploration.

1. `eligibleStepIds` returns a `Map<string, number>` counting passing terminal
   paths containing each entry. It currently includes non-assistant ancestors;
   grouping restricts candidates to completed assistant steps.
2. `rollUpExplorationStates` requires that map. Group eligible steps by files
   explored **before** the step: absolute, sorted, deduplicated paths. Skip empty
   file states. Do not include the step's own accesses in its grouping key.
3. Represent membership as `candidates: [{ stepId, multiplicity }]`, not parallel
   ID/count arrays. Store each assistant step once. Repeated turn snapshots do
   not increase multiplicity; passing trajectory paths do.
4. Sample a state with `P(state_i) ∝ exp(1 / v_i)`, where `v_i` is the sum of
   candidate multiplicities in that state.
5. Sample a unique step within that state with
   `P(step | state) ∝ multiplicity × exp(reasoning paragraph count)`.
   Count paragraphs, not tokens or raw length. Ignore assistant text, tool calls,
   and redacted reasoning. Equal scores imply uniform unique-step probabilities
   only when multiplicities are equal.

Capture probabilities at selection time. Inspection must not rerun selection,
consume randomness, or reconstruct missing historical distributions.

### Trace metadata

Current traces use candidate objects with multiplicities and declare
`policyVersion: 1` and `eligibilityPolicy: "passed-trajectory-occurrences"`.
Keep the producer, parser, and fixtures aligned on this policy. The parser rejects
unsupported eligibility labels rather than reinterpreting their probabilities.
Do not describe the current format as supporting historical policy-v1/v2
compatibility; historical schemas are not automatically migrated.

## Repository map

- `extensions/index.ts`: command registration, UI input, and notifications.
- `extensions/swe-replay/run.ts`: argument parsing, replay orchestration,
  evaluation scheduling, navigation, and settlement handling.
- `extensions/swe-replay/evaluation.ts`: command execution, evidence, and passing
  terminal-path counts.
- `extensions/swe-replay/exploration-state.ts`: pre-step grouping and multiplicity.
- `extensions/swe-replay/select-step.ts`: sampling and selection-trace capture.
- `extensions/swe-replay/reasoning-score.ts`: visible reasoning paragraph counts.
- `extensions/swe-replay/selection-trace.ts`: durable trace shape and validation.
- `extensions/swe-replay/track-turn-files.ts`: branch-aware successful file access
  tracking persisted as custom session entries.
- `extensions/swe-replay/workspace.ts`: Git snapshot capture, restoration, and
  disposable evaluation worktrees.
- `extensions/swe-replay/visualization-model.ts` and `ui/`: read-only projection
  and dashboard. Generation completion and regression outcomes are not displayed.
- `tests/`: Node.js tests and session fixtures, loaded through `jiti`.
- `tsconfig.json`: strict TypeScript, ES2022, NodeNext resolution, no output.
- `README.md`: commands, selection semantics, workspace safety, and checks.
- `docs/`: design notes; verify them against current implementation when making
  changes rather than assuming every proposal is implemented.

## Setup and checks

Use npm and preserve the lockfile when changing dependencies.

```bash
npm ci
npx --no-install tsc --noEmit
node --test tests/*.test.mjs
```

There are no package scripts or configured lint/format commands. Report actual
results; a type check is not a test run.

For interactive smoke testing:

```bash
pi --extension ./extensions/index.ts
```

Use a disposable repository/session: replay sends real prompts, navigates history,
and replaces workspace files. Check arguments, command input/cancellation,
settlement cleanup, branch isolation, regression filtering, and restoration.

## Implementation conventions

- Follow existing TypeScript style: two-space indentation, double quotes, named
  exports for helpers, and type-only imports for Pi interfaces.
- Keep command registration/UI concerns in `extensions/index.ts`; keep replay
  orchestration, selection, tracking, and evaluation in their modules.
- Consult installed Pi documentation/types before changing API usage. Do not
  assume another version's event or navigation semantics. Pi navigates before
  user/custom messages; step-boundary entries preserve the intended context.
- Register settlement listeners before triggering prompts or continuations.
  Preserve cleanup in `finally` and the cleanup returned by `trackTurnFiles`.
- Preserve run/branch isolation. File tracking is cumulative within a branch,
  ignores failed tools, normalizes absolute paths, and persists sorted snapshots.
- Tests for persisted probabilities should assert captured data, not recompute
  historical values from later session contents. Malformed-input tests should
  identify specific diagnostics rather than rely on broad warning counts.
- Update README when changing commands, selection semantics, or setup.
- Keep changes focused; do not edit `node_modules` or commit generated artifacts.

## Session state and workspace safety

Persisted custom entry types:
- `swe-replay-root`: prompt, iteration count, test command, timeout, and cwd.
- `swe-replay-evaluation`: baseline/candidate outcome and bounded evidence.
- `swe-replay-exploit-log`: selection, candidate membership, and trace.
- `swe-replay-turn-files`: `rootEntryId`, `iteration`, `turnIndex`,
  `messageEntryId`, and cumulative `files`.
- `swe-replay-workspace`: root/completed-step snapshot OID and retaining ref.
- `swe-replay-workspace-backup`: recovery snapshot before restoration.
- `swe-replay-step-boundary`: pre-assistant navigation anchor.

Consider existing persisted sessions when changing shapes. Malformed decisions
remain visible as `unknown` with diagnostics. Missing, invalid, or unsupported
traces have unavailable probabilities; historical schemas are not automatically
migrated. File-access snapshots are not file-content backups.

Workspace capture uses temporary indexes and retains stash-compatible snapshots
under `refs/swe-replay/*`, separate from the normal stash list. Restoration uses
hard reset, clean, and stash apply, with a recovery snapshot first. It requires
an existing HEAD, no submodules or index conflicts, and refuses changed HEAD or
ignored-file collisions. A failed apply can leave partial restoration.

Evaluation worktrees materialize staged, unstaged, and non-ignored untracked
state without replacing the active checkout. Canonicalize working-directory
aliases and reject source directories outside the repository. Ignored dependencies
are not copied; commands must include needed setup. Worktrees share Git metadata
and OS permissions: this is not a security sandbox. Commands must not mutate
shared refs, the source checkout, or external resources.

Snapshots do not undo ignored files, external changes, global installs, or
services. Avoid concurrent edits. Do not introduce destructive Git operations
outside explicit replay restoration or overwrite user work incidentally. Leave
ordinary user stashes untouched unless explicitly asked to apply them.

## Collaboration and completion

Before editing, inspect relevant files and working-tree status. Preserve unrelated
user changes. After editing, run the type check and relevant tests; report changes,
actual validation results, known failures, and remaining limitations.
