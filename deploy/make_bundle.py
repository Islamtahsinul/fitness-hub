#!/usr/bin/env python3
"""Build fitness-hub.zip from the hub folder, for copying to the home server.

    python deploy/make_bundle.py                       # writes ../fitness-hub.zip (next to the hub folder)
    python deploy/make_bundle.py --out D:/tmp/fh.zip   # somewhere else (never inside the hub folder)
    python deploy/make_bundle.py --list                # only print what would go in (builds nothing)
    python deploy/make_bundle.py --with-data           # ALSO include data/data.json (prefer Export/Import)

Before anything is written, the files that will ship are copied to a temporary folder (with the
dev fixtures the tests need, and never data/), and these must all pass there:
  * deploy/check_imports.py  every ES-module import under public/js resolves;
  * tests/test_server.py     the server tests;
  * node --test tests/*.mjs  the client and content tests (Node.js 18 or newer is required).
If any fails, or a test changed a file that would ship, no bundle is written.

Everything sits under one top-level folder, fitness-hub/. Left out: data/ (with --with-data,
only data/data.json goes in), public/dev-fixtures/, __pycache__, temp and editor files, logs,
archives, screenshots and dotfiles. BUILD_ID (a content hash of public/) is added: the hub reports
it as `build`, and refuses saves from app code of another build. Shell scripts, Python files and
the systemd unit get LF line endings; .bat files get CRLF. Entries are private (0600, scripts 0700).
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

HUB = Path(__file__).resolve().parent.parent
TOP = "fitness-hub"
SKIP_DIRS = {"__pycache__", "node_modules", "screenshots", "screenshot"}
SKIP_TREES = ("data", "public/dev-fixtures")
SKIP_TOP_FILES = {"BUILD_ID"}  # always generated, never copied from the working tree
SKIP_NAMES = ("*.pyc", "*.pyo", "*.tmp", "*.temp", "*.bak", "*.orig", "*.rej", "*.swp", "*.swo", "*~",
              "*.log", "*.zip", "*.part", "*.tar", "*.gz", "*.tgz", "*.7z", "thumbs.db", "desktop.ini",
              "screenshot*", "screen shot*")
IMAGES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"}
LF = {".sh", ".service", ".timer", ".conf", ".example", ".py"}  # .example: the systemd drop-in template
CRLF = {".bat", ".cmd"}
REQUIRED = ("server.py", "public/index.html", "deploy/install.sh", "deploy/verify.sh", "deploy/update.sh",
            "deploy/fitness-hub.service", "deploy/tailscale.conf.example", "deploy/CODEX_HOSTING_GUIDE.md",
            "deploy/check_imports.py", "tests/test_server.py")
CHECK_TIMEOUT = 900  # seconds per check


def wanted(rel: str) -> bool:
    parts = rel.split("/")
    if any(p.startswith(".") for p in parts):
        return False  # dotfiles and dot-folders (.git, .vscode, .claude, .env, ...)
    if any(p.lower() in SKIP_DIRS for p in parts[:-1]):
        return False
    if any(rel == tree or rel.startswith(tree + "/") for tree in SKIP_TREES):
        return False
    if rel in SKIP_TOP_FILES:
        return False
    name = parts[-1].lower()
    if any(fnmatch.fnmatchcase(name, pattern) for pattern in SKIP_NAMES):
        return False
    if Path(name).suffix in IMAGES and not rel.startswith("public/"):
        return False  # stray screenshots; the app itself may ship images under public/
    return True


def normalise(rel: str, data: bytes) -> bytes:
    ext = Path(rel).suffix.lower()
    if ext in LF:
        data = data.replace(b"\r\n", b"\n")
        if ext in {".sh", ".service", ".timer", ".conf", ".example"} and b"\r" in data:
            raise SystemExit(f"{rel} contains a stray carriage return; fix the file first")
    elif ext in CRLF:
        data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    return data


def file_mode(rel: str, data: bytes) -> int:
    if rel.endswith(".sh") or (rel.endswith(".py") and data.startswith(b"#!")):
        return 0o700
    return 0o600


def collect(hub: Path = HUB) -> list[tuple[str, Path]]:
    """(rel path, file) for everything that ships. Never descends into data/ or dev-fixtures/."""
    found = []
    for folder, dirs, files in os.walk(hub):
        base = Path(folder)
        rel_dir = base.relative_to(hub).as_posix()
        rel_dir = "" if rel_dir == "." else rel_dir + "/"
        dirs[:] = sorted(d for d in dirs if wanted(f"{rel_dir}{d}/x") and not (base / d).is_symlink())
        for name in sorted(files):
            path = base / name
            rel = rel_dir + name
            if path.is_symlink() or not path.is_file() or not wanted(rel):
                continue
            found.append((rel, path))
    return found


def compute_build_id(files: dict) -> str:
    """A content hash of the public/ tree as bundled: same app files, same id."""
    digest = hashlib.sha256()
    for rel in sorted(r for r in files if r.startswith("public/")):
        digest.update(rel.encode("utf-8") + b"\0" + hashlib.sha256(files[rel]).digest())
    return digest.hexdigest()[:16]


def load(hub: Path = HUB) -> dict:
    """{rel path: normalised bytes} of everything that ships (BUILD_ID not yet included)."""
    return {rel: normalise(rel, path.read_bytes()) for rel, path in collect(hub)}


def stage(hub: Path, files: dict, build_id: str, dest: Path) -> None:
    """Write the bundle's files (plus the dev fixtures the tests use, never data/) under dest."""
    for rel, data in files.items():
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (dest / "BUILD_ID").write_text(build_id + "\n", encoding="ascii")
    fixtures = hub / "public" / "dev-fixtures"
    if fixtures.is_dir():
        shutil.copytree(fixtures, dest / "public" / "dev-fixtures", symlinks=False,
                        ignore=shutil.ignore_patterns("*.tmp", "*.part", ".*"))


