# TSC v1 implementation contract (P0)

This is a specification for future production implementation, **not runtime support**.
Machine-readable choices/pins: `contract.json`. Test inputs: `source-pairs.json`
and `helper-pairs.json`. No generated canonical hashes serve as correctness oracles.
The runtime compatibility owner will remain `normalization-policy.ts`, not these
fixtures or any ignored research directory.

## Canonicalization and framing

Use the versions/pins in contract.json. Preserve node types, field names, anonymous
meaningful tokens, child order, identifier text, and literal spelling. Ignore
incidental source gaps, comments and only contextual Python docstrings. Classify
original nodes before filtering/helper subtraction. Never reparse rewritten source
or repeatedly remove leading strings and promote ordinary expressions to docstrings.

Use fixed-position tagged JSON arrays, UTF-8 encoding, SHA-256, no pretty printing
or appended newline, and no object-key-order dependence:

- `["token", nodeType, exactSourceText]` for genuine terminals.
- `["node", nodeType, [[fieldNameOrNull, child], ...]]` for containers, including
  roots/containers left empty after filtering.
- `["fragment", fragmentKind, exactSourceText]` for protected literal fragments
  inside literal nodes. Preserve delimiter/prefix/escape tokens; canonicalize
  embedded expressions as ordinary children. Preserve the source prefix displayed
  by Python debug interpolation, conversions/specifications, tagged-template raw
  text, and significant literal whitespace. No unparse or generic line cleanup.
- `["source", "utf8" | "utf8-bom", canonicalRoot]` for parsed source identity.
- `[name, canonicalFullDeclaration]` for each extracted helper, preserving wrappers.
- `["canonical", baselineSourceEnvelope, residualCandidateSourceEnvelope,
  sortedAddedHelpers]` for a canonical file-content identity, including zero helpers.

Complete-tree frame: `[policy, fixedPositionProvenance, baseTreeOid,
byteSortedFileComponents]`. Provenance expands the six identity labels in
contract.json order (policy, canonicalization, helpers, registry, sourceFallback,
framing), then runtime package/version/hash, then language-ordered grammar tuples
(Python then TypeScript, each language/package/version/hash). Keep the provenance
structure explicit in persisted payloads; fixed arrays define hashing only.

Per-path components retain raw path base64, before/after mode or null, and tagged
canonical/exact content. Exact content retains bytes or unsupported object identity.
Existence differs from empty content. Sort paths by raw bytes and helper tuples by
UTF-8 bytes of their JSON representation; never sort existing declarations.
Only omit unchanged canonical content; exact metadata/encoding-marker changes
remain. Distinguish rawEmpty from normalizationEmpty; neither can vote.
Normalization cannot edit sources or supply workspace restoration data.

## D8-B: newly added helpers plus residual edits

For a frozen baseline and file, identify new supported declaration names. Subtract
only those original declaration subtrees. Compare both the remaining candidate
residual relative to the baseline and the sorted helper collection. The residual
need not equal baseline, but must agree between candidates. Preserve different
caller/global/removal edits. Same existing-function removals can group when the
residuals and helpers agree. No pure-addition restriction remains.

Use identical framing with an empty helper collection, not a separate mode.
Top-level function duplicate names in either source disable extraction for that
file. Count named no-body/unsupported function declarations when reserving names
and checking duplicates. Other unsupported helper forms remain ordered residual
code; they do not disable extraction of independent supported helpers.

Recognize top-level named concrete functions with bodies: Python ordinary/async/
generator functions with attached decorators, and TypeScript ordinary/async/
generator functions with named non-default export wrappers. Keep existing named
functions in residual code even when modified. Methods, nested functions, arrows,
anonymous/default-export functions and no-body/ambient declarations are not
extracted in v1. No overload resolution or semantic variable-binding guard.
Binding/decorator order can still matter; that is an accepted heuristic risk,
not something compilation necessarily catches. Regression commands must include
compilation if desired; no new automatic test/compilation gate is introduced.

## Language and encoding scope

Case-sensitive raw suffixes: `.py` -> Python 0.25.0; `.ts` -> TypeScript 0.23.2.
This includes `.d.ts` under ordinary TypeScript; no-body declarations remain
residual code. `.pyi`, `.mts`, `.cts`, `.tsx`, `.js`, `.jsx`, uppercase suffixes and
unknown files use exact handling, not inferred grammar compatibility. Preserve raw
path bytes even if a path cannot be decoded as UTF-8.

