#!/usr/bin/env python3
"""Check that every ES-module import in the app resolves (Python 3.10+, standard library only).

    python3 deploy/check_imports.py [PUBLIC_DIR]     # default: the hub's public/ folder

It reads every .js/.mjs file under public/js, plus the scripts public/index.html loads, and checks
each static `import ... from "x"`, `import "x"`, `export ... from "x"` and literal `import("x")`:

* The specifier must be relative ('./', '../') or rooted ('/'), and must resolve to a file inside
  public/ with exactly that spelling and case. The server runs on Linux, where case matters.
* Bare names ('lodash'), full URLs and data: URLs are errors: there is no import map, and the
  CSP only allows scripts from the hub itself.
* The target must be a JavaScript module (.js or .mjs), or JSON imported `with { type: "json" }`.
  Nothing under public/dev-fixtures/ (left out of bundles) may be imported.
* A name imported in braces must be exported by the target (directly, through `export { }`, or
  through `export * from`). A default import needs a default export.

Exit status: 0 if everything resolves, 1 if anything doesn't (one `file:line: problem` per line).
deploy/make_bundle.py and deploy/update.sh run this and refuse to ship or swap on failure.
"""
from __future__ import annotations

import os
import posixpath
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

HUB = Path(__file__).resolve().parent.parent
MODULE_EXTS = (".js", ".mjs")
SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*$")  # what server.py will serve
NAME_START = re.compile(r"[A-Za-z_$\u0080-\uffff]")
NAME_CHARS = re.compile(r"[A-Za-z0-9_$\u0080-\uffff]*")
NUMBER = re.compile(r"(?:0[xXoObB][0-9a-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?")
PUNCT3 = ("...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=")
PUNCT2 = ("=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=",
          "&=", "|=", "^=", "<<", ">>", "**")
# After one of these keywords a '/' starts a regular expression, not a division.
REGEX_AFTER_WORDS = {"return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case",
                     "do", "else", "yield", "await"}
# Words that start a new statement: an `export const` without a semicolon ends before them.
STATEMENT_WORDS = {"export", "import", "const", "let", "var", "function", "class", "if", "for", "while", "do",
                   "return", "switch", "try", "throw", "async"}
SCRIPT_SRC = re.compile(r"""<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>""", re.IGNORECASE)
SCRIPT_IS_MODULE = re.compile(r"""\btype\s*=\s*["']module["']""", re.IGNORECASE)


@dataclass
class Token:
    kind: str   # name | str | num | punct | template | regex
    value: str
    line: int


@dataclass
class ImportRef:
    spec: str
    line: int
    names: list = field(default_factory=list)  # imported export names (after "as" is dropped)
    default: bool = False
    dynamic: bool = False
    json_type: bool = False


@dataclass
class ModuleInfo:
    exports: set = field(default_factory=set)
    star_from: list = field(default_factory=list)  # specifiers of `export * from`
    imports: list = field(default_factory=list)     # ImportRef, including re-exports
    problems: list = field(default_factory=list)
    unreadable: bool = False                         # couldn't be lexed: its exports are unknown


class LexError(Exception):
    pass


