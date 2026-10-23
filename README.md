# pi-swe-replay

A [Pi coding agent](https://github.com/earendil-works/pi) extension for trying multiple approaches to the same coding task.

The extension implements exploration, exploitation, and regression-filtered final patch voting from [SWE-Replay](https://arxiv.org/html/2601.22129v2).

**This is experimental.** Candidate snapshots are validated with a user-provided regression command. A completed run selects a patch by plurality and automatically restores its workspace and conversation. Patch artifact export is not exposed yet. Use a disposable repository and session: replay sends real agent prompts and replaces workspace files when switching trajectories.

## Getting started

```bash
npm ci
pi --extension ./extensions/index.ts
```

Then start a run:

```text
/swe-replay 5 Fix the bug described in issue 123
```

Pi asks for a **regression test command**, such as `npm ci && npm test`. A nonempty command is required; cancelling the dialog starts no run. UI input is currently required (interactive Pi or a compatible RPC client).

The command runs first against the initial snapshot, which must pass, then against every completed trajectory. Each evaluation uses a fresh disposable Git worktree, with a ten-minute timeout, from the equivalent working directory. Ignored dependencies such as `node_modules` are **not copied**: include setup in your command or use a repository script. Commands execute through `bash -lc` and must propagate test failures.

This runs five iterations. Each iteration generates a trajectory (roughly a session branch). Failed validation excludes a trajectory's unique steps from exploitation; shared prefixes remain eligible if they also belong to a passing trajectory. Timeouts or execution errors stop replay as inconclusive. Evaluation output is persisted outside model context, accessible through `/inspect-session`, not sent to the coding agent.

Worktrees share Git metadata and OS permissions: this is not a security sandbox. Use a trusted command that does not mutate shared refs, the original checkout, or external resources. After all requested iterations finish, the selected representative is restored automatically. If no passing, nonempty patch qualifies, the last generated workspace and conversation remain active. See [the validation design](docs/regression-validation-design.md) for the full contract and limitations.

### Commands

| Command | What it does |
|---|---|
| `/swe-replay <n> <prompt>` | Runs `n` iterations, validates and votes on completed patches, then restores the selected workspace and conversation. |
| `/swe-replay-view` | Opens the replay dashboard across active and archived branches. Outside TUI mode, prints a summary. |
| `/inspect-session` | Dumps persisted SWE-Replay entries on the active session branch. |

`n` controls iterations, not distinct patches. Repeated equivalent passing outcomes contribute repeated votes. There is no patch export command yet.

## How replay works

The first iteration always **explores**: it sends your prompt from the replay root.

Each later iteration independently chooses, with equal probability, between:

- **Explore:** restore the initial workspace, return to the replay root, and send the original prompt again.
- **Exploit:** choose an earlier assistant step, restore the conversation and workspace immediately before it, and generate an alternative continuation.

For example, if the first trajectory is:

```text
prompt → A → B → C
```

Exploiting step B produces a branch like:

```text
prompt → A → B′ → …
```

The original B and C remain archived. The new trajectory does not see B’s reasoning, tool calls, or results.

Continuation is triggered with a hidden, empty custom message. Pi includes it in model context as an empty user-role message; it adds no textual instruction. Empty-message handling may vary between providers.

If exploitation finds no eligible steps, that iteration falls back to exploration.

## Final patch selection and restoration

After **all requested iterations finish**, the extension reuses their captured
regression results—there is no automatic retesting. One passing completed iteration
contributes one vote, including repeated equivalent outcomes. Failed, unevaluated,
inconclusive, raw-empty, and normalization-empty patches cannot vote; the baseline
is not a voter. Exploitation multiplicities and reasoning scores do not affect this
final vote.

Patches are measured against the **initial workspace**, not `HEAD`, so preexisting
staged, unstaged, and nonignored untracked user work is not mistakenly counted as
the agent's patch. Equivalence uses the pinned Agentless-derived Python heuristic
and exact-content handling for other file kinds, with mode/existence preservation.
Comment/docstring-only Python changes can normalize away; this is a voting
heuristic, not proof of semantic equivalence or task correctness.

The largest group wins by **plurality**, without needing over 50% of votes. Ties
and representative selection favor the earliest passing iteration. The completion
notification reports that iteration, votes, eligible count, and any tie.

Selection is persisted before restoration. A recovery snapshot is then retained,
and Pi navigates to the representative's completed candidate entry **without a
branch summary**. Only after navigation is verified does the extension restore
that candidate's **original snapshot**, including index state. It does not apply
normalized Python source or grouping keys. The next agent turn therefore sees the
selected trajectory's conversation and workspace, not the last iteration's context.

No eligible winner means an explicit no-winner result and no final restoration.
Interrupted, aborted, errored, or inconclusive runs do not make an automatic final
selection. Normalization infrastructure errors also stop finalization without
partial voting results. Older sessions without the new associations are not
retrospectively selected or migrated.

Restoration can fail independently of selection—for example, if navigation is
cancelled, `HEAD` changes, or ignored files obstruct restoration. Such failures
are recorded separately and reported as errors, not successful completion. After
a file mutation failure, recovery of the pre-restoration workspace and conversation
is best-effort; recovery failure remains explicit and the backup is retained.
Do not create commits, run another agent, or edit files concurrently with replay.
Patch artifact export and detailed dashboard outcome presentation remain separate
future work.

## Reading the dashboard

Open `/swe-replay-view` to inspect a run. The dashboard is read-only: selecting a step does not navigate the session or restore files. Reopen it to refresh.

### Trajectories

This view is a **tree of assistant steps**, not one row per iteration. A trajectory is a path through the tree.

A row looks like:

```text
└─ * abc123 #2 f:5 r:3 ← selected
```

| Marker | Meaning |
|---|---|
| Indentation | The step follows the nearest recorded assistant ancestor. Equally indented children of the same parent are alternatives. |
| `*` | The step belongs to the currently active session branch. |
| `abc123` | The assistant message’s session-entry ID. |
| `#2` | The iteration that recorded the step—not its position in the trajectory. |
| `f:5` | Five distinct files had been explored before the step. |
| `r:3` | The response contains three visible reasoning paragraphs. |
| `← selected` | An exploitation decision chose this step as a replacement target. |

Select a step to see its parent, pre-step file set, and the iterations that selected it. Press `r` to reveal its message text and visible reasoning.

**“Selected in: none” does not mean exploration.** It means the step has never been chosen as a replacement target. Steps generated by either exploration or exploitation can have this label.

After successful final restoration the active branch is the selected representative, not necessarily a correct solution. No dashboard marker currently shows final vote groups or regression outcomes; its selection markers still describe exploitation choices.

### Decisions

This view lists **exploitation choices**, including choices that fell back to exploration. Ordinary exploration choices do not get decision rows.

The `#` number is the replay iteration. For example, `#14` means “iteration 14,” not “the fourteenth exploitation decision.”

Decision labels mean:

- **`step-selected`:** exploitation selected a replacement target.
- **`explore-fallback`:** exploitation found no eligible target and fell back to exploration.
- **`unknown`:** the available record does not establish the selection outcome.

A selection record does not prove that restoration or generation completed. Completion and regression evaluation outcomes are not displayed by this view yet.

The details show the probabilities recorded when selection happened:

- **`P(state)`** is the probability of choosing a file-exploration state after exploitation was chosen.
- **`P(step | state)`** is the probability of choosing a particular step within that state.

Neither is the probability of choosing exploration versus exploitation. Details also show each candidate’s multiplicity and each state’s total trajectory occurrences at selection time. Missing, invalid, or unsupported selection traces show probabilities as unavailable; the viewer does not reconstruct them.

Current traces use candidate objects containing `stepId` and `multiplicity`, policy version `1`, and eligibility policy `passed-trajectory-occurrences`. The parser validates that eligibility label rather than reinterpreting traces recorded under another policy. Historical trace schemas are not automatically migrated.

### Controls

| Key | Action |
|---|---|
| Tab | Switch Runs / Trajectories / Decisions |
| ↑ / ↓ | Select a row, or scroll when details are focused |
| Enter | Open a run or toggle detail focus |
| ← / → | Leave or enter detail focus |
| PgUp / PgDn | Scroll details |
| `r` | Reveal or hide a step’s message and visible reasoning |
| Escape | Leave detail focus or close |

The Runs view also shows diagnostics for missing or malformed records. Older runs may show prompt and requested-iteration metadata as `unknown`; new runs persist those fields.

## How exploitation selects a step

Selection happens in two stages.

First, completed steps on passing trajectories are grouped by the set of repository files explored **before** each step. Paths are absolute, sorted, and deduplicated. Steps with an empty pre-step file set are excluded. Each unique assistant step has a **multiplicity**: the number of passing archived trajectories containing it.

A file-state group is sampled using softmax over inverse group size:

```text
P(stateᵢ) ∝ exp(1 / sum of candidate multiplicities in stateᵢ)
```

This favors states with fewer step occurrences across passing trajectories. A shared step counts once per passing trajectory containing it, while remaining a single candidate in the session tree.

Within that group, a unique step is sampled using multiplicity-weighted softmax over its visible reasoning paragraph count:

```text
P(step | state) ∝ multiplicity × exp(reasoning paragraph count)
```

Reasoning paragraphs are separated by blank lines and counted across thinking blocks. Ordinary assistant text, tool calls, and redacted reasoning do not contribute. A valid response without visible reasoning scores zero. Equal scores produce probabilities proportional to multiplicity; they are uniform over unique steps only when multiplicities are equal.

These are sampling weights, not quality scores. For new runs, only steps on at least one passing trajectory are eligible. Filtering happens before group sizes and sampling probabilities are computed. A passing baseline is required; nonzero candidate exits fail the user's validation gate, but do not independently prove a test regression.

### File-access tracking

Successful `read`, `write`, and `edit` calls contribute to a branch’s cumulative file-exploration set. Failed calls and shell-based file accesses do not.

A step’s grouping key excludes its own accesses, and sibling branches do not inherit each other’s file sets. Repeated snapshots of the same assistant step do not create extra candidates or increase its multiplicity. Multiplicity comes from passing terminal paths, not snapshot count; failed trajectories add no weight.

## Workspace snapshots and safety

Replay requires a Git repository with an existing HEAD, no submodules, and no unresolved index conflicts.

At the replay root and after each agent turn, the extension captures a stash-compatible snapshot containing:

- Staged changes.
- Tracked working-tree changes.
- Untracked files, excluding ignored files.

Capture uses temporary indexes and leaves workspace files unchanged. Snapshots are retained under `refs/swe-replay/*`, separate from your normal stash list.

### Restoring a snapshot replaces files

Restoration uses:

```text
git reset --hard HEAD
git clean -fd
git stash apply --index <snapshot>
```

This replaces current tracked and untracked state, including removing non-ignored files created after the snapshot. A recovery snapshot is retained before each restore.

Restoration refuses if HEAD has changed or ignored files would obstruct it. Git errors stop replay, but a failed apply can leave a partially restored workspace. The recovery snapshot remains available.

Avoid concurrent external edits while replay is running.

### What snapshots do not restore

Snapshots only cover the captured Git state. They do not undo:

- Package installs into ignored directories such as `node_modules`.
- Global installs or environment changes.
- Changes outside the repository.
- Ignored-file contents or nested repository state.
- Other side effects such as services started by the agent.

Tracked changes caused by these actions, such as lockfile updates, are captured.

### Retention and recovery

Snapshot OIDs and retaining refs are stored in session entries. You can inspect a snapshot with:

```bash
git show <oid>
```

Or apply it in a suitable clean workspace:

```bash
git stash apply --index <oid>
```

Snapshots survive Git garbage collection and are not automatically deleted. Remove their `refs/swe-replay/*` refs manually when the associated sessions and recovery snapshots are no longer needed.

Older trajectories without workspace snapshots cannot be restored.

## Implementation notes

Replay state is persisted in custom session entries:

| Entry | Purpose |
|---|---|
| `swe-replay-root` | Identifies a replay run and freezes its prompt, iteration count, test command, timeout, and working directory. |
| `swe-replay-base` | Retains the initial snapshot/content tree and frozen execution contract for final selection. |
| `swe-replay-candidate` | Persists a completed iteration's snapshot and post-trajectory context anchor before evaluation. |
| `swe-replay-evaluation` | Records validation, explicit candidate association (except baseline), frozen execution contract, and bounded evidence. |
| `swe-replay-patch-identity` | Associates a candidate with its retained complete tree, normalized hash, policy provenance, and diagnostics. |
| `swe-replay-final-selection` | Captures groups, votes, exclusions, ties, and the selected representative or explicit no-winner result. |
| `swe-replay-restoration` | Records a started/restored/failed winner-restoration attempt, backup identity, and recovery outcomes. |
| `swe-replay-finalization-error` | Records an archive, normalization, or selection failure without declaring a completed selection. |
| `swe-replay-turn-files` | Records cumulative file accesses after a turn. |
| `swe-replay-workspace` | Maps a completed step—or the initial root—to a workspace snapshot. |
| `swe-replay-workspace-backup` | Retains the current workspace before restoration. |
| `swe-replay-exploit-log` | Records exploitation selection, candidate groups, and probabilities. |
| `swe-replay-step-boundary` | Provides a navigation anchor before an assistant step. |

The empty continuation trigger is a `swe-replay-continue` custom message. Step-boundary entries let future navigation retain that message: Pi otherwise navigates before user and custom messages.

`/inspect-session` only shows entries on the active branch. The dashboard shows
exploitation records across archived branches, but does not yet display final
selection details. After restoring an archived winner, the final-selection entry
can remain on the final iteration's archived branch; the active restoration record
references it by `selectionEntryId`. All records remain in the session JSONL.

## Checks

```bash
npx --no-install tsc --noEmit
node --test tests/*.test.mjs
```

Tests use Node.js’s built-in test runner and `jiti`, without emitting build artifacts. Tests do not establish provider compatibility; use a disposable repository/session for live smoke testing.

Final selection uses complete-snapshot content trees and retains binary-safe,
initial-workspace-relative patch export helpers. Selection/restoration are integrated
into replay; the export helper is not yet exposed as a command. Snapshot trees include nonignored
untracked files and are retained under `refs/swe-replay/trees/*`.

Python normalization now uses **Pyodide's bundled CPython/WASM**, not a system
Python installation. The internal batch normalizer starts an offline worker only
when called and terminates it after the source transformations, including on
error or cancellation. It generates normalized diffs in disposable repositories,
without modifying or executing candidate source. The pinned Pyodide dependency
adds roughly 13 MiB installed; interpreter startup has a substantial temporary
memory cost. See [third-party notices](THIRD_PARTY_NOTICES.md).

The [Agentless normalization reference](tests/reference/agentless/README.md)
pins upstream provenance. Node tests run the bundled interpreter and require no
system Python or network access; regenerating the original reference corpus is
a separate development check. Under policy `agentless-python-pyodide-v2`, the
Python primitive matches all 22 successful captured Agentless outputs. Python
parsing errors (including indentation/tab errors) instead use the file's exact
original content on both sides, with recorded diagnostics. Other files still
normalize normally. Runtime, resource, and infrastructure failures remain hard
errors. Fallback keys are grouping data, never exported patches.

The internal complete-tree adapter now batches Python normalization and combines
it with lossless exact-content handling for other files, binary/invalid-UTF-8
content, symlinks, and unsupported file kinds. Policy
`complete-tree-agentless-mixed-v1` sorts raw Git path bytes, preserves existence
and executable-mode changes, frames components with domain-tagged JSON, and
captures SHA-256 grouping hashes plus Python provenance and diagnostics. Raw-empty
and normalization-empty patches remain distinct. Its one-minute default deadline
covers immutable Git reads, interpreter startup, and normalization; failures reject
the entire batch. This adapter does not modify the checkout.

The internal pure voter in `extensions/swe-replay/final-selection.ts` implements
`passing-candidate-occurrences-v1`: one vote per regression-passing, nonempty
completed iteration. It validates snapshot, evaluation, frozen command, and
normalization-policy associations; duplicates cannot add votes, and conflicting
records exclude the affected occurrence with diagnostics. The largest group wins
(plurality, not necessarily over 50%), with ties and representatives resolved by
earliest passing iteration. No eligible candidates produces an explicit no-winner
result. Decisions capture groups, votes, exclusions, and ties without rerunning
normalization, tests, or sampling. These are typed internal inputs, not a parser
or migration for historical session records. `replay-records.ts` separately parses
explicit v1 archive associations across all branches. `finalize-run.ts` performs
one normalization batch after completion and persists the decision;
`restore-winner.ts` then restores the representative and aligns conversation.
Commands report the result, but detailed dashboard outcome UI and explicit artifact
export remain unimplemented.
