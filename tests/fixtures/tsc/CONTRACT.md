# TSC v1 implementation contract (P0)

This specifies the implementation contract, **not selectable TSC voting support**.
P2 source-level batching/worker support is implemented; helper/complete-tree/record
integration remains future work.
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
  text, and significant literal whitespace. Python 3.14 template-string interpolation
  expression source is observable metadata even without debug `=` and is protected
  too; only ordinary f-string/template embedded-code trivia is incidental. No
  unparse or generic line cleanup.
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
Additional/nonleading U+FEFF ignored by a grammar outside protected text requests
explicit `unsupported-trivia` exact handling rather than disappearing. U+FEFF in
literal/format fragments remains exact content. TypeScript comment classification
includes its pinned grammar's comment, hash_bang_line and html_comment kinds;
no generic isExtra filter may erase other syntax.

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

Use the exact asset pins in contract.json. Runtime JavaScript/WASM comes from the
pinned web-tree-sitter package. **User decision D7-R2 supersedes D7-R1's proposed
bundling and the P0 grammar-npm distribution assumption:** acquire grammars only
from pinned standalone releases in approved repositories under the GitHub
`tree-sitter` organization. No aggregator, mirror, configurable URL or `latest`.
Repository, tag, asset name, exact size and SHA-256 are explicit registry data.
The Python/TypeScript upstream files have the same bytes as the P1-tested assets.

Provision in the host before offline normalization; this phase may use the network,
not the worker. Cache by SHA-256 in the user cache by default (explicit directory
overrides exist for controlled hosting/tests), verify reads, download into
unique private temporary files, validate size/hash, then atomically install. Allow
only checked HTTPS redirects to GitHub release-asset CDN hosts. Never persist
signed CDN query strings. A supported grammar's acquisition failure is fatal, not
a source fallback. Unsupported-language file handling remains a separate registry
choice. Freeze registry/provenance before acquisition, not from a mutable response.

The implemented single-grammar API has a 30s default/120s maximum deadline, at most
three redirects, exact pinned body-size bounds, and HTTP evidence limited to
2048 raw response bytes.
It supports offline verified-cache reads, explicit cache directories, repair of
corrupt entries, abort and concurrent atomic downloads. A returned path is not
permanent trust: the worker must rehash the bytes it actually loads. Request/return
metadata is immutable per operation. These are acquisition limits, not the still
unmeasured normalization resource profile below.

Grammar npm packages remain development-only offline test seeds; their native
install hooks failed on Linux ARM64 without cc, and scoped --ignore-scripts works
for development. They are not a production grammar source or required native
binding. No binaries are checked into Git. Retain MIT notices (Max Brunsfeld:
runtime 2018, Python 2016, TypeScript 2017), audit distribution, and validate the
installed worker/runtime plus host provisioner path in P2/P6. No host compiler/
Python or candidate-source execution is needed for WASM normalization.

P2 implements one disposable worker per batch and a 60000 ms default end-to-end
deadline including provisioning. Parent snapshots/preflights requests before any
worker start. The measured `bounded-tsc-sources-v1` values are in
`contract.json.resourceProfile`; callers may tighten but not relax them. Batch byte
accounting includes IDs, paths and repeated content; unique byte accounting uses
raw content deduplicated by language/hash. Node/depth limits apply before filtering
so malformed/ignored syntax cannot bypass them. Core output sizes are calculated
incrementally before one final serialization, not by repeatedly serializing trees.

Requests/responses have an explicit protocol version, expected source provenance,
resource profile and ID associations. The worker imports only trusted sibling
implementation modules with pinned jiti; fsCache/tryNative are disabled. Node/Pi
loader flags and jiti environment overrides are not inherited. Source paths are
only registry data; candidate content is never imported/evaluated. Canonical strings,
original counts and bounded source issues are returned only after the whole batch
succeeds. Decode/validate the bounded UTF-8 wire result in the parent; do not trust
unknown records or normalize them into partial results. All paths terminate the
worker and remove listeners, including early abort/invalid protocol/heap failure.
Source fallback is data; infrastructure/resource failures reject the whole batch.
Results/limits/provenance are immutable. Never hash metrics, removal counts, limits,
cache paths or timestamps into successful canonical identity.

Measurements included 1000/10000-line Python and TypeScript, 19999-line Python just
under the node cap, over-cap cases, exact/over 512 KiB source size, Unicode literals,
exact/over depth 256, 512 duplicate sources, unique-count and cumulative-node failure.
Unit tests cover tightened exact/over node/depth/output/message budgets and failures.
A packed normal production-only npm install (no ignore-scripts/native grammar deps)
provisioned upstream assets and ran offline after cwd change with no PATH tools on
Linux ARM64/Node 22.22.1. This is source-API validation, not an all-platform or Pi/
provider-backed end-to-end claim. The explicit installed probe is not in the test
suite because it may use network for package/grammar acquisition.

Worker/WASM is not a security sandbox or hard RSS cap: external/WASM memory,
post-parse checks, parent validation/allocations, filesystem permissions and Node
launch settings are outside such a guarantee. V8 heap guards are supplementary
and may be affected by host launch flags. Trusted installed implementation code is
assumed unmodified; parsing input content is distinct from executing those modules.
P4 must bound workspace reads/candidate/file translation before allocating inputs,
not rely on the worker after an unbounded blob read. P3 helper extraction, P4 tree
identities and P5/P6 persisted/user policy integration still block automatic voting.
