"""Trusted Agentless-derived normalization code, executed only inside Pyodide.

Adapted from OpenAutoCoder/Agentless, revision
5ce5888b9f149beaace393957a55ea8ee46c9f71, agentless/util/postprocess_data.py.
Copyright (c) 2024 OpenAutoCoder. MIT License; see ../../THIRD_PARTY_NOTICES.md.

get_functions, is_just_new_function, and remove_comments_and_docstrings retain
upstream behavior. prepare_patches adapts normalize_patch's source transformation
stages to a JSON protocol; Node generates diffs and applies the added-function
line filter. SyntaxError (including IndentationError and TabError) uses original
source on both sides for explicit exact-content fallback. Other errors remain
fatal. Candidate source is parsed, never executed.
"""

import ast
import io
import json
import tokenize


def get_functions(tree):
    """Get a set of function and method names from the AST tree."""
    functions = {}

    class FunctionVisitor(ast.NodeVisitor):
        def __init__(self):
            self.parents = []

        def visit(self, node):
            self.parents.append(node)
            super().visit(node)
            self.parents.pop()

        def visit_FunctionDef(self, node):
            if not any(isinstance(parent, ast.ClassDef) for parent in self.parents):
                functions[node.name] = ast.unparse(node)
            self.generic_visit(node)

        def visit_AsyncFunctionDef(self, node):
            if not any(isinstance(parent, ast.ClassDef) for parent in self.parents):
                functions[node.name] = ast.unparse(node)
            self.generic_visit(node)

    class ClassVisitor(ast.NodeVisitor):
        def visit_ClassDef(self, node):
            class_name = node.name
            for body_item in node.body:
                if isinstance(body_item, ast.FunctionDef) or isinstance(
                    body_item, ast.AsyncFunctionDef
                ):
                    functions[f"{class_name}.{body_item.name}"] = ast.unparse(body_item)
            self.generic_visit(node)

    FunctionVisitor().visit(tree)
    ClassVisitor().visit(tree)
    return functions


def is_just_new_function(code1, code2):
    tree1 = ast.parse(code1)
    tree2 = ast.parse(code2)

    functions1 = get_functions(tree1)
    functions2 = get_functions(tree2)

    # The new functions in the second code
    if len(set(list(functions1.keys())) - set(list(functions2.keys()))) > 0:
        # removes functions
        return False

    for func in functions1:
        if functions1[func] != functions2[func]:
            # modifies existing functions
            return False

    if len(set(list(functions2.keys())) - set(list(functions1.keys()))) > 0:
        return True

    # modifying global stuff is okay, because its actually same as functions almost.

    return False


def remove_comments_and_docstrings(source):
    io_obj = io.StringIO(source)
    out = ""
    prev_toktype = tokenize.INDENT
    last_lineno = -1
    last_col = 0
    for tok in tokenize.generate_tokens(io_obj.readline):
        token_type = tok[0]
        token_string = tok[1]
        start_line, start_col = tok[2]
        end_line, end_col = tok[3]
        ltext = tok[4]
        if start_line > last_lineno:
            last_col = 0
        if start_col > last_col:
            out += " " * (start_col - last_col)
        if token_type == tokenize.COMMENT:
            pass
        elif token_type == tokenize.STRING:
            if prev_toktype != tokenize.INDENT:
                if prev_toktype != tokenize.NEWLINE:
                    if start_col > 0:
                        out += token_string
        else:
            out += token_string
        prev_toktype = token_type
        last_col = end_col
        last_lineno = end_line
    out = "\n".join(l for l in out.splitlines() if l.strip())
    return out


def prepare_sources(old_content, new_content):
    def normalize_code(code):
        try:
            node = ast.parse(code)
            return ast.unparse(node)
        except:
            return code

    old_content = normalize_code(old_content)
    new_content = normalize_code(new_content)

    try:
        stripped_old = remove_comments_and_docstrings(old_content)
        ast.parse(stripped_old)
        stripped_new = remove_comments_and_docstrings(new_content)
        ast.parse(stripped_new)
    except:
        stripped_old = old_content
        stripped_new = new_content

    return {
        "before": stripped_old,
        "after": stripped_new,
        "onlyNewFunctions": is_just_new_function(stripped_old, stripped_new),
    }


def prepare_patches(requests_json):
    patches = []
    for patch_index, patch in enumerate(json.loads(requests_json)):
        files = []
        if patch.get("rawPatch", "nonempty").strip():
            for file in patch["files"]:
                try:
                    files.append({"kind": "agentless", "path": file["path"], **prepare_sources(file["before"], file["after"])})
                except SyntaxError as error:
                    files.append({
                        "kind": "exact",
                        "path": file["path"],
                        "before": file["before"],
                        "after": file["after"],
                        "diagnostic": {
                            "kind": "exact-content-fallback",
                            "path": file["path"],
                            "pythonType": type(error).__name__,
                            "message": str(error)[:2000],
                        },
                    })
                except Exception as error:
                    return json.dumps({"error": {
                        "pythonType": type(error).__name__,
                        "message": str(error)[:2000],
                        "path": file["path"],
                        "patchIndex": patch_index,
                    }})
        patches.append(files)

    return json.dumps({"patches": patches})