Strict UTF-8 with exactly one leading BOM recognized as an encoding marker. Parse
after it, but retain marker presence in the source envelope: adding/removing a BOM
is different. Never strip U+FEFF globally, CR or final newlines. Preserve literal
contents. Invalid UTF-8, NUL/binary, symlinks and unsupported kinds compare exact
original content and metadata. ERROR or MISSING recovery on either side triggers
paired exact source comparison and bounded diagnostics, before filtering.

An identical-byte shortcut is not evidence of successful parsing. Source errors
are not infrastructure failures. Missing/corrupt WASM, parser/runtime exceptions,
worker failure, timeout, resource-limit breach or cancellation fail/cancel the
whole batch; no partial votes or fallback-to-another-backend behavior.

## Frozen run choice, persistence and compatibility

Per-run choices `agentless` and `tsc`, initial default `agentless`. Collect choice
and required regression input before run/controller/workspace mutation. Cancel
any input without creating a run or sending prompts. No model instruction change
or persistent preference in v1. Pass immutable resolved options, not multiple
layer-specific default policies.

New runs for either backend use schema v2 root/base/identity/final-selection
records. Candidate/evaluation/restoration payloads stay schema v1 if unchanged.
Use record-specific envelope parsing, not a blanket schema switch.

Roots/bases capture identical `normalizationContract`:

```typescript
type FrozenNormalizationContract =
  | { schemaVersion: 1; backend: "agentless"; provenance: AgentlessProvenance }
  | { schemaVersion: 1; backend: "tsc"; provenance: TscProvenance };
```

These are proposed types, not existing exports. Preserve Agentless's current
complete-tree/Python provenance values. TSC provenance contains its six labels
and pinned runtime/grammar assets. Identity v2 data retains tree/hash/empty fields
and bounded diagnostics with a nested provenance discriminant. Final-selection v2
records capture the same contract; derive/validate decision equivalence label from
it. Validate contract/provenance associations separately from payload shapes.

Capture limits/deadline in separate `normalizationExecution`, requiring root/base
agreement and validation before generation. Limits affect whether normalization
can finish, not successful identity bytes. Preserve one completed passing nonempty
iteration per vote, plurality, earliest tie/representative, no-winner, completion
checks, original-snapshot/index restoration and selection-before-restoration.

Read supported captured v1 Agentless data through explicit legacy parsers. Do not
infer modern contracts, migrate keys, retest, regenerate groups, automatically
finalize old runs or reinterpret unsupported records. Historical captured read
support is distinct from new-run finalization capability.

## Deployment and unfulfilled implementation gates

Use the exact dependency/asset pins in contract.json; hashes were checked against
research assets during P0. Resolve installed package assets, never cwd/experiments.
Ship trusted worker/adapter runtime code with the package; block runtime network.
The runtime uses WASM, not native grammar bindings or host Python/compiler.

The grammar packages have `node-gyp-build` install hooks, and the TypeScript
package depends on tree-sitter-javascript. Research used --ignore-scripts and did
not validate ordinary installation. P2/P6 must test supported install targets and
disclose install-time requirements or explicitly revise asset distribution before
enabling the backend; no universal script-free-install claim. Retain MIT notices
(Max Brunsfeld: runtime 2018, Python 2016, TypeScript 2017) and audit transitive
artifacts. Verify package contents and installed-location offline loading.

One disposable worker per batch and 60000 ms default end-to-end deadline. Before
enablement P2 must measure/freeze finite per-file/batch/unique-source bytes,
candidate/file count, node count, traversal depth, canonical output/message bytes
and diagnostic limits. Test boundaries, cleanup, abort and hard failures. These
numeric caps are intentionally not fabricated in P0: `resource-profile` remains
an explicit blocking implementation gate. Worker/WASM is not a security sandbox
or hard memory cap; post-parse node checks do not bound parser peak memory.

P1 must implement/test interpolation adapters; P2 must validate the resource
profile; P2/P6 must validate packaging/offline loading and grammar install hooks.
Completing P0 does not satisfy any of those gates or enable automatic TSC voting.