def tokenize(src: str) -> list[Token]:
    """A small JavaScript lexer: enough to find imports and exports reliably.

    Comments are dropped; strings are decoded (simple escapes); template literals are skipped
    except for the code inside `${...}`; '/' is a regex or a division by the usual rule."""
    tokens: list[Token] = []
    i, n, line = 0, len(src), 1
    template_depths: list[int] = []  # brace depth at which each open `${` resumes its template
    depth = 0

    def prev_allows_regex() -> bool:
        if not tokens:
            return True
        last = tokens[-1]
        if last.kind in ("num", "str", "template", "regex"):
            return False
        if last.kind == "name":
            return last.value in REGEX_AFTER_WORDS
        return last.value not in (")", "]", "}")

    def scan_template(pos: int) -> int:
        """Scan template text from pos (just after ` or the } closing a ${) to its end or ${."""
        nonlocal line
        while pos < n:
            ch = src[pos]
            if ch == "\\":
                pos += 2
                continue
            if ch == "\n":
                line += 1
            if ch == "`":
                return pos + 1
            if ch == "$" and pos + 1 < n and src[pos + 1] == "{":
                template_depths.append(depth)
                return pos + 2
            pos += 1
        raise LexError(f"line {line}: unterminated template literal")

    while i < n:
        ch = src[i]
        if ch == "\n":
            line += 1
            i += 1
            continue
        if ch in " \t\r\f\v\ufeff\u00a0\u2028\u2029":
            i += 1
            continue
        if src.startswith("//", i):
            end = src.find("\n", i)
            i = n if end < 0 else end
            continue
        if src.startswith("/*", i):
            end = src.find("*/", i + 2)
            if end < 0:
                raise LexError(f"line {line}: unterminated comment")
            line += src.count("\n", i, end)
            i = end + 2
            continue
        if ch in "'\"":
            start_line, j, out = line, i + 1, []
            while True:
                if j >= n or src[j] == "\n":
                    raise LexError(f"line {start_line}: unterminated string")
                c = src[j]
                if c == ch:
                    break
                if c == "\\" and j + 1 < n:
                    nxt = src[j + 1]
                    j += 2
                    if nxt in "\r\n\u2028\u2029":  # line continuation
                        line += 1
                        if nxt == "\r" and j < n and src[j] == "\n":
                            j += 1
                    else:
                        out.append({"n": "\n", "t": "\t", "r": "\r", "0": "\0"}.get(nxt, nxt))
                    continue
                out.append(c)
                j += 1
            tokens.append(Token("str", "".join(out), start_line))
            i = j + 1
            continue
        if ch == "`":
            start_line = line
            i = scan_template(i + 1)
            tokens.append(Token("template", "", start_line))
            continue
        if NAME_START.match(ch) or (ch == "\\" and src.startswith("\\u", i)):
            m = NAME_CHARS.match(src, i + 1)
            tokens.append(Token("name", src[i:m.end()], line))
            i = m.end()
            continue
        if ch == "#" and i + 1 < n and NAME_START.match(src[i + 1]):  # private class member
            m = NAME_CHARS.match(src, i + 2)
            tokens.append(Token("name", src[i:m.end()], line))
            i = m.end()
            continue
        if ch.isdigit() or (ch == "." and i + 1 < n and src[i + 1].isdigit()):
            m = NUMBER.match(src, i)
            end = m.end() if m and m.end() > i else i + 1
            tokens.append(Token("num", src[i:end], line))
            i = end
            continue
        if ch == "/" and prev_allows_regex():
            j, in_class = i + 1, False
            while True:
                if j >= n or src[j] == "\n":
                    raise LexError(f"line {line}: unterminated regular expression")
                c = src[j]
                if c == "\\":
                    j += 2
                    continue
                if c == "[":
                    in_class = True
                elif c == "]":
                    in_class = False
                elif c == "/" and not in_class:
                    break
                j += 1
            m = NAME_CHARS.match(src, j + 1)  # flags
            tokens.append(Token("regex", "", line))
            i = m.end()
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            if template_depths and template_depths[-1] == depth:
                template_depths.pop()
                i = scan_template(i + 1)
                tokens.append(Token("template", "", line))
                continue
            depth -= 1
        for group in (PUNCT3, PUNCT2):
            hit = next((p for p in group if src.startswith(p, i)), None)
            if hit:
                if hit == "?." and i + 2 < n and src[i + 2].isdigit():
                    hit = None  # `a ?.5 : b` is a conditional, not optional chaining
                else:
                    break
        else:
            hit = None
        token = hit or ch
        tokens.append(Token("punct", token, line))
        i += len(token)
    return tokens


def _is(tok: Token | None, kind: str, value: str | None = None) -> bool:
    return tok is not None and tok.kind == kind and (value is None or tok.value == value)


