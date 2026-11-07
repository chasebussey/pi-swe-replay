# TSC policy input corpus

These repository fixtures preserve the reviewed research inputs independently of
Git-ignored `docs/` and `experiments/`. They contain **desired policy outcomes**, not
canonical outputs captured from a prototype. No production TSC backend exists yet.

P0 contract: [CONTRACT.md](CONTRACT.md) (behavior/API/persistence/gates) and
[contract.json](contract.json) (explicit choices, versions and asset pins). These
are implementation specifications, not claims of runtime support.

- `source-pairs.json`: 71 source comparisons (27 original, 44 supplemental).
- `helper-pairs.json`: 20 historical helper comparisons plus 16 mixed-edit cases
  implementing the user's D8-B decision below.
- `provenance.json`: promotion/source artifact hashes and original input counts.

Valid UTF-8 sources are stored as readable text; invalid UTF-8 uses base64. Each
source carries an encoding tag and SHA-256 checksum to preserve NUL, CRLF, BOM,
and final-newline distinctions. Fixtures are parse inputs only;
**never execute them**. Some intentionally contain malformed syntax, type errors,
unresolved names, unreachable code, or observable ordering differences.

The source corpus tests ordinary canonicalization: `equivalent`, `different`, or
`fallback-required`. D5 resolves the BOM case to `different`: parse after the
leading encoding marker but retain its presence in identity. The case keeps
`historicalExpected: "characterize"` for audit; original bytes are unchanged.
Required fallbacks compare exact bytes on both sides, rather than treating
recovered parses as authoritative. Worker/resource
failures are fatal, not source-level fallback; lifecycle tests belong elsewhere.

Literal spelling, optional punctuation, and existing statement order are protected
by the selected conservative syntax policy. Comments and contextual docstrings
are deliberately ignored even when they affect tooling or observable behavior.
`acceptedOrderingRisk` identifies helper cases intentionally grouped despite a
possible binding/decorator-order effect. None of this proves semantic equivalence.

## D8-B: residual edits plus added helpers

For a fixed baseline and file, compare both:

1. The canonical residual edits after subtracting recognized newly added helpers.
2. The sorted collection of added helper names and full canonical declarations.

Residual edits **need not equal the baseline**, but they must agree between
candidates. Identical caller/global edits can group with identical helpers at
different locations; different residual edits or helper contents must not group.
The same removed-existing-function edit is also retained in residual identity.
Existing declarations are not reordered. Empty helper collections must use
consistent framing rather than an arbitrary alternative key mode.

Subtract nodes from the original parsed tree, retaining original comment/docstring
classification. Do not rewrite/reparse sources and accidentally promote ordinary
strings into docstrings. Unsupported forms remain ordered residual code; duplicate
function declarations require the defined conservative extraction guard.

The historical 20 cases were originally probed under a pure-addition shortcut.
Their pairwise desired results still hold under D8-B: their differing residual
edits remain distinct. The **16 new cases have not been run against a TSC backend**;
they are expected behavior for implementation, not evidence of implemented support.

## Tests and provenance

`tests/tsc-fixtures.test.mjs` validates fixture shape, bytes, checksums, IDs,
coverage, and decision examples, including the explicit P0 contract and deferred
enablement gates. It does not normalize candidate code or establish backend
correctness. Future TSC behavior tests should consume these same files.

Research paths in `origin`/`sourceArtifacts` are provenance strings only. Tests and
runtime must not import/read those ignored locations. No external downloads,
generated canonical snapshots, or scratch dependencies are needed to load this
corpus. The one-time promotion script remains ignored, not a runtime dependency.
