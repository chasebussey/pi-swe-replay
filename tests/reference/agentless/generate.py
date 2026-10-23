"""Regenerate normalization fixtures from a verified, pinned Agentless source file.

Development oracle only; not imported by the extension or the Node.js test suite.
See README.md for invocation, provenance, and deliberate harness differences.
"""

import argparse
import ast
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import tokenize


REVISION = "5ce5888b9f149beaace393957a55ea8ee46c9f71"
SOURCE_SHA256 = "9ddd0f53dbdf696d4d4726d0f05f92073db7795cb62b441dbeb5f66146d05462"
PYTHON_VERSION = "3.14.4"
HELPERS = {
    "get_functions", "is_just_new_function", "remove_comments_and_docstrings",
    "normalize_patch",
}
FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"


def normalized_git_diff(playground, path, old, new):
    """Safe argv-based replacement for upstream fake_git_repo, with fixed Git settings."""
    del playground
    # Inputs are controlled fixtures, but do not allow traversal outside the scratch repo.
    if Path(path).is_absolute() or ".." in Path(path).parts:
        raise ValueError("fixture path must be repository-relative")

    with tempfile.TemporaryDirectory(prefix="agentless-reference-") as directory:
        env = {
            **os.environ,
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_COUNT": "0", "GIT_ATTR_NOSYSTEM": "1", "GIT_DEFAULT_HASH": "sha1",
            "GIT_AUTHOR_NAME": "Reference", "GIT_AUTHOR_EMAIL": "reference@localhost",
            "GIT_COMMITTER_NAME": "Reference", "GIT_COMMITTER_EMAIL": "reference@localhost",
        }
        # Do not inherit a caller's repository or temporary-index overrides.
        for key in (
            "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
            "GIT_EXTERNAL_DIFF", "GIT_CONFIG_PARAMETERS",
        ):
            env.pop(key, None)

        def git(*args):
            return subprocess.run(
                ["git", *args], cwd=directory, env=env, check=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            ).stdout.decode("utf-8")

        git("init", "--template=")
        target = Path(directory) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(old, encoding="utf-8")
        git("add", "--", path)
        git("commit", "-m", "initial commit")
        target.write_text(new, encoding="utf-8")

        return git(
            "-c", "core.quotePath=true", "diff", "--no-ext-diff", "--no-textconv",
            "--no-color", "--no-renames", "--diff-algorithm=myers", "--no-indent-heuristic",
            "--unified=3", "--inter-hunk-context=0", "--abbrev=7",
            "--src-prefix=a/", "--dst-prefix=b/", ".",
        )


def load_normalizer(source):
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA256:
        raise ValueError("Agentless source does not match the pinned SHA-256")

    module = ast.parse(raw)
    functions = [
        node for node in module.body
        if isinstance(node, ast.FunctionDef) and node.name in HELPERS
    ]
    if {node.name for node in functions} != HELPERS:
        raise ValueError("missing expected upstream helpers")

    scope = {
        "ast": ast, "io": io, "tokenize": tokenize,
        "fake_git_repo": normalized_git_diff,
    }
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), scope)
    return scope["normalize_patch"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="pinned agentless/util/postprocess_data.py")
    parser.add_argument("--write", action="store_true", help="replace captured reference outputs")
    args = parser.parse_args()

    if platform.python_implementation() != "CPython" or platform.python_version() != PYTHON_VERSION:
        raise RuntimeError(f"reference generation requires CPython {PYTHON_VERSION}")

    normalize = load_normalizer(args.source)
    cases = json.loads((FIXTURES / "agentless-normalization-input.json").read_text())
    outputs = []
    for case in cases:
        files = case["files"]
        try:
            key = normalize(
                "fixture", case.get("rawPatch", "nonempty"),
                [file["before"] for file in files],
                [file["after"] for file in files],
                [file["path"] for file in files],
            )
            result = {"key": key}
        except Exception as error:
            # Error messages contain runtime-specific details; the exception class is the contract.
            result = {"errorType": type(error).__name__}
        outputs.append({"id": case["id"], **result})

    captured = {
        "upstreamRevision": REVISION,
        "sourceSha256": SOURCE_SHA256,
        "referencePythonVersion": PYTHON_VERSION,
        "gitDiffPolicy": "fixed-myers-three-context-v1",
        "cases": outputs,
    }
    destination = FIXTURES / "agentless-normalization-expected.json"
    if args.write:
        destination.write_text(json.dumps(captured, indent=2) + "\n")
    elif json.loads(destination.read_text()) != captured:
        raise AssertionError("reference outputs differ; inspect changes before using --write")

    print(f"{'Wrote' if args.write else 'Verified'} {len(outputs)} cases ({sum('errorType' in x for x in outputs)} errors)")


if __name__ == "__main__":
    main()