def parse_module(src: str) -> ModuleInfo:
    info = ModuleInfo()
    try:
        toks = tokenize(src)
    except LexError as exc:
        info.problems.append((0, f"can't read this file as JavaScript ({exc})"))
        info.unreadable = True
        return info
    n = len(toks)

    def at(k: int) -> Token | None:
        return toks[k] if 0 <= k < n else None

    def name_list(k: int) -> tuple[list[tuple[str, str]], int]:
        """Parse `{ a, b as c, "x" as d, default as e }` from toks[k] == '{'. Returns ([(orig, alias)], next)."""
        pairs, k = [], k + 1
        while k < n and not _is(at(k), "punct", "}"):
            tok = at(k)
            if tok.kind in ("name", "str"):
                orig, alias, k = tok.value, tok.value, k + 1
                if _is(at(k), "name", "as") and at(k + 1) is not None and at(k + 1).kind in ("name", "str"):
                    alias, k = at(k + 1).value, k + 2
                pairs.append((orig, alias))
            elif _is(tok, "punct", ","):
                k += 1
            else:
                k += 1  # tolerate anything odd; the browser will be the judge
        return pairs, k + 1

    def attributes(k: int) -> tuple[bool, int]:
        """`with { type: "json" }` (or the older `assert`) after a specifier."""
        if (_is(at(k), "name", "with") or _is(at(k), "name", "assert")) and _is(at(k + 1), "punct", "{"):
            j, is_json = k + 2, False
            while j < n and not _is(at(j), "punct", "}"):
                if _is(at(j), "name", "type") or _is(at(j), "str", "type"):
                    if _is(at(j + 1), "punct", ":") and _is(at(j + 2), "str", "json"):
                        is_json = True
                j += 1
            return is_json, j + 1
        return False, k

    def binding_names(k: int) -> tuple[list[str], int]:
        """Names bound by a declaration's pattern starting at toks[k]: `a`, `{a, b: c}`, `[a, b]`."""
        tok = at(k)
        if tok is None:
            return [], k
        if tok.kind == "name":
            return [tok.value], k + 1
        if not (_is(tok, "punct", "{") or _is(tok, "punct", "[")):
            return [], k + 1
        names, level, j = [], 0, k
        while j < n:
            t = at(j)
            if t.kind == "punct" and t.value in "{[":
                level += 1
            elif t.kind == "punct" and t.value in "}]":
                level -= 1
                if level == 0:
                    return names, j + 1
            elif t.kind == "name" and not _is(at(j + 1), "punct", ":") and not _is(at(j - 1), "punct", "="):
                names.append(t.value)  # a binding (keys are followed by ':', defaults follow '=')
            j += 1
        return names, j

    k = 0
    while k < n:
        tok = toks[k]
        prev = at(k - 1)
        if (tok.kind != "name" or _is(prev, "punct", ".") or _is(prev, "punct", "?.")
                or _is(at(k + 1), "punct", ":")):  # obj.import, obj?.export, { import: ... }
            k += 1
            continue
        if tok.value == "import":
            nxt = at(k + 1)
            if _is(nxt, "punct", "."):  # import.meta
                k += 2
                continue
            if _is(nxt, "punct", "("):
                arg = at(k + 2)
                if arg is not None and arg.kind == "str" and (_is(at(k + 3), "punct", ")") or _is(at(k + 3), "punct", ",")):
                    info.imports.append(ImportRef(arg.value, tok.line, dynamic=True))
                else:
                    info.problems.append((tok.line, "import() with a computed specifier can't be checked; use a string literal"))
                k += 3
                continue
            if _is(nxt, "str"):  # import "x"
                is_json, after = attributes(k + 2)
                info.imports.append(ImportRef(nxt.value, tok.line, json_type=is_json))
                k = after
                continue
            ref = ImportRef("", tok.line)
            j = k + 1
            if at(j) is not None and at(j).kind == "name" and at(j).value != "from":
                ref.default = True
                j += 1
                if _is(at(j), "punct", ","):
                    j += 1
            if _is(at(j), "punct", "*") and _is(at(j + 1), "name", "as"):
                j += 3
            elif _is(at(j), "punct", "{"):
                pairs, j = name_list(j)
                for orig, _alias in pairs:
                    if orig == "default":
                        ref.default = True
                    else:
                        ref.names.append(orig)
            if _is(at(j), "name", "from") and _is(at(j + 1), "str"):
                ref.spec = at(j + 1).value
                ref.json_type, j = attributes(j + 2)
                info.imports.append(ref)
                k = j
            else:
                info.problems.append((tok.line, "an import statement this checker can't read"))
                k = j
            continue
        if tok.value == "export":
            nxt = at(k + 1)
            if _is(nxt, "punct", "*"):
                j = k + 2
                alias = None
                if _is(at(j), "name", "as") and at(j + 1) is not None:
                    alias, j = at(j + 1).value, j + 2
                if _is(at(j), "name", "from") and _is(at(j + 1), "str"):
                    spec = at(j + 1).value
                    if alias is None:
                        info.star_from.append(spec)
                    else:
                        info.exports.add(alias)
                    is_json, j = attributes(j + 2)
                    info.imports.append(ImportRef(spec, tok.line, json_type=is_json))
                else:
                    info.problems.append((tok.line, "an export * this checker can't read"))
                k = j
                continue
            if _is(nxt, "punct", "{"):
                pairs, j = name_list(k + 1)
                if _is(at(j), "name", "from") and _is(at(j + 1), "str"):
                    ref = ImportRef(at(j + 1).value, tok.line)
                    for orig, alias in pairs:
                        info.exports.add(alias)
                        if orig == "default":
                            ref.default = True
                        else:
                            ref.names.append(orig)
                    ref.json_type, j = attributes(j + 2)
                    info.imports.append(ref)
                else:
                    info.exports.update(alias for _orig, alias in pairs)
                k = j
                continue
            if _is(nxt, "name", "default"):
                info.exports.add("default")
                k += 2
                continue
            j = k + 1
            if _is(at(j), "name", "async"):
                j += 1
            if _is(at(j), "name", "function") or _is(at(j), "name", "class"):
                j += 1
                if _is(at(j), "punct", "*"):
                    j += 1
                if at(j) is not None and at(j).kind == "name":
                    info.exports.add(at(j).value)
                k = j + 1
                continue
            if at(j) is not None and at(j).kind == "name" and at(j).value in ("const", "let", "var"):
                names, j = binding_names(j + 1)
                info.exports.update(names)
                level = 0  # further declarators: `, name =` at bracket depth 0 before the statement ends
                while j < n:
                    t = at(j)
                    if t.kind == "punct" and t.value in "([{":
                        level += 1
                    elif t.kind == "punct" and t.value in ")]}":
                        level -= 1
                        if level < 0:
                            break
                    elif level == 0 and _is(t, "punct", ";"):
                        break
                    elif (level == 0 and t.kind == "name" and t.value in STATEMENT_WORDS
                          and t.line > at(j - 1).line):
                        break  # a new statement on a new line (no semicolon)
                    elif level == 0 and _is(t, "punct", ","):
                        more, after = binding_names(j + 1)
                        if more and _is(at(after), "punct", "="):
                            info.exports.update(more)
                    j += 1
                k = j
                continue
            info.problems.append((tok.line, "an export statement this checker can't read"))
            k += 1
            continue
        k += 1
    return info