def _clean_env() -> dict:
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("FITNESS_HUB_") and k not in ("INVOCATION_ID", "NOTIFY_SOCKET", "JOURNAL_STREAM")}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def tests_ran(label: str, output: str) -> int | None:
    """How many tests a suite reports having run (None for steps that aren't test suites)."""
    if label == "server tests":
        found = re.findall(r"^Ran (\d+) tests? in ", output, re.MULTILINE)
    elif label == "client tests":
        found = re.findall(r"^\D*\btests (\d+)\s*$", output, re.MULTILINE)  # node: "# tests 183" or "i tests 183"
    else:
        return None
    return int(found[-1]) if found else 0


def run_checks(root: Path) -> bool:
    """The import check and every test suite, run inside `root` (a staged copy). True if all pass."""
    steps = [("import check", [sys.executable, "-I", "-B", str(root / "deploy" / "check_imports.py"), str(root / "public")]),
             ("server tests", [sys.executable, "-I", "-B", str(root / "tests" / "test_server.py")])]
    node_tests = sorted((root / "tests").glob("test_*.mjs"))
    if node_tests:
        node = shutil.which("node")
        if node is None:
            print("check: FAIL node was not found. The client tests (tests/*.mjs) must pass before a bundle is "
                  "built: install Node.js 18 or newer, then try again.")
            return False
        steps.append(("client tests", [node, "--test", *(p.relative_to(root).as_posix() for p in node_tests)]))
    for label, cmd in steps:
        print(f"check: {label} ...", flush=True)
        started = time.monotonic()
        try:
            proc = subprocess.run(cmd, cwd=str(root), env=_clean_env(), stdin=subprocess.DEVNULL,
                                  capture_output=True, timeout=CHECK_TIMEOUT)
        except subprocess.TimeoutExpired:
            print(f"check: FAIL {label} took longer than {CHECK_TIMEOUT} s")
            return False
        except OSError as exc:
            print(f"check: FAIL {label} could not run ({exc})")
            return False
        output = (proc.stdout + proc.stderr).decode("utf-8", "replace")
        if proc.returncode != 0:
            print(f"check: FAIL {label} (exit {proc.returncode}). Last lines:")
            for line in output.splitlines()[-40:]:
                print("    " + line)
            return False
        count = tests_ran(label, output)
        if count == 0:
            print(f"check: FAIL {label} ran no tests at all, which can't count as passing.")
            return False
        done = f"{count} tests, " if count else ""
        print(f"check: OK   {label} ({done}{time.monotonic() - started:.0f} s)")
    return True


def unchanged(root: Path, files: dict, build_id: str) -> list[str]:
    """Bundled files a check modified in the staged copy (none, normally)."""
    changed = [rel for rel, data in files.items()
               if not (root / rel).is_file() or (root / rel).read_bytes() != data]
    if (root / "BUILD_ID").read_text(encoding="ascii").strip() != build_id:
        changed.append("BUILD_ID")
    return changed


def add(z: zipfile.ZipFile, rel: str, data: bytes, mode: int, mtime: float) -> None:
    info = zipfile.ZipInfo(f"{TOP}/{rel}", date_time=time.localtime(max(mtime, 315532800))[:6])
    info.create_system = 3  # Unix, so update.sh restores the permission bits
    info.external_attr = (0o100000 | mode) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, data)


