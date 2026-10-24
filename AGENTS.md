# Agent guidance

## Project overview

`pi-swe-replay` is a TypeScript extension package for the Pi coding agent. It
implements exploration, exploitation, and regression-filtered final patch voting
from [SWE-Replay v2](https://arxiv.org/html/2601.22129v2), with automatic restoration
of the selected workspace and conversation. The core workflow is ready for
controlled end-to-end verification, not yet established as production-ready or a
reproduction of the paper's benchmark results. User-facing patch export and
detailed final-result dashboard presentation remain unimplemented.

Registered commands:
- `/swe-replay <n> <prompt>` asks for a required regression command through UI
  input, runs a positive number of iterations, then selects and restores a passing
  representative if one qualifies. `n` counts iterations, not distinct patches.
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

### Final patch selection and restoration

Final voting is separate from exploitation sampling. Keep their eligibility,
weighting, and persisted policies distinct.

- Finalize only after all requested iterations complete. Aborted, errored,
  interrupted, or inconclusive runs must not make an automatic final selection.
  Use the shared `assertReplayComplete` before normalization and when constructing
  selection inputs; it does not require patch identities or all candidates to pass.
- Measure patches against the initial complete workspace content tree, not HEAD.
  Preexisting staged, unstaged, and nonignored untracked work is part of the base.
- Under `passing-candidate-occurrences-v1`, each passing, nonempty completed
  iteration contributes one vote, including repeated equivalent outcomes. The
  baseline, failed, unevaluated, inconclusive, raw-empty, and normalization-empty
  candidates cannot vote. Exploitation multiplicities and reasoning scores do not
  affect this vote. Reuse captured evaluations; do not automatically retest.
- Select the largest equivalent-patch group by plurality, not absolute majority.
  Ties and representatives favor the earliest passing iteration. Capture groups,
  votes, exclusions, ties, and the representative without rerunning selection
  during inspection. Regression passing is not proof of task correctness.
- Persist selection before restoration. Retain a recovery snapshot, navigate to
  the selected completed candidate anchor without a summary, verify navigation,
  then restore the candidate's original snapshot, including index state. Never
  apply normalized source or grouping keys to the checkout.
- With no eligible winner, persist an explicit no-winner result and leave the
  last iteration's workspace and conversation active. A restoration failure is
  separate from selection: never report it as successful completion. Recovery of
  workspace and context after mutation is best-effort and failures remain explicit.

### Patch normalization policy

- `normalization-policy.ts` owns policy/provenance constants, shared types, and
  `isSupportedNormalizationProvenance`. Use that predicate in consumers; keep
  payload shape and cross-record association checks in their respective layers.
- `complete-tree-agentless-mixed-v1` combines Agentless-derived Python grouping
  with lossless exact-content handling for other files, binary/invalid-UTF-8
  content, symlinks, and unsupported kinds. Preserve raw path bytes, existence,
  and modes. Raw-empty and normalization-empty are distinct.
- `agentless-python-pyodide-v2` uses pinned bundled CPython/WASM in an offline,
  disposable worker, not host Python. Parse candidate source; never execute it.
  Syntax errors use exact original content on both sides with diagnostics.
  Runtime, resource, and infrastructure failures reject the entire batch; do not
  turn them into partial votes or silently change normalization policy.
- Preserve captured provenance and reject unsupported policies rather than
  reinterpreting old hashes. The Agentless reference corpus is not proof of
  semantic equivalence or comprehensive Python compatibility. Keep third-party
  notices and licenses with the implementation.

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
- `extensions/swe-replay/workspace.ts`: Git snapshot capture, restoration,
  disposable evaluation worktrees, complete content trees, and binary-safe
  initial-workspace-relative patch export helpers (not exposed as a command).
- `extensions/swe-replay/replay-records.ts`: typed payload parsing, cross-branch
  archive associations, completion checks, and final-selection input construction.
- `extensions/swe-replay/final-selection.ts`: pure iteration assessment, exclusion
  diagnostics, vote aggregation, and deterministic final ranking.
- `extensions/swe-replay/finalize-run.ts`: archive completion, one normalization
  batch, decision persistence, and winner-restoration orchestration.
- `extensions/swe-replay/restore-winner.ts`: selected conversation/workspace
  restoration, recovery snapshots, and best-effort recovery outcomes.
- `extensions/swe-replay/normalization-policy.ts`: shared compatibility contract
  for normalization producers, parsers, and voting.
- `extensions/swe-replay/patch-normalization.ts`: complete-tree mixed-file grouping.
- `extensions/swe-replay/python-normalization.ts`, `python-normalization-worker.mjs`,
  and `agentless-normalization.py`: offline Pyodide lifecycle, Python source
  transformations, and disposable normalized Git diffs. The worker and Python
  source are required runtime assets.
- `extensions/swe-replay/visualization-model.ts` and `ui/`: read-only projection
  and dashboard. Detailed final votes, winner markers, generation completion, and
  regression outcomes are not displayed.
- `tests/`: Node.js tests and session fixtures, loaded through `jiti`.
- `tsconfig.json`: strict TypeScript, ES2022, NodeNext resolution, no output.
- `README.md`: commands, selection semantics, workspace safety, and checks.
- `tests/reference/agentless/` and normalization fixtures: pinned reference
  provenance and development oracle; regenerating fixtures is a separate check.
- `THIRD_PARTY_NOTICES.md` and `licenses/`: Agentless/Pyodide/CPython notices.
- `docs/`: local design/status notes, ignored by Git. Verify them against current
  implementation rather than assuming every proposal is implemented. The local
  `docs/swe-replay-implementation-status.md` records end-to-end verification work.
- `experiments/`: local research probes, ignored by Git and not runtime code.

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
and replaces workspace files. Load the extension from its actual path when
running Pi in a separate fixture repository. Automated tests do not establish
provider compatibility; live end-to-end verification remains the next milestone.

Check arguments, command input/cancellation, baseline failure, settlement cleanup,
and branch isolation. Explicitly observe successful exploitation, not only
exploration or fallback: verify pre-step files/context, retained preceding tool
results, and provider acceptance of the empty continuation message. Exercise
regression filtering, no-winner outcomes, aborted/inconclusive runs, and an earlier
archived winner's workspace/index and conversation restoration. Verify a subsequent
agent turn uses the selected trajectory. Check changed-HEAD and ignored-file
refusals, navigation cancellation, and recovery evidence without risking real work.

The regression command must already pass on the baseline. Keep an initially
failing bug-reproduction test separate and use it afterward to assess task success.
Ignored dependencies are not copied into worktrees; include needed setup. Node
tests use bundled Pyodide without host Python or runtime network access.

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
- Keep unknown-data payload parsing separate from run ownership, ancestry, and
  cross-record validation. Keep iteration assessment separate from vote aggregation.
  Do not duplicate completion or normalization-compatibility policies in callers.
- Update README when changing commands, selection semantics, or setup.
- Keep changes focused; do not edit `node_modules` or commit generated artifacts.

## Session state and workspace safety

Persisted custom entry types:
- `swe-replay-root`: prompt, iteration count, test command, timeout, and cwd.
- `swe-replay-base`: frozen execution contract, initial snapshot, and content tree.
- `swe-replay-candidate`: completed iteration snapshot and post-trajectory context
  anchor, persisted before regression evaluation.
- `swe-replay-evaluation`: baseline/candidate outcome, explicit candidate association
  (except baseline), frozen execution contract, and bounded evidence.
- `swe-replay-patch-identity`: retained candidate content tree, normalized grouping
  hash, policy provenance, and fallback diagnostics.
- `swe-replay-final-selection`: groups, votes, exclusions, ties, and selected
  representative or explicit no-winner result.
- `swe-replay-restoration`: started/restored/failed attempts, selection/candidate
  associations, backup identity, and recovery outcomes.
- `swe-replay-finalization-error`: archive, normalization, or selection failure
  without declaring a completed selection.
- `swe-replay-exploit-log`: selection, candidate membership, and trace.
- `swe-replay-turn-files`: `rootEntryId`, `iteration`, `turnIndex`,
  `messageEntryId`, and cumulative `files`.
- `swe-replay-workspace`: root/completed-step snapshot OID and retaining ref.
- `swe-replay-workspace-backup`: recovery snapshot before restoration.
- `swe-replay-step-boundary`: pre-assistant navigation anchor.

Consider existing persisted sessions when changing shapes. Malformed decisions
remain visible as `unknown` with diagnostics. Missing, invalid, or unsupported
traces have unavailable probabilities; historical schemas are not automatically
migrated. Final selection requires explicit v1 archive associations; do not infer
missing candidates from leaves or retrospectively select legacy runs. File-access
snapshots are not file-content backups.

`/inspect-session` only shows the active branch. After restoring an archived
winner, the final-selection entry can remain on the last iteration's archived
branch; the active restoration record references it by `selectionEntryId`. Inspect
the full session JSONL for cross-branch evidence; the dashboard does not yet show
final outcomes.

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