class Checker:
    def __init__(self, public: Path):
        self.public = public.resolve()
        self.modules: dict[str, ModuleInfo] = {}   # url path (/js/x.js) -> info
        self.problems: list[str] = []
        self.import_count = 0

    # ----------------------------------------------------------- files
    def exact_file(self, url_path: str) -> Path | None:
        """The file for /a/b.js inside public/, matching the case of every segment exactly."""
        current = self.public
        segments = [s for s in url_path.split("/") if s]
        for index, seg in enumerate(segments):
            try:
                names = set(os.listdir(current))
            except OSError:
                return None
            if seg not in names:
                return None
            current = current / seg
            if index < len(segments) - 1 and not current.is_dir():
                return None
        return current if current.is_file() else None

    def rel(self, url_path: str) -> str:
        return "public" + url_path

    def load(self, url_path: str) -> ModuleInfo | None:
        if url_path in self.modules:
            return self.modules[url_path]
        target = self.exact_file(url_path)
        if target is None:
            return None
        try:
            src = target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            info = ModuleInfo(problems=[(0, f"can't read this file ({exc.__class__.__name__})")], unreadable=True)
        else:
            info = parse_module(src)
        self.modules[url_path] = info
        return info

    def resolve(self, importer: str, spec: str) -> tuple[str | None, str | None]:
        """(url path, None) or (None, problem) for a specifier used in module `importer`."""
        if not spec:
            return None, "empty import specifier"
        if spec.startswith(("./", "../")):
            url = posixpath.normpath(posixpath.join(posixpath.dirname(importer), spec))
        elif spec.startswith("/") and not spec.startswith("//"):
            url = posixpath.normpath(spec)
        elif re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", spec) or spec.startswith("//"):
            return None, f"'{spec}' is a URL; the hub's CSP only allows its own scripts"
        else:
            return None, f"'{spec}' is a bare module name; browsers need './' or '/' (there is no import map)"
        url = url.split("?", 1)[0].split("#", 1)[0]
        if not url.startswith("/") or url == "/":
            return None, f"'{spec}' points outside public/"
        if any(not SAFE_SEGMENT.match(seg) for seg in url.split("/")[1:]):
            return None, f"'{spec}' has a path segment the hub refuses to serve (dotfile or odd character)"
        if url.startswith("/dev-fixtures/"):
            return None, f"'{spec}' is under dev-fixtures/, which bundles leave out"
        if self.exact_file(url) is None:
            loose = self._case_insensitive(url)
            hint = f" (did you mean '{loose}'? case matters on the Linux server)" if loose else ""
            return None, f"'{spec}' does not exist (resolved to public{url}){hint}"
        return url, None

    def _case_insensitive(self, url_path: str) -> str | None:
        current, out = self.public, []
        for seg in [s for s in url_path.split("/") if s]:
            try:
                match = next((name for name in os.listdir(current) if name.lower() == seg.lower()), None)
            except OSError:
                return None
            if match is None:
                return None
            out.append(match)
            current = current / match
        return "/" + "/".join(out)

    # --------------------------------------------------------- exports
    def exports_of(self, url_path: str, seen: set | None = None) -> set | None:
        """Every name a module exports, following `export * from`; None if unknown (unreadable)."""
        seen = set() if seen is None else seen
        if url_path in seen:
            return set()
        seen.add(url_path)
        info = self.load(url_path)
        if info is None or info.unreadable:
            return None
        names = set(info.exports)
        for spec in info.star_from:
            target, problem = self.resolve(url_path, spec)
            if target is None or not target.endswith(MODULE_EXTS):
                continue  # reported where that export * is checked
            more = self.exports_of(target, seen)
            if more is None:
                return None
            names |= {name for name in more if name != "default"}
        return names

    # ----------------------------------------------------------- crawl
    def run(self) -> list[str]:
        roots: list[tuple[str, bool]] = []  # (url path, is_module)
        index = self.public / "index.html"
        if index.is_file():
            html = index.read_text(encoding="utf-8", errors="replace")
            for match in SCRIPT_SRC.finditer(html):
                src = match.group(1)
                url, problem = self.resolve("/index.html", src if src.startswith(("/", "./", "../")) else "./" + src)
                line = html.count("\n", 0, match.start()) + 1
                if url is None:
                    self.problems.append(f"public/index.html:{line}: script {problem}")
                else:
                    roots.append((url, bool(SCRIPT_IS_MODULE.search(match.group(0)))))
        js_dir = self.public / "js"
        if js_dir.is_dir():
            for path in sorted(js_dir.rglob("*")):
                if path.is_file() and path.suffix in MODULE_EXTS:
                    roots.append(("/" + path.relative_to(self.public).as_posix(), True))
        checked: set[str] = set()
        queue = [url for url, is_module in roots]
        while queue:
            url = queue.pop(0)
            if url in checked:
                continue
            checked.add(url)
            info = self.load(url)
            if info is None:
                continue
            for line, problem in info.problems:
                self.problems.append(f"{self.rel(url)}:{line}: {problem}")
            for ref in info.imports:
                self.import_count += 1
                where = f"{self.rel(url)}:{ref.line}"
                target, problem = self.resolve(url, ref.spec)
                if target is None:
                    self.problems.append(f"{where}: {problem}")
                    continue
                if target.endswith(".json"):
                    if not ref.json_type:
                        self.problems.append(f"{where}: '{ref.spec}' is JSON: import it `with {{ type: \"json\" }}`")
                    continue
                if not target.endswith(MODULE_EXTS):
                    self.problems.append(f"{where}: '{ref.spec}' is not a JavaScript module (.js/.mjs)")
                    continue
                queue.append(target)
                if ref.dynamic or not (ref.names or ref.default):
                    continue
                exported = self.exports_of(target)
                if exported is None:
                    continue
                for name in ref.names:
                    if name not in exported:
                        self.problems.append(f"{where}: '{name}' is not exported by public{target}")
                if ref.default and "default" not in exported:
                    self.problems.append(f"{where}: public{target} has no default export")
        self.files = len(checked)
        return self.problems


def check(public: Path) -> tuple[list[str], dict]:
    checker = Checker(public)
    problems = checker.run()
    return problems, {"files": getattr(checker, "files", 0), "imports": checker.import_count}


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) > 1 or (args and args[0].startswith("-")):
        print("usage: check_imports.py [PUBLIC_DIR]", file=sys.stderr)
        return 2
    public = Path(args[0]) if args else HUB / "public"
    if not (public / "js").is_dir():
        print(f"imports: FAIL no js/ folder in {public}", file=sys.stderr)
        return 1
    problems, stats = check(public)
    for problem in problems:
        print(f"imports: FAIL {problem}")
    if problems:
        print(f"imports: {len(problems)} problem(s) in {stats['files']} files")
        return 1
    print(f"imports: OK   {stats['imports']} imports in {stats['files']} files all resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
