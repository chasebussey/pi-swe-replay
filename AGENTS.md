# Agent guidance

## Project overview

`pi-swe-replay` is a TypeScript extension package for the Pi coding agent.
It is intended to provide an implementation of SWE-Replay from within a coding agent session.

Registered commands:
- `/swe-replay <n> <prompt>` starts a replay run requesting a positive number of patches.
- `/inspect-session` displays SWE-Replay entries on the active session branch.

## Product direction

Follow [SWE-Replay v2](https://arxiv.org/html/2601.22129v2), particularly
§§2.1–2.3 and Algorithm 1, for the replay and step-selection design below. This
is intended behavior; exploitation and patch evaluation are not yet implemented.

- Repeat `n` times, generating one patch per iteration and maintaining an archive
  of sampled trajectories.
- The first iteration always explores to initialize the archive. For subsequent
  iterations, choose exploration versus exploitation with an independent
  Bernoulli trial, initially with `p = 0.5` for exploration (and `1 - p = 0.5`
  for exploitation). This probability may change as future directions are explored.
- **Explore:** generate a new trajectory from the session root.
- **Exploit:** select a candidate step from archived trajectories, restore the
  context and workspace state immediately before that step, then generate a
  replacement step and continue along a new branch. Do not resume after the
  selected step.

### Candidate selection during exploitation

Softmax selection applies to exploitation, not fresh-from-root exploration.

1. The paper filters out trajectories whose final patches introduce regression
   test failures before selecting steps (§2.1.1).
2. Group steps by their file exploration state: the repository files explored
   **before** the step. Represent this as a sorted, deduplicated list of file
   names, preserving the paper's set semantics rather than file visitation order.
   Steps with no previously explored files are skipped (Figure 3).
3. Sample a state using softmax over inverse group size (§2.1.2):
   `P(state_i) = exp(1 / v_i) / sum_j exp(1 / v_j)`, where `v_i` is the number of
   concrete steps in that state across eligible archived trajectories. This
   favors states reached by fewer steps, not individual rarely accessed files.
4. Within the selected state, sample a concrete step using softmax over reasoning
   paragraph count (§2.1.3):
   `P(step_ik | state_i) = exp(l_ik) / sum_j exp(l_ij)`, where `l_ik` is the number
   of reasoning paragraphs for that step. Use paragraph count, not token count
   or raw reasoning length.

When implementing selection, distinguish the current end-of-turn file snapshots
from the required state **before** a candidate step; do not include that step's
own file accesses in its grouping key.

## Repository map

- `extensions/index.ts`: extension entry point and slash-command registration.
- `extensions/swe-replay/run.ts`: argument parsing, replay orchestration, navigation,
  and waiting for agent settlement. Exploitation and patch evaluation are unfinished.
- `extensions/swe-replay/track-turn-files.ts`: branch-aware tracking of successful
  `read`, `write`, and `edit` tool accesses, persisted as custom session entries.
- `tsconfig.json`: strict TypeScript, ES2022, NodeNext resolution, no emitted output.
- `package.json` / `package-lock.json`: npm dependencies and package metadata.
- `README.md`: local usage instructions; currently describes only `/greet` and is
  incomplete relative to the implementation.

## Setup and checks

Use npm and preserve the lockfile when changing dependencies.

```bash
npm ci
npx --no-install tsc --noEmit
```

The type check passes at initialization of this document. There are currently no
package scripts, automated tests, or configured lint/format commands. Do not claim
tests passed when only the type check was run.

For interactive smoke testing, the README documents:

```bash
pi --extension ./extensions/index.ts
```

Run replay smoke tests in a disposable repository/session: replay sends real agent
prompts and navigates session history. Check valid/invalid command arguments,
settlement handling, branch isolation, and persisted file entries when relevant.

## Implementation conventions

- Follow existing TypeScript style: two-space indentation, double quotes, named
  exports for helpers, and type-only imports for Pi interfaces.
- Keep command registration/UI concerns in `extensions/index.ts`; keep replay
  orchestration and tracking in the `extensions/swe-replay/` modules.
- Consult documentation/types for the installed Pi version before changing API
  usage; do not assume another version's event or navigation semantics.
- Register settlement listeners before sending prompts. Preserve listener cleanup
  in `finally` blocks and the cleanup function returned by `trackTurnFiles`.
- Preserve replay-run and active-branch isolation. File tracking is cumulative
  within a branch, ignores failed tool calls, normalizes paths to absolute paths,
  and stores sorted snapshots.
- Update the README when changing public commands or setup instructions.
- Keep changes focused; do not edit `node_modules` or commit generated artifacts.

## Session state and workspace safety

Current custom entry types are `swe-replay-root`, `swe-replay-exploit-log`, and
`swe-replay-turn-files`. File snapshots contain `rootEntryId`, `iteration`,
`turnIndex`, `messageEntryId`, and `files`. Consider existing persisted sessions
when changing these names or shapes.

The comment in `run.ts` describes a proposed Git-stash snapshot/restore model;
that restoration behavior is not implemented. File-access tracking is not a
workspace backup and does not capture file contents or arbitrary shell changes.
Do not introduce destructive Git operations or overwrite pre-existing user work
as an incidental part of replay implementation.

## Collaboration and completion

Before editing, inspect relevant files and the working-tree status. Preserve
unrelated user changes. After editing, run the type check and any relevant tests;
report what changed, validation results, and remaining limitations.
