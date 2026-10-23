# Third-party notices

## Agentless normalization

`extensions/swe-replay/agentless-normalization.py` adapts helpers from
[OpenAutoCoder/Agentless](https://github.com/OpenAutoCoder/Agentless), revision
`5ce5888b9f149beaace393957a55ea8ee46c9f71`,
`agentless/util/postprocess_data.py`.

Copyright (c) 2024 OpenAutoCoder. Licensed under the MIT License; the complete
notice is in [`licenses/agentless-MIT.txt`](licenses/agentless-MIT.txt).

The function visitors, added-function detection, and token stripping preserve
upstream behavior. The source transformation stages use a JSON batch protocol;
Node generates diffs in disposable repositories rather than using upstream's
shell-interpolated repository helper. Python parsing errors deliberately use
original source on both sides as an exact-content fallback, with diagnostics;
runtime/resource errors remain fatal. No upstream regression fallback is adopted.

Reference fixtures and the development oracle are documented separately in
[`tests/reference/agentless/README.md`](tests/reference/agentless/README.md).

## Pyodide 314.0.7

The runtime dependency is used unmodified. Its npm metadata declares MPL-2.0.
The license text is in [`licenses/pyodide-MPL-2.0.txt`](licenses/pyodide-MPL-2.0.txt),
copied from the upstream `314.0.7` release.

Source code for this version is available at:
https://github.com/pyodide/pyodide/tree/314.0.7
(commit `b1e4fcc2488962f6360a97f19b9982d6fdb5d16f`).

Pyodide includes CPython 3.14.2 and other components with their own applicable
licenses. The CPython license, including historical notices, is in
[`licenses/cpython-3.14.2.txt`](licenses/cpython-3.14.2.txt), copied from
https://github.com/python/cpython/blob/v3.14.2/LICENSE.

This project does not modify the Pyodide interpreter or standard library. Keep
the dependency's notices and source availability information when distributing
it. Additional runtime/build-component notices must be reviewed before creating
a standalone bundle; this document is not an exhaustive license inventory of the
Pyodide toolchain or the project's npm dependency tree.
