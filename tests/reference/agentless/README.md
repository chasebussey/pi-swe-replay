# Agentless normalization reference

This is the host-Python development oracle, not an extension runtime dependency.
`agentless-reference.test.mjs` asserts properties of the captured corpus.
`python-normalization.test.mjs` additionally compares the implemented Pyodide
normalizer against it using bundled CPython/WASM. Neither Node test file invokes
host Python or accesses the network.

## Provenance

- Repository: https://github.com/OpenAutoCoder/Agentless
- Revision: `5ce5888b9f149beaace393957a55ea8ee46c9f71`
- File: `agentless/util/postprocess_data.py`
- SHA-256: `9ddd0f53dbdf696d4d4726d0f05f92073db7795cb62b441dbeb5f66146d05462`
- Helpers: `get_functions`, `is_just_new_function`,
  `remove_comments_and_docstrings`, `normalize_patch`
- Reference runtime: CPython **3.14.4**, the available runtime when the corpus was
  captured. This pins the oracle, not a decided production Python requirement or
  the runtime used in the SWE-Replay experiments.
- Capture Git version: 2.53.0 (SHA-1 repositories).
- License: MIT, copyright (c) 2024 OpenAutoCoder; see `LICENSE` alongside this file.

The generator verifies the full upstream source hash before extracting and
executing these four functions unchanged. Unrelated imports and helpers are not
executed. Its safe argv-based `fake_git_repo` replacement uses isolated scratch
repositories, a fixed identity, SHA-1, seven-character diff abbreviations, and
fixed Myers/three-line-context settings, without caller global/system config.
This intentionally replaces upstream's shell interpolation and ambient Git
configuration. It is the `fixed-myers-three-context-v1` harness policy, not an
assertion that all upstream installations emit the same bytes.

## Regenerate or verify

Obtain the pinned source explicitly (never during the Node tests):

```bash
curl -L --fail \
  https://raw.githubusercontent.com/OpenAutoCoder/Agentless/5ce5888b9f149beaace393957a55ea8ee46c9f71/agentless/util/postprocess_data.py \
  -o /tmp/agentless-postprocess-pinned.py
python3 tests/reference/agentless/generate.py /tmp/agentless-postprocess-pinned.py
```

The generator requires CPython 3.14.4. Without `--write`, it compares the captured
JSON against fresh oracle results and fails on a mismatch. To intentionally
replace the expected outputs after reviewing changes, pass `--write`.

Inputs and captured outputs are in `tests/fixtures/agentless-normalization-*.json`.
They distinguish exact key bytes, grouping relationships, and exceptions.
The initial corpus covers Python transformations and file ordering. Our proposed
mixed-file, mode, existence, decoding, and binary extensions still need production
policy tests; the upstream string-based interface does not represent those Git
properties.

## Observed compatibility traps

- Invalid Python can raise `SyntaxError` in the later function comparison, despite
  the initial parse/unparse fallback.
- Docstring-only bodies trigger paired fallback, retaining both sides' docstrings.
- Added functions at different interior positions can normalize identically, but
  moving an addition to EOF can preserve extra `+`/`-` lines from Git's
  no-final-newline handling and split the groups. Do not "repair" that invisibly.
- Added-function detection permits accompanying global edits.
- Caller-supplied file order changes the concatenated key. Production will need
  an explicit deterministic ordering policy.
- The upstream old/new-string interface treats a new empty or comment-only file
  as normalization-empty. Our design preserves file-existence changes explicitly.

## TypeScript parser/printer checkpoint

A scratch probe of `@lezer/python` 1.1.19 (not added as a project dependency)
parsed functions, comments, and Python type parameter syntax into a concrete
syntax tree. It does not supply CPython's canonical AST unparser. It also
reported an error for the CPython 3.14 template-string fixture `x = t'{value}'`.
This is evidence against adopting that parser alone as a faithful normalizer,
not a completed assessment of every TypeScript Python implementation.

The subsequent three-way exploration is in
`experiments/python-normalization/README.md`. Pyodide 314.0.7 / bundled CPython
3.14.2 was selected and initially matched all 23 outcomes for the Python-only
batch primitive. The approved `agentless-python-pyodide-v2` policy now deliberately
differs on source errors: it records an exact-content fallback per file instead
of throwing `SyntaxError`. All 22 successful reference keys still match. The
reference corpus remains unchanged as upstream evidence, not rewritten to hide
the deviation. Runtime/resource errors remain fatal. Mixed-file tree handling
remains unimplemented; no host Python or runtime download is required.