def read_data_file(hub: Path) -> bytes:
    data_file = hub / "data" / "data.json"
    try:
        raw = data_file.read_bytes()
        doc = json.loads(raw.decode("utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise SystemExit(f"Can't include {data_file}: {exc.__class__.__name__}. Is it there and valid JSON?") from None
    if not isinstance(doc, dict) or not isinstance(doc.get("schema_version"), int):
        raise SystemExit(f"{data_file} is not a Fitness Hub data file (no integer schema_version).")
    return raw


def write_bundle(out: Path, files: dict, build_id: str, *, data_raw: bytes | None = None) -> str:
    """Write the zip (atomically, mode 0600) and return its sha256."""
    out.parent.mkdir(parents=True, exist_ok=True)
    part = out.with_name(out.name + ".part")
    try:
        part.unlink()
    except FileNotFoundError:
        pass
    now = time.time()
    fd = os.open(str(part), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
    try:
        with os.fdopen(fd, "wb") as handle, zipfile.ZipFile(handle, "w") as z:
            for rel in sorted(files):
                add(z, rel, files[rel], file_mode(rel, files[rel]), now)
            add(z, "BUILD_ID", (build_id + "\n").encode("ascii"), 0o600, now)
            if data_raw is not None:
                add(z, "data/data.json", data_raw, 0o600, now)
        with zipfile.ZipFile(part) as z:
            bad = z.testzip()
            if bad:
                raise SystemExit(f"The new zip failed its own check ({bad}).")
        os.replace(part, out)
    except BaseException:
        try:
            part.unlink()
        except OSError:
            pass
        raise
    return hashlib.sha256(out.read_bytes()).hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build fitness-hub.zip for the home server.")
    parser.add_argument("--out", help="where to write the zip (default: next to the hub folder)")
    parser.add_argument("--with-data", action="store_true",
                        help="also include data/data.json (personal health data; Settings > Export is preferred)")
    parser.add_argument("--list", action="store_true", help="only print the files that would go in, and the build id")
    args = parser.parse_args(argv)

    out = Path(args.out).expanduser().resolve() if args.out else (HUB.parent / "fitness-hub.zip")
    if out == HUB or HUB in out.parents:
        print(f"Refusing to write the bundle inside the hub folder ({HUB}): it would end up in the next "
              "bundle, and under public/ it would be served.", file=sys.stderr)
        return 2
    if out.suffix.lower() != ".zip":
        print("--out must end with .zip", file=sys.stderr)
        return 2

    files = load(HUB)
    for required in REQUIRED:
        if required not in files:
            print(f"The hub is incomplete: {required} is missing.", file=sys.stderr)
            return 1
    build_id = compute_build_id(files)
    if args.list:
        for rel in sorted(files):
            print(f"  {TOP}/{rel}")
        print(f"  {TOP}/BUILD_ID  ({build_id})")
        print(f"{len(files) + 1} files; nothing was built (--list)")
        return 0

    data_raw = read_data_file(HUB) if args.with_data else None
    root = Path(tempfile.mkdtemp(prefix="fitness-hub-check-"))
    try:
        stage(HUB, files, build_id, root / TOP)
        print(f"Checking build {build_id} in a temporary copy (never next to your data) ...")
        if not run_checks(root / TOP):
            print("No bundle was written: fix the failure above, then run make_bundle.py again.", file=sys.stderr)
            return 1
        changed = unchanged(root / TOP, files, build_id)
        if changed:
            print(f"No bundle was written: the checks changed files that would ship: {', '.join(changed[:5])}",
                  file=sys.stderr)
            return 1
    finally:
        shutil.rmtree(root, ignore_errors=True)

    digest = write_bundle(out, files, build_id, data_raw=data_raw)
    groups: dict[str, int] = {}
    for rel in files:
        top = rel.split("/", 1)[0] + ("/" if "/" in rel else "")
        groups[top] = groups.get(top, 0) + 1
    unpacked = sum(len(d) for d in files.values()) + (len(data_raw) if data_raw else 0)
    print(f"bundle:  {out}")
    print(f"build:   {build_id}")
    print(f"files:   {len(files) + 1 + (data_raw is not None)} ({unpacked / 1e6:.1f} MB unpacked, "
          f"{out.stat().st_size / 1e6:.1f} MB zipped)")
    print("folders: " + ", ".join(f"{k} {v}" for k, v in sorted(groups.items())))
    print("data:    " + (f"INCLUDED: data/data.json ({len(data_raw)} bytes) - personal health data"
                         if data_raw is not None else "not included (your data stays on this computer)"))
    print(f"sha256:  {digest}")
    print("Check it on the server after copying:  sha256sum fitness-hub.zip")
    if data_raw is not None:
        print("WARNING: this zip holds your health data. It was written readable by you only (0600). Copy it only "
              "to your own server (scp), never upload or share it, and delete it from both machines once the "
              "hub is installed. Settings > Export as JSON, then Import on the server, avoids this file entirely.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
