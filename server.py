#!/usr/bin/env python3
"""Fitness Hub: a local, single-user web server (Python 3.10+, standard library only).

What it serves
* The static app from ./public (no directory listings, no dotfiles, never data/).
* A tiny JSON API backed by ./data/data.json (SPEC sections 5.7 and 5.7a):
    GET  /api/health   {ok, app, version, build, pid, instance, listen, data_bytes, last_backup, ...}
    GET  /api/data     the user's data, with a strong ETag (sha256 of the stored bytes)
    PUT  /api/data     replace the data. Needs If-Match (428 if missing, 412 if stale) and, when the
                       hub runs a bundled build, X-Hub-Build (409 build_mismatch if it differs).
    POST /api/backup   write a timestamped manual backup (rate-limited)

Where it listens (nowhere else, ever)
* TCP loopback, the default (for example on a Windows PC): 127.0.0.1:8642. Any other address is refused,
  and the socket is checked again after binding.
* A Unix socket (for example on a Linux home server): FITNESS_HUB_SOCKET, created 0600 in a 0700 folder that
  belongs to this user, and no TCP listener at all. The PC reaches it through
  `ssh -L 127.0.0.1:8642:/run/user/<uid>/fitness-hub/hub.sock`.
* Opt-in phone access (Linux, socket mode only): FITNESS_HUB_TS_SOCKET, a SECOND Unix socket in
  the same 0700 folder (also 0600), for Tailscale Serve (`tailscale serve --https=443 unix:...`).
  It has its own policy (TailscalePolicy): every request must carry the Tailscale-User-Login that
  Serve adds, for one of FITNESS_HUB_TS_USERS, X-Forwarded-Host = FITNESS_HUB_TS_HOST and
  X-Forwarded-Proto = https.
  Still no TCP listener. Funnel is never supported (its traffic carries no identity).

Security model
* There is no login. The listener is the boundary: loopback, or a socket only this user can open.
  On the Tailscale socket the identity Serve vouches for is checked as well (allowlist, no fallback).
* Browser attacks are blocked with a Host allowlist (DNS rebinding), a custom header plus a JSON
  content type and Origin / Sec-Fetch-Site checks on writes (CSRF), and strict response headers
  (CSP, nosniff, frame denial, CORP). No CORS headers are ever sent.
* On the main listener, any request carrying proxy or identity headers (Forwarded, X-Forwarded-*,
  X-Real-IP, Via, Tailscale-*, ...) gets 403: it is reached directly or through the SSH tunnel,
  never through a proxy. The Tailscale listener allows exactly the headers Serve adds, nothing else.
* Slow or greedy clients are bounded by header and body deadlines, a body cap, a JSON depth cap,
  one-at-a-time parsing and a connection cap. Logs never contain request bodies or user data (the
  Tailscale listener logs the allowed login: the user's own identity).

Run:  python3 server.py [--open] [--check]
Env:  FITNESS_HUB_HOST           127.0.0.1 (default) | ::1 | localhost. Anything else is refused.
      FITNESS_HUB_PORT           default 8642. In socket mode, the port the tunnel's Host header names.
      FITNESS_HUB_SOCKET         Linux only: listen on this Unix socket instead of TCP (no TCP at all).
      FITNESS_HUB_TS_SOCKET      opt-in phone access, all three or none (Linux, with FITNESS_HUB_SOCKET):
      FITNESS_HUB_TS_HOST          the Tailscale socket, this server's exact <machine>.<tailnet>.ts.net
      FITNESS_HUB_TS_USERS         name, and the allowed Tailscale logins (comma-separated, exact).
      FITNESS_HUB_DATA_DIR       default ./data (the automated tests use a temporary folder)
      FITNESS_HUB_LOG_LEVEL      debug | info (default) | warning | error
      FITNESS_HUB_TIMEOUT_SCALE  0.05-1 (default 1). Only shortens the timeouts; used by tests.
File: BUILD_ID next to server.py (deploy/make_bundle.py writes it into bundles). Without it the
      build is "dev" and X-Hub-Build is not checked.
"""
from __future__ import annotations

import argparse
import array
import collections
import dataclasses
import datetime as _dt
import email.utils
import errno
import gzip
import hashlib
import http.client
import http.server
import io
import ipaddress
import itertools
import json
import logging
import math
import os
import platform
import re
import secrets
import signal
import socket
import stat
import sys
import threading
import time
import webbrowser
from http import HTTPStatus
from pathlib import Path

APP_NAME = "fitness-hub"
APP_VERSION = "1.2"
ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = (ROOT / "public").resolve()
BUILD_FILE = ROOT / "BUILD_ID"
DEV_BUILD = "dev"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8642
LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")
HAS_UNIX_SOCKETS = hasattr(socket, "AF_UNIX")
MAX_SOCKET_PATH = 100               # bytes; sun_path holds 108 on Linux (104 on macOS), NUL included

MAX_BODY_BYTES = 10 * 1024 * 1024   # PUT /api/data
MAX_BACKUP_BODY_BYTES = 1024        # POST /api/backup (its body is ignored)
MAX_JSON_DEPTH = 64                 # nested arrays/objects; real data needs fewer than 10
MAX_CONNECTIONS = 32                # at once; a browser opens at most 6 per host
HEADER_TIMEOUT = 10.0               # seconds for the request line and headers
BODY_TIMEOUT = 60.0                 # seconds for the whole request body
IO_TIMEOUT = 15.0                   # seconds any single read or write may stall
SHUTDOWN_GRACE = 5.0                # seconds in-flight requests get on SIGTERM/SIGINT
STATIC_CACHE = "no-cache"           # app files: revalidate on every use (a cheap 304), so a reload gets new code
TEMP_NAME_TRIES = 10                # atomic_write: random temp names tried; only a name clash is retried
DAILY_BACKUPS_KEPT = 60
MANUAL_BACKUPS_KEPT = 60
AUTO_BACKUPS_KEPT = 30
SHRINK_RECORDS = 5                  # a save that drops more than this many records from any list...
SHRINK_FRACTION = 0.10              # ...or more than this share of them is preceded by an auto backup
BACKUP_WINDOW_S = 600.0             # POST /api/backup writes at most BACKUP_WINDOW_MAX new files
BACKUP_WINDOW_MAX = 10              # per BACKUP_WINDOW_S seconds (unchanged data reuses the last one)
GZIP_MIN_BYTES = 1024               # smaller responses aren't worth compressing
GZIP_LEVEL = 6
STATIC_GZIP_CACHE_BYTES = 16 * 1024 * 1024
MAX_SHAPE_DEPTH = 8                 # how deep (object keys plus list levels) the shrink check looks for lists
MAX_SHAPE_ENTRIES = 5000            # distinct list paths it tracks
MAX_SHAPE_NODES = 2_000_000         # objects and lists it visits; past either limit it plays safe (takes a copy)
SHAPE_ITEMS = None                  # in a shape path: "each item of the list here"
SHAPE_TRUNCATED = (None,)           # shape key of a document too big to walk (no real path starts with None)

DAILY_RE = re.compile(r"^data-\d{4}-\d{2}-\d{2}\.json$")
MANUAL_RE = re.compile(r"^manual-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.json$")
AUTO_RE = re.compile(r"^auto-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.json$")
# The date, time and -N of a backup's name (data-DATE, manual-DATE-TIME[-N], auto-DATE-TIME[-N]).
BACKUP_STAMP = re.compile(r"-(\d{4}-\d{2}-\d{2})(?:-(\d{6})(?:-(\d+))?)?\.json$")
TEMP_RE = re.compile(r"^\.(?:tmp-.+\.json|check-\d+\.tmp)$")
BUILD_RE = re.compile(r"[A-Za-z0-9._-]{1,64}")
INSTANCE_FILE = ".hub.instance"
# One URL path segment: letters, digits, dot, dash, underscore; never a leading dot.
SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*$")
# Windows device names must never reach open().
WINDOWS_RESERVED = re.compile(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$", re.IGNORECASE)
DIGITS = re.compile(r"[0-9]{1,12}")
ETAG_ITEM = re.compile(r'\s*(W/)?"([^"]*)"\s*')
UTF8_BOM = b"\xef\xbb\xbf"

# Request headers that only a proxy adds. Browsers never send them, so a request carrying one
# reached the hub through something other than this computer's browser or the SSH tunnel.
PROXY_HEADERS = frozenset({
    "forwarded", "via", "x-real-ip", "true-client-ip", "x-client-ip", "x-cluster-client-ip",
    "cf-connecting-ip", "fastly-client-ip", "x-original-forwarded-for",
})
PROXY_PREFIXES = ("x-forwarded", "tailscale-")  # X-Forwarded-For/-Host/-Proto/...; Tailscale Serve identity

# Opt-in phone access over Tailscale: all three settings or none (Linux, socket mode only).
TS_VARS = ("FITNESS_HUB_TS_SOCKET", "FITNESS_HUB_TS_HOST", "FITNESS_HUB_TS_USERS")
# This server's MagicDNS name, <machine>.<tailnet>.ts.net: lowercase DNS labels, no port, no wildcard.
TS_HOST_RE = re.compile(r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}ts\.net")
# One Tailscale login as Serve sends it in Tailscale-User-Login (you@example.com, you@github).
# ASCII only: Serve RFC 2047-encodes non-ASCII values, which an exact compare could never match.
TS_LOGIN_RE = re.compile(r"[a-z0-9!#$%&'+/=^_`{|}~.-]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?")

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; "
    "frame-ancestors 'none'; form-action 'self'"
)
SECURITY_HEADERS = (
    ("Content-Security-Policy", CSP),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("X-Frame-Options", "DENY"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
)

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".webmanifest": "application/manifest+json",
}
COMPRESSIBLE = ("text/", "application/json", "application/manifest+json", "image/svg+xml")

LOG = logging.getLogger(APP_NAME)


# ------------------------------------------------------------------ logging
def _log_value(value) -> str:
    """One logfmt value: ASCII only, control characters escaped, quoted when needed."""
    text = str(value)
    if len(text) > 200:
        text = text[:200] + "..."
    text = text.encode("unicode_escape").decode("ascii")
    if not text or any(ch in text for ch in ' "='):
        text = '"' + text.replace('"', '\\"') + '"'
    return text


def log_event(level: int, event: str, **fields) -> None:
    """Structured log line: `event=<name> key=value ...`. Never pass request bodies or user data."""
    if LOG.isEnabledFor(level):
        parts = [f"event={event}"]
        parts += [f"{key}={_log_value(val)}" for key, val in fields.items() if val is not None]
        LOG.log(level, " ".join(parts))


def setup_logging(level_name: str) -> None:
    levels = {"debug": logging.DEBUG, "info": logging.INFO, "warning": logging.WARNING, "error": logging.ERROR}
    handler = logging.StreamHandler(sys.stderr)
    # Under systemd the journal adds its own timestamps.
    fmt = "%(levelname)s %(message)s" if os.environ.get("JOURNAL_STREAM") else "%(asctime)s %(levelname)s %(message)s"
    handler.setFormatter(logging.Formatter(fmt, datefmt="%Y-%m-%d %H:%M:%S"))
    LOG.handlers[:] = [handler]
    LOG.setLevel(levels.get(level_name, logging.INFO))
    LOG.propagate = False


# -------------------------------------------------------------------- JSON
def default_data() -> dict:
    """The starting user-data document (SPEC section 5.7)."""
    return {
        "schema_version": 1,
        "profile": {
            "name": "",
            "sex": None,
            "birth_year": None,
            "height_cm": None,
            "injured_arm": None,
            "dominant_hand": None,
            "injury_date": None,
            "program_start": None,
            "activity_factor": 1.55,
            "surplus_kcal": 300,
            "protein_g_per_kg": 1.8,
            "hrmax_override": None,
            "rhr_baseline": None,
            "diet_notes": "",
            "clearances": {
                "good_arm_ok": None,
                "clinic_light": None,
                "grip_cleared": None,
                "full_clearance": None,
            },
        },
        "checkins": [],
        "workouts": [],
        "hikes": [],
        "tests": [],
        "measurements": [],
        "arm": {
            "appointments": [],
            "logs": [],
            "physio_exercises": [],
        },
        "weekly_reviews": [],
    }


class JsonTooDeep(ValueError):
    pass


def _reject_constant(name: str):
    raise ValueError(f"non-standard JSON constant {name!r} is not allowed")


_JSON_ESCAPE = re.compile(rb"\\.", re.DOTALL)
_JSON_STRING = re.compile(rb'"[^"]*"')
_NOT_BRACKETS = bytes(b for b in range(256) if b not in b"[]{}")
_BRACKET_STEP = bytes.maketrans(b"[{]}", b"\x01\x01\xff\xff")
_SURROGATE_HINT = re.compile(rb"\\u[dD][89a-fA-F]")
_JSON_ESCAPES = re.compile(rb"\\(?:u([0-9a-fA-F]{4})|.)", re.DOTALL)


def json_too_deep(raw: bytes, limit: int = MAX_JSON_DEPTH) -> bool:
    """True if arrays/objects nest deeper than `limit`. Linear time, no recursion.

    Escape pairs are removed first, then strings, so brackets inside strings don't count.
    On malformed input this can only over-estimate (the parser stops at the first error),
    so json.loads never recurses deeper than `limit` after this check passes."""
    if raw.count(b"[") + raw.count(b"{") <= limit:
        return False
    skeleton = _JSON_STRING.sub(b"", _JSON_ESCAPE.sub(b"", raw)).translate(None, _NOT_BRACKETS)
    if not skeleton:
        return False
    steps = array.array("b", skeleton.translate(_BRACKET_STEP))
    return max(itertools.accumulate(steps)) > limit


def parse_json_document(raw: bytes):
    """Strict JSON from bytes: UTF-8 (a BOM is allowed), no NaN/Infinity, bounded nesting."""
    if json_too_deep(raw):
        raise JsonTooDeep(f"JSON is nested more than {MAX_JSON_DEPTH} levels deep")
    return json.loads(raw.decode("utf-8-sig"), parse_constant=_reject_constant)


def has_lone_surrogate(raw: bytes) -> bool:
    """True if a \\uD800-\\uDFFF escape is not half of a proper high+low pair.

    Only meaningful for text that already parsed as JSON, where escapes occur only inside
    strings. Such text can't be stored or re-read as UTF-8 reliably, so it is refused."""
    if not _SURROGATE_HINT.search(raw):
        return False
    awaiting_low_at = -1  # end offset of a high-surrogate escape that needs a low one right after it
    for match in _JSON_ESCAPES.finditer(raw):
        code = match.group(1)
        value = int(code, 16) if code is not None else -1
        if awaiting_low_at >= 0:
            if match.start() == awaiting_low_at and 0xDC00 <= value <= 0xDFFF:
                awaiting_low_at = -1
                continue
            return True
        if 0xD800 <= value <= 0xDBFF:
            awaiting_low_at = match.end()
        elif 0xDC00 <= value <= 0xDFFF:
            return True
    return awaiting_low_at >= 0


def dump_json(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def strong_etag(payload: bytes) -> str:
    return '"' + hashlib.sha256(payload).hexdigest() + '"'


def parse_etag_list(value: str) -> list[tuple[bool, str]] | None:
    """Parse If-Match / If-None-Match into [(weak, '"opaque"'), ...]; '*' gives [(False, '*')].

    Returns None when the value is malformed (for example an unquoted tag)."""
    value = value.strip()
    if value == "*":
        return [(False, "*")]
    items: list[tuple[bool, str]] = []
    pos = 0
    while pos < len(value):
        match = ETAG_ITEM.match(value, pos)
        if not match:
            return None
        items.append((bool(match.group(1)), f'"{match.group(2)}"'))
        pos = match.end()
        if pos < len(value):
            if value[pos] != ",":
                return None
            pos += 1
    return items or None


def accepts_gzip(value: str) -> bool:
    """Does an Accept-Encoding value allow gzip (q > 0), by name or through '*'?"""
    gzip_q = star_q = None
    for item in value.split(","):
        name, _, params = item.partition(";")
        name = name.strip().lower()
        if not name:
            continue
        q = 1.0
        for param in params.split(";"):
            key, _, raw = param.partition("=")
            if key.strip().lower() == "q":
                try:
                    q = float(raw.strip())
                except ValueError:
                    q = 0.0
        if name in ("gzip", "x-gzip"):
            gzip_q = q if gzip_q is None else max(gzip_q, q)
        elif name == "*":
            star_q = q
    if gzip_q is not None:
        return gzip_q > 0
    return star_q is not None and star_q > 0


_WALK_DONE = object()


def array_shape(doc) -> dict:
    """{path: records} for every list in the document, nested lists included.

    A path is the object keys that lead to a list, with SHAPE_ITEMS (None) standing for "each item
    of a list", so the lists inside a list's records are added up: ("checkins",) is the number of
    check-ins, ("arm", "logs") the number of arm logs, and ("workouts", None, "exercises") the
    number of exercises over all workouts. The walk keeps O(depth) memory and is bounded by
    MAX_SHAPE_DEPTH, MAX_SHAPE_ENTRIES and MAX_SHAPE_NODES; a document too big for it gets the
    key SHAPE_TRUNCATED, which shrinkage() treats as a shrink (better an extra copy than none)."""
    shape: dict[tuple, int] = {}
    if not isinstance(doc, dict):
        return shape
    budget = MAX_SHAPE_NODES
    stack = [((), iter(doc.items()))]  # (path of a container, its remaining (key, child) pairs)
    while stack:
        path, children = stack[-1]
        child = next(children, _WALK_DONE)
        if child is _WALK_DONE:
            stack.pop()
            continue
        key, value = child
        if not isinstance(value, (dict, list)):
            continue
        budget -= 1
        if budget < 0 or len(shape) >= MAX_SHAPE_ENTRIES:
            shape[SHAPE_TRUNCATED] = 1
            break
        here = path + (key,)
        if isinstance(value, list):
            shape[here] = shape.get(here, 0) + len(value)
            if len(here) < MAX_SHAPE_DEPTH:
                stack.append((here, ((SHAPE_ITEMS, item) for item in value)))
        elif len(here) < MAX_SHAPE_DEPTH:
            stack.append((here, iter(value.items())))
    return shape


def shrinkage(before: dict, after: dict) -> tuple[int, int]:
    """(lists that lost more than SHRINK_RECORDS records or SHRINK_FRACTION of them, largest drop).

    Lists are compared path by path (array_shape), so emptying the exercises of every workout
    counts even though no workout was removed. A list that disappeared, or stopped being a list,
    counts as emptied, and a shape too big to walk counts as a shrink."""
    if SHAPE_TRUNCATED in before or SHAPE_TRUNCATED in after:
        return 1, 0
    count = worst = 0
    for path, old_len in before.items():
        drop = old_len - after.get(path, 0)
        if drop > SHRINK_RECORDS or (drop > 0 and drop > old_len * SHRINK_FRACTION):
            count += 1
            worst = max(worst, drop)
    return count, worst


# --------------------------------------------------------------- files
def _is_within(child: Path, parent: Path) -> bool:
    c = os.path.normcase(str(child))
    p = os.path.normcase(str(parent)).rstrip("\\/")
    return c == p or c.startswith(p + os.sep)


def fsync_dir(folder: Path) -> None:
    """Make a rename durable on POSIX. Windows can't open folders like this (NTFS journals it)."""
    if os.name == "nt":
        return
    try:
        fd = os.open(str(folder), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass  # some filesystems don't support fsync on a directory
    finally:
        os.close(fd)


def new_temp_file(folder: Path) -> tuple[int, Path]:
    """(fd, path) of a new, private (0600) temp file in `folder`, named .tmp-<random>.json.

    Not tempfile.mkstemp: on Windows that retries up to 2**31 names for as long as creating one
    raises PermissionError (Controlled Folder Access, a folder this account may not write), which
    hangs a save at 100% CPU with the write lock held. Here only a name clash gets another random
    name, at most TEMP_NAME_TRIES times; PermissionError and every other OSError are raised at once."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    for _ in range(TEMP_NAME_TRIES):
        tmp = folder / f".tmp-{secrets.token_hex(8)}.json"
        try:
            return os.open(str(tmp), flags, 0o600), tmp
        except FileExistsError:
            continue
    raise FileExistsError(errno.EEXIST, f"no free temporary file name after {TEMP_NAME_TRIES} tries", str(folder))


def atomic_write(path: Path, payload: bytes) -> None:
    """Temp file (0600) in the same folder, fsync it, os.replace over the target, fsync the folder.
    A folder that can't be written fails fast with its OSError (see new_temp_file)."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = new_temp_file(path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(10):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                # Windows: a virus scanner or editor may briefly hold the target open.
                if attempt == 9:
                    raise
                time.sleep(0.05 * (attempt + 1))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    fsync_dir(path.parent)


def backup_order(name: str, mtime_ns: int) -> tuple:
    """Sort key of a backup file, oldest first: the date and time in its name, its -N, then its mtime."""
    match = BACKUP_STAMP.search(name)
    if match is None:
        return ("", "", 0, mtime_ns, name)
    day, clock, n = match.groups()
    return (day, clock or "", int(n or 1), mtime_ns, name)


def prune(folder: Path, pattern: re.Pattern, keep: int, *, protect=()) -> int:
    """Delete all but the `keep` newest matching files.

    Newest by the date and time in the name (the hub writes it), with the mtime only breaking ties,
    so copied or touched files and wrong or future mtimes can't push new copies out. Names in
    `protect` (the file just written; today's daily copy) are never deleted."""
    found = []
    try:
        entries = list(os.scandir(folder))
    except OSError:
        return 0
    for entry in entries:
        if not pattern.match(entry.name):
            continue
        try:
            info = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        if stat.S_ISREG(info.st_mode):
            found.append((backup_order(entry.name, info.st_mtime_ns), entry.name))
    found.sort()
    protected = set(protect)
    removed = 0
    for _, name in (found[:-keep] if keep > 0 else found):
        if name in protected:
            continue
        try:
            os.unlink(folder / name)
            removed += 1
        except OSError:
            pass
    return removed


def os_error_name(exc: OSError) -> str:
    return errno.errorcode.get(exc.errno or 0, exc.__class__.__name__)


# Process-wide: every read-check-write of the data file holds this lock, so concurrent
# PUTs are serialised and an If-Match check can never race another save.
WRITE_LOCK = threading.Lock()
# Parsing a body of up to 10 MB takes a moment and several times its size in memory, so
# parses (request bodies and the stored file) run one at a time. Never held while waiting
# for WRITE_LOCK (WRITE_LOCK may be held while taking this one).
PARSE_LOCK = threading.Lock()


def parse_serialised(raw: bytes):
    with PARSE_LOCK:
        return parse_json_document(raw)


def _stat_key(info: os.stat_result) -> tuple:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


@dataclasses.dataclass(frozen=True)
class FileState:
    """What the hub knows about data.json, valid for as long as its stat key is unchanged."""
    key: tuple
    etag: str
    size: int
    valid: bool
    shape: dict = dataclasses.field(default_factory=dict, compare=False, repr=False)


@dataclasses.dataclass(frozen=True)
class SaveResult:
    status: str  # "saved" | "unchanged" | "conflict" | "damaged"
    etag: str
    size: int = 0
    auto_backup: str | None = None


class BackupRateLimited(Exception):
    def __init__(self, retry_after: int):
        super().__init__(retry_after)
        self.retry_after = retry_after


class FolderUnusable(OSError):
    """A save or backup failed because one of the hub's folders can't be used: no permission,
    Windows Controlled Folder Access, a file where the folder should be, a full disk. `role` is
    "data" or "backups"; the 500 reply names the folder and what to check (folder_problem)."""

    def __init__(self, role: str, folder: Path, cause: OSError):
        super().__init__(cause.errno, cause.strerror or str(cause))
        self.role = role
        self.folder = folder
        self.cause = cause


def folder_problem(exc: FolderUnusable, doing: str) -> str:
    """The error text for a FolderUnusable: what failed, the folder, and what to check."""
    if os.name == "nt":
        check = ("Check the folder's permissions, and that Windows Controlled Folder Access allows Python "
                 "(Windows Security > Virus & threat protection > Ransomware protection).")
    else:
        check = f"Check the folder's owner and permissions: ls -ld {exc.folder}"
    return (f"{doing}: the {exc.role} folder {exc.folder} can't be used ({exc.cause.__class__.__name__}). "
            f"Nothing was written. {check}")


class HubStore:
    def __init__(self, data_dir: Path, *, clock=time.monotonic):
        self.data_dir = data_dir
        self.data_file = data_dir / "data.json"
        self.backup_dir = data_dir / "backups"
        self.lock = WRITE_LOCK
        self._clock = clock
        self._state_cache: FileState | None = None
        self._gzip_cache: tuple[str, bytes] | None = None
        self._manual_times: collections.deque = collections.deque()
        self._last_manual: tuple[str, Path] | None = None

    # ------------------------------------------------------------ state
    def _state(self, want_bytes: bool = False) -> tuple[FileState, bytes | None]:
        """data.json's ETag and validity, cached by its stat (lock held).

        The file is only read and parsed when it changed outside the hub (or on first use);
        after the hub's own saves the cache is set from what was written."""
        for _ in range(5):
            try:
                info = os.stat(self.data_file)
            except FileNotFoundError:
                self._create_default()
                continue
            key = _stat_key(info)
            cached = self._state_cache
            if cached is not None and cached.key == key:
                return cached, (self.data_file.read_bytes() if want_bytes else None)
            raw = self.data_file.read_bytes()
            try:
                unchanged = _stat_key(os.stat(self.data_file)) == key
            except FileNotFoundError:
                unchanged = False
            if not unchanged:
                continue  # replaced while we read it: look again
            state = self._evaluate(key, raw)
            self._state_cache = state
            return state, raw
        raise OSError(errno.EAGAIN, "data.json kept changing while it was read")

    @staticmethod
    def _evaluate(key: tuple, raw: bytes) -> FileState:
        try:
            doc = parse_serialised(raw)
        except (ValueError, RecursionError):
            doc = None
        valid = isinstance(doc, dict)
        return FileState(key, strong_etag(raw), len(raw), valid, array_shape(doc) if valid else {})

    def _remember(self, payload: bytes, shape: dict) -> FileState:
        """Cache what the hub itself just wrote (lock held): no re-read and no re-parse."""
        state = FileState(_stat_key(os.stat(self.data_file)), strong_etag(payload), len(payload), True, shape)
        self._state_cache = state
        self._gzip_cache = None
        return state

    def _create_default(self) -> None:
        doc = default_data()
        payload = dump_json(doc)
        try:
            atomic_write(self.data_file, payload)
        except OSError as exc:
            raise FolderUnusable("data", self.data_dir, exc) from exc
        self._remember(payload, array_shape(doc))
        log_event(logging.INFO, "created", file=self.data_file.name)

    def current_etag(self) -> str:
        """The stored file's strong ETag (creates the default document if there is none)."""
        with self.lock:
            return self._state()[0].etag

    def read(self) -> bytes:
        with self.lock:
            return self._state(want_bytes=True)[1]

    def snapshot(self, not_modified=None) -> tuple[FileState, bytes | None]:
        """(state, stored bytes) for GET /api/data. If the file is valid and
        not_modified(state.etag) is true, the file isn't read at all (bytes is None: send 304)."""
        with self.lock:
            state, _ = self._state()
            if state.valid and not_modified is not None and not_modified(state.etag):
                return state, None
            return self._state(want_bytes=True)

    def gzipped(self, state: FileState, raw: bytes) -> bytes:
        cached = self._gzip_cache
        if cached is not None and cached[0] == state.etag:
            return cached[1]
        body = gzip.compress(raw, compresslevel=GZIP_LEVEL, mtime=0)
        self._gzip_cache = (state.etag, body)
        return body

    # ------------------------------------------------------------ saving
    def save(self, payload: bytes, if_match: list[str], shape: dict | None = None) -> SaveResult:
        """Store `payload` exactly as given, only if data.json still has one of these strong ETags.

        `shape` is array_shape() of the payload (the caller has parsed it already); before a
        save that shrinks any list a lot (nested lists included), the current file is copied to
        backups/auto-*.json. If a copy can't be written, nothing is saved (FolderUnusable)."""
        with self.lock:
            state, _ = self._state()
            if state.etag not in if_match:
                return SaveResult("conflict", state.etag)
            if not state.valid:
                return SaveResult("damaged", state.etag)  # never overwrite a damaged file
            new_tag = strong_etag(payload)
            if new_tag == state.etag:
                return SaveResult("unchanged", new_tag, len(payload))
            if shape is None:
                shape = array_shape(parse_serialised(payload))
            daily = self.backup_dir / f"data-{_dt.date.today().isoformat()}.json"
            arrays, worst = shrinkage(state.shape, shape)
            auto_name = None
            try:
                need_daily = not daily.exists()  # may raise PermissionError on an unreadable folder
            except OSError as exc:
                raise FolderUnusable("backups", self.backup_dir, exc) from exc
            if arrays or need_daily:
                current = self.data_file.read_bytes()
                if strong_etag(current) != state.etag:  # replaced behind the hub's back: start over
                    self._state_cache = None
                    return SaveResult("conflict", self._state()[0].etag)
                try:
                    if need_daily:
                        atomic_write(daily, current)
                        prune(self.backup_dir, DAILY_RE, DAILY_BACKUPS_KEPT, protect={daily.name})
                        log_event(logging.INFO, "backup", kind="daily", file=daily.name)
                    if arrays:
                        dest = self._stamped("auto")
                        atomic_write(dest, current)
                        prune(self.backup_dir, AUTO_RE, AUTO_BACKUPS_KEPT, protect={dest.name})
                        auto_name = dest.name
                        log_event(logging.INFO, "backup", kind="auto", file=dest.name, arrays=arrays, max_drop=worst)
                except OSError as exc:  # no safety copy, no save
                    raise FolderUnusable("backups", self.backup_dir, exc) from exc
            try:
                atomic_write(self.data_file, payload)
            except OSError as exc:
                raise FolderUnusable("data", self.data_dir, exc) from exc
            self._remember(payload, shape)
            return SaveResult("saved", new_tag, len(payload), auto_name)

    def _stamped(self, prefix: str) -> Path:
        stamp = _dt.datetime.now().strftime("%Y-%m-%d-%H%M%S")
        dest = self.backup_dir / f"{prefix}-{stamp}.json"
        n = 2
        while dest.exists():
            dest = self.backup_dir / f"{prefix}-{stamp}-{n}.json"
            n += 1
        return dest

    def manual_backup(self) -> tuple[Path, bool]:
        """(backup file, reused). When the data hasn't changed since the last manual backup, that
        file is returned again; otherwise at most BACKUP_WINDOW_MAX new files per BACKUP_WINDOW_S."""
        with self.lock:
            state, raw = self._state(want_bytes=True)
            last = self._last_manual
            if last is not None and last[0] == state.etag and last[1].is_file():
                return last[1], True
            now = self._clock()
            times = self._manual_times
            while times and now - times[0] >= BACKUP_WINDOW_S:
                times.popleft()
            if len(times) >= BACKUP_WINDOW_MAX:
                raise BackupRateLimited(max(1, math.ceil(times[0] + BACKUP_WINDOW_S - now)))
            try:
                dest = self._stamped("manual")
                atomic_write(dest, raw)
            except OSError as exc:
                raise FolderUnusable("backups", self.backup_dir, exc) from exc
            times.append(now)
            self._last_manual = (strong_etag(raw), dest)
            prune(self.backup_dir, MANUAL_RE, MANUAL_BACKUPS_KEPT, protect={dest.name})
        log_event(logging.INFO, "backup", kind="manual", file=dest.name)
        return dest, False

    # ------------------------------------------------------------ status
    def health(self) -> dict:
        try:
            size = self.data_file.stat().st_size
        except OSError:
            size = None
        count, newest_name, newest_mtime = 0, None, None
        try:
            entries = list(os.scandir(self.backup_dir))
        except OSError:
            entries = []
        for entry in entries:
            if not (DAILY_RE.match(entry.name) or MANUAL_RE.match(entry.name) or AUTO_RE.match(entry.name)):
                continue
            try:
                mtime = entry.stat(follow_symlinks=False).st_mtime
            except OSError:
                continue
            count += 1
            if newest_mtime is None or mtime > newest_mtime:
                newest_name, newest_mtime = entry.name, mtime
        last = None
        if newest_mtime is not None:
            last = _dt.datetime.fromtimestamp(newest_mtime).astimezone().isoformat(timespec="seconds")
        return {
            "data_bytes": size,
            "last_backup": last,
            "last_backup_file": newest_name,
            "backups": count,
            "data_file": str(self.data_file),
            "backup_dir": str(self.backup_dir),
        }

    def cleanup_temp_files(self) -> int:
        """Remove temp files a crash may have left. Only call this while holding DataDirLock."""
        removed = 0
        for folder in (self.data_dir, self.backup_dir):
            try:
                entries = list(folder.iterdir())
            except OSError:
                continue
            for entry in entries:
                if TEMP_RE.match(entry.name) and entry.is_file():
                    try:
                        entry.unlink()
                        removed += 1
                    except OSError:
                        pass
        if removed:
            log_event(logging.INFO, "cleanup", temp_files=removed)
        return removed


class DataDirLock:
    """One hub per data folder: an exclusive OS lock held for the life of the process."""

    def __init__(self, data_dir: Path):
        self.path = data_dir / ".hub.lock"
        self._fd: int | None = None

    def acquire(self) -> bool:
        fd = os.open(str(self.path), os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o600)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return False
        self._fd = fd
        return True

    def release(self) -> None:
        if self._fd is not None:
            os.close(self._fd)  # closing releases the lock on every platform
            self._fd = None


def write_instance(data_dir: Path, record: dict) -> None:
    """Record which process serves this data folder, and where (read back by running_hub)."""
    atomic_write(data_dir / INSTANCE_FILE, json.dumps(record).encode("utf-8"))


def read_instance(data_dir: Path) -> dict | None:
    try:
        raw = (data_dir / INSTANCE_FILE).read_bytes()
        record = json.loads(raw) if len(raw) <= 4096 else None
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def remove_instance(data_dir: Path, instance: str) -> None:
    record = read_instance(data_dir)
    if record is not None and record.get("instance") == instance:
        try:
            (data_dir / INSTANCE_FILE).unlink()
        except OSError:
            pass


# ----------------------------------------------------------------- settings
class ConfigError(Exception):
    pass


class NonLoopbackBind(RuntimeError):
    pass


class UnsafeSocket(RuntimeError):
    """The socket path or its folder is not private to this user: refuse to serve there."""


class SocketInUse(RuntimeError):
    """Something already accepts connections on the socket path."""


@dataclasses.dataclass(frozen=True)
class Timeouts:
    header: float = HEADER_TIMEOUT
    body: float = BODY_TIMEOUT
    io: float = IO_TIMEOUT


@dataclasses.dataclass(frozen=True)
class TailscaleSettings:
    """Opt-in phone access (FITNESS_HUB_TS_*): the second Unix socket that Tailscale Serve proxies
    to, the exact MagicDNS name the phone opens, and the Tailscale logins allowed in (lowercase)."""
    socket_path: Path
    host: str
    users: tuple

    @property
    def origin(self) -> str:
        return f"https://{self.host}"

    @property
    def listen(self) -> str:
        return f"unix:{self.socket_path}"


@dataclasses.dataclass(frozen=True)
class Settings:
    bind_host: str | None          # None in socket mode (no TCP listener)
    url_host: str
    port: int                      # TCP port; in socket mode the tunnel port that Host headers name
    data_dir: Path
    socket_path: Path | None = None
    log_level: str = "info"
    timeouts: Timeouts = Timeouts()
    build: str = DEV_BUILD
    under_systemd: bool = False
    tailscale: TailscaleSettings | None = None  # opt-in phone access (a second Unix socket)

    @property
    def url(self) -> str:
        return f"http://{self.url_host}:{self.port}/"

    @property
    def listen(self) -> str:
        return f"unix:{self.socket_path}" if self.socket_path is not None else f"{self.bind_host}:{self.port}"


def read_build(path: Path = BUILD_FILE) -> str:
    """The build id from BUILD_ID (written into bundles by make_bundle.py), or "dev" without one."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return DEV_BUILD
    except OSError as exc:
        raise ConfigError(f"Can't read {path} ({os_error_name(exc)}).") from None
    text = raw.decode("ascii", "replace").strip()
    if not BUILD_RE.fullmatch(text):
        raise ConfigError(f"{path} doesn't hold a valid build id (1-64 letters, digits, '.', '_' or '-'). "
                          "Rebuild the bundle with deploy/make_bundle.py.")
    return text


def _socket_setting(name: str, raw: str, example: str) -> Path:
    """An absolute Unix socket path without '..' that fits in sun_path (POSIX rules on every OS)."""
    if "\x00" in raw or not raw.startswith("/") or ".." in raw.split("/"):
        raise ConfigError(f"{name}={raw!r} must be an absolute path without '..', such as {example}.")
    if len(os.fsencode(raw)) > MAX_SOCKET_PATH:
        raise ConfigError(f"{name} is longer than {MAX_SOCKET_PATH} bytes, the most a Unix socket path can be here.")
    return Path(raw)


def _ts_host_setting(raw: str) -> str:
    name = "FITNESS_HUB_TS_HOST"
    example = ("such as homeserver.tail1234.ts.net (this server's MagicDNS name: Self.DNSName in "
               "`tailscale status --json`, without the final dot)")
    host = raw.lower()
    if "<" in host or ">" in host:
        raise ConfigError(f"{name} still holds the placeholder {raw!r}: put in this server's Tailscale name, {example}.")
    if "*" in host or "?" in host:
        raise ConfigError(f"{name}={raw!r}: no wildcards. Give this server's exact Tailscale name, {example}.")
    if "/" in host:
        raise ConfigError(f"{name}={raw!r} must be a bare name, without https:// or a path, {example}.")
    if ":" in host:
        raise ConfigError(f"{name}={raw!r} must not include a port: Tailscale Serve answers on 443, and the "
                          f"name is compared exactly, {example}.")
    if not host.endswith(".ts.net"):
        raise ConfigError(f"{name}={raw!r} must end in .ts.net: it is this server's MagicDNS name, {example}.")
    if not TS_HOST_RE.fullmatch(host):
        raise ConfigError(f"{name}={raw!r} isn't a valid <machine>.<tailnet>.ts.net name (letters, digits and "
                          f"hyphens), {example}.")
    return host


def _ts_users_setting(raw: str) -> tuple:
    name = "FITNESS_HUB_TS_USERS"
    users: list[str] = []
    for item in raw.split(","):
        login = item.strip().lower()
        if not login:
            raise ConfigError(f"{name}={raw!r} has an empty entry: list the allowed Tailscale logins separated by "
                              "single commas, such as you@example.com")
        if "<" in login or ">" in login:
            raise ConfigError(f"{name} still holds a placeholder ({item.strip()!r}): put in the exact Tailscale "
                              "login(s) allowed to open the hub, such as you@example.com.")
        if "*" in login or "?" in login:
            raise ConfigError(f"{name}: no wildcards ({item.strip()!r}). List each allowed Tailscale login exactly, "
                              "such as you@example.com.")
        if not TS_LOGIN_RE.fullmatch(login):
            raise ConfigError(f"{name}: {item.strip()!r} isn't a Tailscale login such as you@example.com or "
                              "you@github (ASCII, one @, no spaces).")
        if login not in users:
            users.append(login)
    return tuple(users)


def resolve_tailscale(env, main_socket: Path | None, *, platform: str = sys.platform,
                      has_unix: bool = HAS_UNIX_SOCKETS) -> TailscaleSettings | None:
    """The opt-in Tailscale settings: None when all three are unset, else all three validated.
    Anything partial, unsafe or malformed raises ConfigError, so the hub refuses to start."""
    raw = {name: (env.get(name) or "").strip() for name in TS_VARS}
    if not any(raw.values()):
        return None
    missing = [name for name in TS_VARS if not raw[name]]
    if missing:
        raise ConfigError(
            f"Tailscale mode needs all three settings ({', '.join(TS_VARS)}), but {' and '.join(missing)} "
            f"{'is' if len(missing) == 1 else 'are'} not set. Set all three (deploy/tailscale.conf.example), "
            "or none of them for no phone access.")
    if not platform.startswith("linux") or not has_unix:
        raise ConfigError("Tailscale mode (FITNESS_HUB_TS_*) is for the Linux home server only. Remove those "
                          "settings here.")
    if main_socket is None:
        raise ConfigError("Tailscale mode runs only next to the socket mode: set FITNESS_HUB_SOCKET too (the "
                          "home-server service does). It never opens a TCP port.")
    ts_socket = _socket_setting("FITNESS_HUB_TS_SOCKET", raw["FITNESS_HUB_TS_SOCKET"],
                                str(main_socket.parent / "ts.sock"))
    if ts_socket == main_socket:
        raise ConfigError("FITNESS_HUB_TS_SOCKET must be a socket of its own, not FITNESS_HUB_SOCKET: the main "
                          "socket never accepts Tailscale traffic.")
    if ts_socket.parent != main_socket.parent:
        raise ConfigError(f"FITNESS_HUB_TS_SOCKET must be in the hub's private socket folder {main_socket.parent} "
                          f"(next to FITNESS_HUB_SOCKET), such as {main_socket.parent / 'ts.sock'}.")
    return TailscaleSettings(ts_socket, _ts_host_setting(raw["FITNESS_HUB_TS_HOST"]),
                             _ts_users_setting(raw["FITNESS_HUB_TS_USERS"]))


def resolve_settings(env, *, build_file: Path = BUILD_FILE) -> Settings:
    if (env.get("FITNESS_HUB_EXTRA_HOSTS") or "").strip():
        raise ConfigError(
            "FITNESS_HUB_EXTRA_HOSTS has been removed: it let a proxy reach the hub with no identity check.\n"
            "Phone access is the opt-in Tailscale mode instead (FITNESS_HUB_TS_*, deploy/tailscale.conf.example),\n"
            "gated by Tailscale identity. Remove the setting (`systemctl --user cat fitness-hub` shows where it is set).")
    raw_socket = (env.get("FITNESS_HUB_SOCKET") or "").strip()
    raw_host = (env.get("FITNESS_HUB_HOST") or "").strip().lower()
    socket_path = None
    if raw_socket:
        if not HAS_UNIX_SOCKETS:
            raise ConfigError("FITNESS_HUB_SOCKET needs Unix sockets, which Python lacks on this platform. "
                              "Leave it unset here: the hub then listens on 127.0.0.1 only.")
        if raw_host:
            raise ConfigError("Set FITNESS_HUB_SOCKET or FITNESS_HUB_HOST, not both: in socket mode the hub "
                              "has no TCP listener at all.")
        socket_path = _socket_setting("FITNESS_HUB_SOCKET", raw_socket, "/run/user/1000/fitness-hub/hub.sock")
    tailscale = resolve_tailscale(env, socket_path)
    host = raw_host or DEFAULT_HOST
    if host not in LOOPBACK_HOSTS:
        raise ConfigError(
            f"FITNESS_HUB_HOST={host!r} is not a loopback address.\n"
            "The hub has no login, so it only listens on 127.0.0.1, ::1 or localhost.\n"
            "To use it from another computer, use an SSH tunnel (see MIGRATE.md)."
        )
    raw_port = (env.get("FITNESS_HUB_PORT") or str(DEFAULT_PORT)).strip()
    if not DIGITS.fullmatch(raw_port) or not 1 <= int(raw_port) <= 65535:
        raise ConfigError(f"FITNESS_HUB_PORT={raw_port!r} is not a valid port.")
    port = int(raw_port)
    if socket_path is not None:
        bind_host, url_host = None, "127.0.0.1"  # the PC's end of the tunnel
    elif host == "::1":
        bind_host, url_host = "::1", "[::1]"
    else:
        bind_host, url_host = "127.0.0.1", host  # "localhost" binds 127.0.0.1 without asking DNS
    data_dir = Path(env.get("FITNESS_HUB_DATA_DIR") or (ROOT / "data")).resolve()
    if _is_within(data_dir, PUBLIC_DIR) or _is_within(PUBLIC_DIR, data_dir):
        raise ConfigError(
            f"FITNESS_HUB_DATA_DIR={str(data_dir)!r} would put your data inside, or around, the web "
            f"folder {str(PUBLIC_DIR)!r}. Choose a folder outside public/ (the default is ./data)."
        )
    log_level = (env.get("FITNESS_HUB_LOG_LEVEL") or "info").strip().lower()
    raw_scale = (env.get("FITNESS_HUB_TIMEOUT_SCALE") or "1").strip()
    try:
        scale = float(raw_scale)
    except ValueError:
        scale = -1.0
    if not 0.05 <= scale <= 1.0:
        raise ConfigError(f"FITNESS_HUB_TIMEOUT_SCALE={raw_scale!r} must be between 0.05 and 1.")
    timeouts = Timeouts(HEADER_TIMEOUT * scale, BODY_TIMEOUT * scale, IO_TIMEOUT * scale)
    return Settings(bind_host, url_host, port, data_dir, socket_path=socket_path, log_level=log_level,
                    timeouts=timeouts, build=read_build(build_file), under_systemd=bool(env.get("INVOCATION_ID")),
                    tailscale=tailscale)


# ------------------------------------------------------------ access policy
@dataclasses.dataclass(frozen=True)
class Authority:
    """One way the hub may be addressed: the exact Host values it answers to, the Origins that
    may write, and the proxy headers its requests may carry (none at all, for loopback).
    With origin_required, a write must carry exactly one Origin, and it must be one of origins."""
    name: str
    hosts: frozenset
    origins: frozenset
    proxy_headers_allowed: frozenset = frozenset()
    origin_required: bool = False

    def proxy_violations(self, header_names) -> list[str]:
        found = set()
        for raw in header_names:
            name = raw.strip().lower()
            if name in self.proxy_headers_allowed:
                continue
            if name in PROXY_HEADERS or name.startswith(PROXY_PREFIXES):
                found.add(name[:40])
        return sorted(found)[:5]

    def origin_ok(self, values) -> bool:
        """CSRF check of a write's Origin header values (all copies, in order)."""
        if not values:
            return not self.origin_required
        if self.origin_required and len(values) != 1:
            return False
        return values[0].strip().lower() in self.origins


@dataclasses.dataclass(frozen=True)
class Verdict:
    """A listener policy's answer for one request: the Authority to serve it under, or a refusal
    (always 403) with a short reason code for the log and the error text for the client."""
    authority: Authority | None = None
    reason: str = ""
    message: str = ""
    proxy_headers: tuple = ()
    fields: dict = dataclasses.field(default_factory=dict)  # extra JSON fields of the 403 body
    login: str | None = None  # the allowed Tailscale login (Tailscale listener only)

    @property
    def allowed(self) -> bool:
        return self.authority is not None


class AccessPolicy:
    """The main listener's policy: every Authority it answers to, looked up by the exact Host.

    Each server (listener) has its own policy object. The main one has one authority, "loopback":
    a browser on this computer or the SSH tunnel, addressed as 127.0.0.1:PORT or localhost:PORT,
    with no proxy or identity headers at all. It never trusts Tailscale-* or X-Forwarded-*.

    The opt-in Tailscale mode is a second listener (its own Unix socket) with its own policy,
    TailscalePolicy. Tailscale Serve sends `Host: localhost` to a unix: target, so that mode is
    bound to the listener a request arrives on, never to a Host value."""

    name = "loopback"

    def __init__(self, authorities):
        self.authorities = tuple(authorities)
        self._by_host = {host: authority for authority in self.authorities for host in authority.hosts}

    @classmethod
    def for_settings(cls, settings: Settings) -> "AccessPolicy":
        port = settings.port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if settings.bind_host == "::1":
            hosts.add(f"[::1]:{port}")
        origins = {f"http://{h}" for h in hosts}
        return cls([Authority("loopback", frozenset(hosts), frozenset(origins))])

    @property
    def hosts(self) -> frozenset:
        return frozenset(self._by_host)

    def authority_for(self, host: str) -> Authority | None:
        return self._by_host.get(host)

    def admit(self, headers) -> Verdict:
        """DNS-rebinding defence (a known Host), then the proxy tripwire (no proxy headers)."""
        values = headers.get_all("Host") or []
        host = values[0].strip().lower() if len(values) == 1 else ""
        authority = self.authority_for(host)
        if authority is None:
            return Verdict(reason="host", message="Forbidden: unexpected Host header.")
        bad = authority.proxy_violations(headers.keys())
        if bad:
            return Verdict(reason="proxy", proxy_headers=tuple(bad), fields={"proxy_headers": bad},
                           message="Forbidden: this request came through a proxy (" + ", ".join(bad) + "). The hub "
                                   "only answers a browser on its own computer or an SSH tunnel.")
        return Verdict(authority)


class TailscalePolicy:
    """The Tailscale listener's policy (FITNESS_HUB_TS_SOCKET). Fail closed: a request is served
    only if it carries what Tailscale Serve on this machine adds for an allowlisted login.

    * Host must be `localhost` (what Serve sends to a unix: target) or TS_HOST.
    * Only the headers Serve adds may appear: X-Forwarded-For/-Host/-Proto and the identity headers
      Tailscale-User-Login/-Name/-Profile-Pic (plus its informational Tailscale-Headers-Info), each
      at most once. Via, Forwarded, X-Real-IP, any other X-Forwarded-*, Tailscale-Funnel-Request
      (Funnel traffic) and any other Tailscale-* header get 403.
    * X-Forwarded-Host must be TS_HOST exactly, and X-Forwarded-Proto must be https: Serve sends
      both for its HTTPS listener, so a missing one is a 403 too.
    * Tailscale-User-Login must be one of the allowed logins (case-insensitive). Missing, empty or
      any other value is a 403: there is no fallback. Serve strips identity headers a client sends
      and adds none for tagged devices or Funnel traffic. Nothing but Serve (root) and this user can
      open the socket, so nothing else can forge them.
    Writes must also carry exactly `Origin: https://TS_HOST` (Authority.origin_required)."""

    name = "tailscale"
    SERVE_HEADERS = frozenset({"x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
                               "tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic",
                               "tailscale-headers-info"})
    LOCAL_HOST = "localhost"

    def __init__(self, ts: TailscaleSettings):
        users = frozenset(user.strip().lower() for user in ts.users if user and user.strip())
        if not users:
            raise ValueError("the Tailscale listener needs at least one allowed login")  # never allow-all
        self.ts_host = ts.host.lower()
        self.users = users
        self.authority = Authority("tailscale", frozenset({self.LOCAL_HOST, self.ts_host}),
                                   frozenset({f"https://{self.ts_host}"}), self.SERVE_HEADERS, origin_required=True)

    def _refuse(self, reason: str, message: str, headers=()) -> Verdict:
        fields = {"reason": reason}
        if headers:
            fields["proxy_headers"] = list(headers)
        return Verdict(reason=reason, message=message, proxy_headers=tuple(headers), fields=fields)

    def admit(self, headers) -> Verdict:
        if headers.get_all("Tailscale-Funnel-Request"):
            return self._refuse("funnel", "Forbidden: Tailscale Funnel (internet) traffic is never accepted.",
                                ("tailscale-funnel-request",))
        values = headers.get_all("Host") or []
        host = values[0].strip().lower() if len(values) == 1 else ""
        if host not in self.authority.hosts:
            return self._refuse("host", "Forbidden: unexpected Host header.")
        bad = self.authority.proxy_violations(headers.keys())
        if bad:
            return self._refuse("proxy", "Forbidden: this request carries headers that Tailscale Serve doesn't add ("
                                + ", ".join(bad) + ").", bad)
        repeated = sorted(name for name in self.SERVE_HEADERS if len(headers.get_all(name) or []) > 1)
        if repeated:
            return self._refuse("repeated", "Forbidden: repeated proxy or identity headers ("
                                + ", ".join(repeated) + ").", repeated[:5])
        if (headers.get("X-Forwarded-Host") or "").strip().lower() != self.ts_host:
            return self._refuse("forwarded_host", f"Forbidden: open the hub at https://{self.ts_host}/ through Tailscale.")
        if (headers.get("X-Forwarded-Proto") or "").strip().lower() != "https":  # missing counts as wrong
            return self._refuse("proto", f"Forbidden: open the hub at https://{self.ts_host}/ (HTTPS only).")
        login = (headers.get("Tailscale-User-Login") or "").strip().lower()
        if not login:
            return self._refuse("login_missing", "Forbidden: no Tailscale identity. Only devices signed in to Tailscale "
                                "as an allowed login can open the hub (tagged devices and Funnel traffic have none).")
        if login not in self.users:
            return self._refuse("login_not_allowed", "Forbidden: this Tailscale login isn't allowed to open the hub.")
        return Verdict(self.authority, login=login)


def ensure_loopback(sock: socket.socket) -> None:
    address = str(sock.getsockname()[0]).split("%", 1)[0]
    try:
        loopback = ipaddress.ip_address(address).is_loopback
    except ValueError:
        loopback = False
    if not loopback:
        raise NonLoopbackBind(address)


# ------------------------------------------------------------ unix socket
def check_socket_folder(folder: Path, *, create: bool) -> None:
    """The socket's folder must be a real folder owned by this user with no group or other access
    (700), inside a parent that others can't swap it out of. Anything else is refused.

    With create=True a missing folder is created 0700; otherwise FileNotFoundError is raised."""
    try:
        parent = os.stat(folder.parent)
    except FileNotFoundError:
        raise UnsafeSocket(f"{folder.parent} doesn't exist. It is the user's runtime folder "
                           "(XDG_RUNTIME_DIR): log in as the user, or enable linger.") from None
    if parent.st_mode & 0o022 and not parent.st_mode & stat.S_ISVTX:
        raise UnsafeSocket(f"{folder.parent} can be written by other users, who could swap the socket folder. "
                           "Use the runtime folder: FITNESS_HUB_SOCKET=$XDG_RUNTIME_DIR/fitness-hub/hub.sock")
    try:
        info = os.lstat(folder)
    except FileNotFoundError:
        if not create:
            raise
        os.mkdir(folder, 0o700)
        info = os.lstat(folder)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise UnsafeSocket(f"{folder} is not a plain folder (a link or a file)")
    if info.st_uid != os.geteuid():
        raise UnsafeSocket(f"{folder} belongs to another user")
    mode = stat.S_IMODE(info.st_mode)
    if mode & 0o077:
        raise UnsafeSocket(f"{folder} can be opened by other users (mode {mode:o}); it must be 700: chmod 700 {folder}")


def clear_stale_socket(path: Path) -> None:
    """Remove a socket file nobody listens on any more. Refuses to touch anything that isn't a
    socket, and raises SocketInUse if something accepts connections there."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(info.st_mode):
        raise UnsafeSocket(f"{path} exists and is not a socket, so it was left alone. "
                           "Remove it, or choose another FITNESS_HUB_SOCKET.")
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(2)
    try:
        probe.connect(str(path))
    except (ConnectionRefusedError, FileNotFoundError):
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        log_event(logging.INFO, "stale_socket_removed", path=str(path))
        return
    except (TimeoutError, BlockingIOError):
        raise SocketInUse(str(path)) from None  # a listener whose queue is full is still a listener
    except OSError as exc:
        raise UnsafeSocket(f"Can't check the existing socket {path} ({os_error_name(exc)})") from None
    finally:
        probe.close()
    raise SocketInUse(str(path))


def remove_socket(path: Path, socket_id) -> None:
    """Delete our socket file at shutdown, unless another hub has replaced it meanwhile."""
    if socket_id is None:
        return
    try:
        info = os.lstat(path)
        if (info.st_dev, info.st_ino) == socket_id:
            os.unlink(path)
    except OSError:
        pass


# ------------------------------------------------------------------- server
def _busy_response() -> bytes:
    body = b"Server busy, retry.\n"
    head = "".join(f"{k}: {v}\r\n" for k, v in SECURITY_HEADERS)
    return (
        "HTTP/1.0 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\nRetry-After: 2\r\nCache-Control: no-store\r\n{head}"
        "Connection: close\r\n\r\n"
    ).encode("ascii") + body


BUSY_RESPONSE = _busy_response()


class GzipCache:
    """Compressed copies of static files, keyed by (path, mtime_ns, size), bounded in bytes."""

    def __init__(self, limit: int):
        self.limit = limit
        self._items: collections.OrderedDict = collections.OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    def get(self, key, data: bytes) -> bytes:
        with self._lock:
            hit = self._items.get(key)
            if hit is not None:
                self._items.move_to_end(key)
                return hit
        body = gzip.compress(data, compresslevel=GZIP_LEVEL, mtime=0)
        with self._lock:
            if key not in self._items and len(body) <= self.limit // 4:
                self._items[key] = body
                self._bytes += len(body)
                while self._bytes > self.limit:
                    _, old = self._items.popitem(last=False)
                    self._bytes -= len(old)
        return body


class HubServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False  # shutdown waits for in-flight requests itself (bounded), see wait_idle
    request_queue_size = 64
    listen_kind = "tcp"
    log_via = None  # access-log tag of this listener ("tailscale" on the Tailscale socket)
    # On Windows SO_REUSEADDR lets a second process bind the same port; use exclusive binding instead.
    allow_reuse_address = os.name != "nt"

    def __init__(self, address, handler, *, store: HubStore, policy: AccessPolicy, build: str = DEV_BUILD,
                 instance: str = "", timeouts: Timeouts = Timeouts(), max_connections: int = MAX_CONNECTIONS):
        self.store = store
        self.policy = policy
        self.build = build
        self.instance = instance
        self.timeouts = timeouts
        self.static_gzip = GzipCache(STATIC_GZIP_CACHE_BYTES)
        self.stopping = threading.Event()
        self._slots = threading.BoundedSemaphore(max_connections)
        self._active = 0
        self._active_cv = threading.Condition()
        self._busy_logged = 0.0
        self._busy_count = 0
        self._proxy_logged = 0.0
        self._refusal_logged = 0.0
        super().__init__(address, handler)

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()
        ensure_loopback(self.socket)  # belt and braces: never serve on a non-loopback address

    def process_request(self, request, client_address):
        if self.stopping.is_set() or not self._slots.acquire(blocking=False):
            self._reject_busy(request)
            return
        with self._active_cv:
            self._active += 1
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._release()
            self.shutdown_request(request)
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._release()

    def _release(self) -> None:
        with self._active_cv:
            self._active -= 1
            self._active_cv.notify_all()
        self._slots.release()

    def _reject_busy(self, request) -> None:
        self._busy_count += 1
        now = time.monotonic()
        if now - self._busy_logged > 10:
            log_event(logging.WARNING, "busy", rejected=self._busy_count, limit=MAX_CONNECTIONS)
            self._busy_logged, self._busy_count = now, 0
        try:
            request.setblocking(False)
            request.send(BUSY_RESPONSE)
        except OSError:
            pass
        self.shutdown_request(request)

    def note_proxy(self, names: list[str], path: str) -> None:
        """Log refused proxy requests: one WARNING per 10 s at most, the rest at DEBUG."""
        now = time.monotonic()
        level = logging.DEBUG
        if now - self._proxy_logged > 10:
            self._proxy_logged, level = now, logging.WARNING
        log_event(level, "proxy_refused", headers=",".join(names), path=path)

    def note_refusal(self, verdict: Verdict, path: str) -> None:
        """Log a request the policy refused. The main listener logs proxy refusals as before; the
        Tailscale listener logs every refusal with its reason. One WARNING per 10 s, the rest at
        DEBUG; header names only, never their values."""
        if self.policy.name != TailscalePolicy.name:
            if verdict.proxy_headers:
                self.note_proxy(list(verdict.proxy_headers), path)
            return
        now = time.monotonic()
        level = logging.DEBUG
        if now - self._refusal_logged > 10:
            self._refusal_logged, level = now, logging.WARNING
        log_event(level, "ts_refused", reason=verdict.reason, headers=",".join(verdict.proxy_headers) or None,
                  path=path)

    def wait_idle(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        with self._active_cv:
            while self._active:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._active_cv.wait(remaining)
        return True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError)):
            log_event(logging.DEBUG, "client_gone", error=exc.__class__.__name__)
            return
        where = "?"
        tb = exc.__traceback__ if exc is not None else None
        while tb is not None and tb.tb_next is not None:
            tb = tb.tb_next
        if tb is not None:
            source = Path(tb.tb_frame.f_code.co_filename)
            label = source.name if source.parent == ROOT else f"{source.parent.name}/{source.name}"
            where = f"{label}:{tb.tb_lineno}"
        log_event(logging.ERROR, "unhandled", error=exc.__class__.__name__ if exc else "?", at=where)


class HubServerV6(HubServer):
    address_family = socket.AF_INET6


class HubUnixServer(HubServer):
    """Linux server mode: a Unix socket only (0600, in a 0700 folder of this user). No TCP at all."""

    address_family = getattr(socket, "AF_UNIX", -1)  # only constructed where AF_UNIX exists
    allow_reuse_address = False
    listen_kind = "unix"

    def __init__(self, address, handler, *, tunnel_port: int, **kwargs):
        self.tunnel_port = tunnel_port
        self._socket_id = None
        super().__init__(address, handler, **kwargs)

    def server_bind(self):
        path = Path(self.server_address)
        check_socket_folder(path.parent, create=True)
        clear_stale_socket(path)
        old_umask = os.umask(0o177)  # the socket is created 0600: never readable by anyone else, not even briefly
        try:
            self.socket.bind(str(path))
        finally:
            os.umask(old_umask)
        info = os.lstat(path)
        self._socket_id = (info.st_dev, info.st_ino)  # from here on, server_close removes it
        os.chmod(path, 0o600)
        info = os.lstat(path)
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise UnsafeSocket(f"{path} did not end up as a socket with mode 600 owned by you")
        self.server_address = str(path)
        self.server_name = "localhost"  # never resolved: the base class would ask DNS about the path
        self.server_port = self.tunnel_port

    def server_close(self):
        super().server_close()
        remove_socket(Path(self.server_address), self._socket_id)


class TailscaleUnixServer(HubUnixServer):
    """Opt-in phone access: the second Unix socket (0600, in the same 0700 folder) that Tailscale
    Serve proxies to. Its policy is always a TailscalePolicy; there is still no TCP listener."""

    listen_kind = "tailscale"
    log_via = "tailscale"

    def __init__(self, address, handler, *, policy, **kwargs):
        if not isinstance(policy, TailscalePolicy):
            raise TypeError("the Tailscale socket only ever runs with a TailscalePolicy")
        super().__init__(address, handler, policy=policy, **kwargs)


class _DeadlineReader(io.RawIOBase):
    """Socket reader: each recv waits at most `io_timeout` and never past `deadline`."""

    def __init__(self, sock: socket.socket, io_timeout: float):
        super().__init__()
        self._sock = sock
        self._io_timeout = io_timeout
        self.deadline: float | None = None
        self.received = 0

    def readable(self) -> bool:
        return True

    def readinto(self, buffer) -> int:
        timeout = self._io_timeout
        if self.deadline is not None:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("request deadline passed")
            timeout = min(timeout, remaining)
        self._sock.settimeout(timeout)
        count = self._sock.recv_into(buffer)
        self.received += count
        return count


class HubHandler(http.server.BaseHTTPRequestHandler):
    server_version = "FitnessHub/" + APP_VERSION
    sys_version = ""
    protocol_version = "HTTP/1.0"  # one request per connection: nothing idles on keep-alive
    default_request_version = "HTTP/1.0"  # so even replies to garbled requests carry a status line and headers
    server: HubServer

    @property
    def store(self) -> HubStore:
        return self.server.store

    # ------------------------------------------------------- connection
    def setup(self):
        self.timeout = self.server.timeouts.io
        super().setup()
        self._reader = _DeadlineReader(self.connection, self.server.timeouts.io)
        plain, self.rfile = self.rfile, io.BufferedReader(self._reader, 65536)
        plain.close()
        self.raw_requestline = b""

    def handle_one_request(self):
        started = time.perf_counter()
        self._status = 0
        self._sent = 0
        self._body_done = False
        self._login = None  # set by _guard on the Tailscale listener: the allowed login
        self.raw_requestline = b""
        self._reader.deadline = time.monotonic() + self.server.timeouts.header
        try:
            self.raw_requestline = self.rfile.readline(65537)
            if not self.raw_requestline:
                self.close_connection = True
                return
            if len(self.raw_requestline) > 65536:
                self.requestline = self.request_version = self.command = ""
                self.send_error(HTTPStatus.REQUEST_URI_TOO_LONG)
                return
            if not self.parse_request():  # reads the headers, still under the header deadline
                return
            self._io_mode()
            method = getattr(self, "do_" + self.command, None)
            if method is None:
                self.send_error(HTTPStatus.NOT_IMPLEMENTED)
                return
            method()
            self.wfile.flush()
        except TimeoutError:
            self.close_connection = True
            if self._reader.received == 0:  # an unused (speculative) connection: not worth an INFO line
                log_event(logging.DEBUG, "idle_closed")
            else:
                log_event(logging.INFO, "timeout", phase="headers" if self._status == 0 else "response")
        finally:
            if self.raw_requestline:
                self._log_access(started)

    def _io_mode(self) -> None:
        """Leave deadline mode: plain per-operation timeouts for the rest of the exchange."""
        self._reader.deadline = None
        self.connection.settimeout(self.server.timeouts.io)

    # ------------------------------------------------------------ logging
    def log_request(self, code="-", size="-"):
        pass  # one access line per request is written by _log_access

    def log_message(self, format, *args):  # noqa: A002 - signature from the base class
        log_event(logging.DEBUG, "detail", msg=format % args)

    def _log_path(self) -> str:
        return (getattr(self, "path", "") or "-").split("?", 1)[0]

    def _log_access(self, started: float) -> None:
        path = self._log_path()
        quiet = self._status < 400 and not self._is_api(path)
        log_event(logging.DEBUG if quiet else logging.INFO, "http", method=self.command or "-", path=path,
                  status=self._status or "-", ms=round((time.perf_counter() - started) * 1000, 1), bytes=self._sent,
                  via=self.server.log_via, login=getattr(self, "_login", None))

    # ------------------------------------------------------------ responses
    def send_response(self, code, message=None):
        self._status = int(code)
        super().send_response(code, message)

    def end_headers(self):
        for name, value in SECURITY_HEADERS:
            self.send_header(name, value)
        super().end_headers()

    def _write(self, body: bytes) -> None:
        view = memoryview(body)
        for start in range(0, len(view), 256 * 1024):
            self.wfile.write(view[start:start + 256 * 1024])
        self._sent += len(body)

    def _send(self, status: int, body: bytes, content_type: str, *, cache: str = "no-store",
              headers: dict | None = None) -> None:
        self.send_response(status)
        if status != 304:
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if body and self.command != "HEAD" and status != 304:
            self._write(body)

    def _send_json(self, status: int, obj, *, headers: dict | None = None) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", headers=headers)

    def _error(self, status: int, error: str, *, headers: dict | None = None, **fields) -> None:
        self._finish_body()
        self._send_json(status, {"ok": False, "error": error, **fields}, headers=headers)

    def send_error(self, code, message=None, explain=None):
        # Never echo the request back (the base class would put the raw request line in the body).
        code = int(code)
        if message:
            log_event(logging.DEBUG, "detail", status=code, msg=message)
        self.close_connection = True
        try:
            reason = HTTPStatus(code).phrase
        except ValueError:
            reason = "Error"
        if self._is_api():
            self._error(code, reason)
        else:
            self._finish_body()
            self._send(code, f"{code} {reason}\n".encode("ascii"), "text/plain; charset=utf-8")

    def _method_not_allowed(self) -> None:
        self._error(405, "Method not allowed.", headers={"Allow": "GET, HEAD, PUT, POST"})

    # ------------------------------------------------------- request body
    def _declared_length(self):
        """Content-Length as an int, None when absent, or "invalid"."""
        values = self.headers.get_all("Content-Length") or []
        if not values:
            return None
        if len(values) != 1 or not DIGITS.fullmatch(values[0].strip()):
            return "invalid"
        return int(values[0].strip())

    def _body_length(self, limit: int) -> int | None:
        """The declared Content-Length when it is usable (<= limit), else reply 411/400/413 and None.
        Nothing is read from the body here."""
        if self.headers.get("Transfer-Encoding") is not None:
            self._body_done = True  # no length to drain by: the connection just closes
            self._error(411, "Send a Content-Length; chunked bodies are not supported.")
            return None
        length = self._declared_length()
        if length is None:
            self._body_done = True
            self._error(411, "Content-Length required.")
            return None
        if length == "invalid":
            self._body_done = True
            self._error(400, "Invalid Content-Length.")
            return None
        if length > limit:
            self._body_done = True
            self._error(413, f"Request body too large (limit {limit} bytes).")
            self._linger_close()
            return None
        return length

    def _read_exact(self, length: int) -> bytes | None:
        """Exactly `length` body bytes within the body deadline, else reply and None."""
        self._reader.deadline = time.monotonic() + self.server.timeouts.body
        timed_out = False
        try:
            body = self.rfile.read(length) if length else b""
        except TimeoutError:
            body, timed_out = b"", True
        finally:
            self._io_mode()
        self._body_done = True
        if timed_out:
            self._error(408, "The request body took too long to arrive.")
            self._linger_close()
            return None
        if len(body) != length:
            self._error(400, "Request body was shorter than Content-Length.")
            return None
        return body

    def _read_body(self, limit: int) -> bytes | None:
        length = self._body_length(limit)
        return None if length is None else self._read_exact(length)

    def _finish_body(self) -> None:
        """Before an early error reply, read and drop an unread body (within the deadline) so
        the client gets to see the reply instead of a connection reset."""
        if self._body_done or self.command not in ("PUT", "POST", "PATCH", "DELETE"):
            return
        self._body_done = True
        headers = getattr(self, "headers", None)
        if headers is None or headers.get("Transfer-Encoding") is not None:
            return
        length = self._declared_length()
        if not isinstance(length, int) or not 0 < length <= MAX_BODY_BYTES:
            return
        self._reader.deadline = time.monotonic() + self.server.timeouts.body
        try:
            while length > 0:
                chunk = self.rfile.read(min(length, 65536))
                if not chunk:
                    break
                length -= len(chunk)
        except (TimeoutError, OSError):
            self.close_connection = True
        finally:
            self._io_mode()

    def _linger_close(self) -> None:
        """After an early 413: half-close, then briefly drain what the client is still sending."""
        try:
            self.wfile.flush()
            self.connection.shutdown(socket.SHUT_WR)
            deadline = time.monotonic() + 2.0
            drained = 0
            while drained < 2 * MAX_BODY_BYTES:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.connection.settimeout(remaining)
                chunk = self.connection.recv(65536)
                if not chunk:
                    break
                drained += len(chunk)
        except OSError:
            pass
        self.close_connection = True

    # ------------------------------------------------------------ guards
    def _path_only(self) -> str:
        return (getattr(self, "path", "") or "").split("?", 1)[0].split("#", 1)[0]

    def _is_api(self, path: str | None = None) -> bool:
        p = self._path_only() if path is None else path
        return p == "/api" or p.startswith("/api/")

    def _guard(self) -> Authority | None:
        """First check on every GET, HEAD, PUT and POST: this listener's own policy. The main one
        wants a known Host and no proxy headers; the Tailscale one wants Serve's headers and an
        allowed Tailscale login. Anything else is a 403."""
        verdict = self.server.policy.admit(self.headers)
        if not verdict.allowed:
            self.server.note_refusal(verdict, self._log_path())
            self._error(403, verdict.message, **verdict.fields)
            return None
        self._login = verdict.login
        return verdict.authority

    def _fetch_site(self) -> str:
        return (self.headers.get("Sec-Fetch-Site") or "").strip().lower()

    def _write_request_ok(self, authority: Authority) -> bool:
        """CSRF defence for PUT/POST: JSON content type, custom header, same-origin only."""
        ctype = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if ctype != "application/json":
            self._error(403, "Forbidden: Content-Type must be application/json.")
            return False
        if (self.headers.get("X-Fitness-Hub") or "").strip() != "1":
            self._error(403, "Forbidden: missing X-Fitness-Hub header.")
            return False
        origins = self.headers.get_all("Origin") or []
        if not authority.origin_ok(origins):
            if not origins:
                self._error(403, "Forbidden: saves through Tailscale must come from the hub's own page (no Origin header).")
            else:
                self._error(403, "Forbidden: cross-origin request.")
            return False
        if self._fetch_site() not in ("", "same-origin"):
            self._error(403, "Forbidden: cross-site request.")
            return False
        return True

    def _if_match(self) -> list[str] | None:
        """Strong ETags from If-Match (SPEC 5.7a), or None after replying 428/400."""
        values = self.headers.get_all("If-Match") or []
        raw = ", ".join(v.strip() for v in values if v.strip())
        if not raw:
            self._error(428, "Precondition required: send If-Match with the ETag from GET /api/data.")
            return None
        tags = parse_etag_list(raw)
        if tags is None:
            self._error(400, 'If-Match must be an ETag in double quotes, as sent by GET /api/data.')
            return None
        if any(tag == "*" for _, tag in tags):
            self._error(428, 'Precondition required: If-Match "*" is not accepted; send the ETag from GET /api/data.')
            return None
        return [tag for weak, tag in tags if not weak]  # If-Match uses strong comparison

    def _build_ok(self) -> bool:
        """SPEC 5.7a: a bundled build refuses saves from app code of any other build (409)."""
        build = self.server.build
        if build == DEV_BUILD:
            return True
        values = self.headers.get_all("X-Hub-Build") or []
        sent = values[0].strip() if len(values) == 1 else ""
        if sent == build:
            return True
        log_event(logging.INFO, "build_mismatch", sent=sent[:64] or "-", build=build)
        self._error(409, "build_mismatch", build=build, message="The hub was updated. Reload to continue.")
        return False

    def _folder_error(self, exc: FolderUnusable, doing: str) -> None:
        """500 naming the data or backups folder that can't be used, and what to check."""
        log_event(logging.ERROR, "folder_unusable", folder=exc.role, error=os_error_name(exc.cause),
                  method=self.command)
        self._error(500, folder_problem(exc, doing), folder=str(exc.folder), folder_role=exc.role)

    def _stale(self, current: str) -> None:
        self._error(412, "Your copy is out of date: the data was saved from somewhere else since you "
                         "loaded it. Reload, merge, and try again.",
                    headers={"ETag": current}, current_etag=current)

    def _none_match(self, etag: str) -> bool:
        return self._none_match_any((etag,))

    def _none_match_any(self, etags) -> bool:
        values = self.headers.get_all("If-None-Match") or []
        tags = parse_etag_list(", ".join(values)) if values else None
        return bool(tags) and any(tag == "*" or tag in etags for _, tag in tags)  # weak comparison

    def _accepts_gzip(self) -> bool:
        return accepts_gzip(", ".join(self.headers.get_all("Accept-Encoding") or []))

    # ------------------------------------------------------------ static
    def _static_file(self) -> Path | None:
        """A safe, resolved file inside public/, or None to 404."""
        raw = getattr(self, "path", "") or ""
        if not raw.startswith("/") or raw.startswith("//"):
            return None
        path = self._path_only()
        # No percent-encoding at all (blocks %2e%2e, %2f, %5c, %00), no backslashes or NULs.
        if "%" in path or "\\" in path or "\x00" in path:
            return None
        if path == "/":
            path = "/index.html"
        if path.endswith("/"):
            return None  # directory URL: never list
        segments = path.split("/")[1:]
        for seg in segments:
            if (
                not seg
                or seg in (".", "..")
                or not SAFE_SEGMENT.match(seg)
                or seg.endswith(".")
                or WINDOWS_RESERVED.match(seg)
            ):
                return None
        if segments[0].lower() == "data":
            return None
        try:
            resolved = PUBLIC_DIR.joinpath(*segments).resolve(strict=True)
        except (OSError, RuntimeError):
            return None
        if resolved == PUBLIC_DIR or not _is_within(resolved, PUBLIC_DIR) or not resolved.is_file():
            return None
        return resolved

    def _serve_static(self) -> None:
        target = self._static_file()
        if target is None:
            self.send_error(404)
            return
        try:
            handle = open(target, "rb")
        except OSError:
            self.send_error(404)
            return
        with handle:
            try:
                info = os.fstat(handle.fileno())
            except OSError:
                info = None
            if info is None or not stat.S_ISREG(info.st_mode):
                self.send_error(404)
                return
            ctype = MIME_TYPES.get(target.suffix.lower(), "application/octet-stream")
            # Every app file (the page, its JS and CSS, the content) revalidates on each use, so a
            # reload after an update always runs the new code with the new content. An unchanged
            # file costs a 304 and is never read. The ETag includes the build id, so a new bundle
            # changes every ETag even where a file's mtime and size happen to stay the same.
            cache = STATIC_CACHE
            compressible = ctype.startswith(COMPRESSIBLE) and info.st_size >= GZIP_MIN_BYTES
            use_gzip = compressible and self._accepts_gzip()
            plain_tag = f'"{self.server.build}-{info.st_mtime_ns:x}-{info.st_size:x}"'
            gzip_tag = plain_tag[:-1] + '-gz"'  # each encoding of a file has its own ETag
            headers = {"ETag": gzip_tag if use_gzip else plain_tag,
                       "Last-Modified": email.utils.formatdate(info.st_mtime, usegmt=True)}
            if compressible:
                headers["Vary"] = "Accept-Encoding"
            # Validators first: an unchanged file is never read.
            if self._not_modified((plain_tag, gzip_tag), info.st_mtime):
                self._send(304, b"", ctype, cache=cache, headers=headers)
                return
            try:
                body = read_static(handle)
            except OSError:
                self.send_error(404)
                return
        if use_gzip:
            body = self.server.static_gzip.get((str(target), info.st_mtime_ns, info.st_size), body)
            headers["Content-Encoding"] = "gzip"
        self._send(200, body, ctype, cache=cache, headers=headers)  # _send skips the body for HEAD

    def _not_modified(self, etags, mtime: float) -> bool:
        if self.headers.get_all("If-None-Match"):
            return self._none_match_any(etags)  # If-None-Match wins over If-Modified-Since
        since_text = self.headers.get("If-Modified-Since")
        if not since_text:
            return False
        try:
            since = email.utils.parsedate_to_datetime(since_text)
        except (TypeError, ValueError, IndexError, OverflowError):
            return False
        if since is None:
            return False
        if since.tzinfo is None:
            since = since.replace(tzinfo=_dt.timezone.utc)
        # Only the exact Last-Modified counts. A rollback puts back files that are OLDER than the
        # date a browser holds, and "not modified since" would then keep serving the newer code.
        return int(mtime) == int(since.timestamp())

    # ------------------------------------------------------------- methods
    def do_GET(self):
        if self._guard() is None:
            return
        path = self._path_only()
        if self._is_api(path):
            if self._fetch_site() not in ("", "same-origin", "none"):
                self._error(403, "Forbidden: cross-site request.")
                return
            self._api_get(path)
            return
        self._serve_static()

    def do_HEAD(self):
        if self._guard() is None:
            return
        if self._is_api():
            self._method_not_allowed()
            return
        self._serve_static()

    def do_PUT(self):
        authority = self._guard()
        if authority is None:
            return
        if self._path_only() != "/api/data":
            self._method_not_allowed()
            return
        if not self._write_request_ok(authority):
            return
        # Preconditions come before the body is read or parsed (SPEC 5.7a): If-Match present
        # (428/400), the same build (409), a usable length (411/413), then not stale (412).
        expected = self._if_match()
        if expected is None:
            return
        if not self._build_ok():
            return
        length = self._body_length(MAX_BODY_BYTES)
        if length is None:
            return
        try:
            current = self.store.current_etag()
        except FolderUnusable as exc:
            self._folder_error(exc, "Could not save")
            return
        except OSError as exc:
            log_event(logging.ERROR, "read_failed", error=os_error_name(exc))
            self._error(500, f"Could not read data ({os_error_name(exc)}).")
            return
        if current not in expected:
            self._stale(current)
            return
        body = self._read_exact(length)
        if body is None:
            return
        if body.startswith(UTF8_BOM):
            body = body[len(UTF8_BOM):]
        problem, shape = None, None
        try:
            with PARSE_LOCK:  # one parse at a time bounds CPU and memory
                obj = parse_json_document(body)
                version = obj.get("schema_version") if isinstance(obj, dict) else None
                if not isinstance(obj, dict):
                    problem = "Body must be a JSON object."
                elif not isinstance(version, int) or isinstance(version, bool) or version < 1:
                    problem = "schema_version must be a whole number (1 or more)."
                elif has_lone_surrogate(body):
                    problem = "Body contains text that can't be stored as UTF-8."
                else:
                    shape = array_shape(obj)
                del obj
        except JsonTooDeep:
            problem = f"Body is nested too deeply (limit {MAX_JSON_DEPTH} levels)."
        except (ValueError, RecursionError):
            problem = "Body must be valid JSON (UTF-8, no NaN or Infinity)."
        if problem is not None:
            self._error(400, problem)
            return
        try:
            result = self.store.save(body, expected, shape)  # stored exactly as sent (compact), no re-dump
        except FolderUnusable as exc:
            self._folder_error(exc, "Could not save")
            return
        except OSError as exc:
            log_event(logging.ERROR, "save_failed", error=os_error_name(exc))
            self._error(500, f"Could not save data ({os_error_name(exc)}).")
            return
        if result.status == "conflict":
            self._stale(result.etag)
            return
        if result.status == "damaged":
            self._error(409, "data/data.json is not valid JSON, so it won't be overwritten. "
                             "Restore a file from data/backups (see README).")
            return
        log_event(logging.INFO, "save", bytes=result.size, changed=result.status == "saved", etag=result.etag[1:13])
        saved_at = _dt.datetime.now().isoformat(timespec="seconds")
        self._send_json(200, {"ok": True, "etag": result.etag, "saved_at": saved_at, "bytes": result.size,
                              "auto_backup": result.auto_backup},
                        headers={"ETag": result.etag, "X-Hub-Build": self.server.build})

    def do_POST(self):
        authority = self._guard()
        if authority is None:
            return
        if self._path_only() != "/api/backup":
            self._method_not_allowed()
            return
        if not self._write_request_ok(authority):
            return
        body = self._read_body(MAX_BACKUP_BODY_BYTES)
        if body is None:
            return
        if body.strip():
            try:
                parse_json_document(body)
            except (ValueError, RecursionError):
                self._error(400, "Body must be valid JSON.")
                return
        try:
            dest, reused = self.store.manual_backup()
        except BackupRateLimited as exc:
            log_event(logging.WARNING, "backup_rate_limited", retry_after=exc.retry_after)
            self._error(429, f"Too many backups in a short time. Try again in {exc.retry_after} s.",
                        headers={"Retry-After": str(exc.retry_after)}, retry_after=exc.retry_after)
            return
        except FolderUnusable as exc:
            self._folder_error(exc, "Could not write the backup")
            return
        except OSError as exc:
            log_event(logging.ERROR, "backup_failed", error=os_error_name(exc))
            self._error(500, f"Could not write backup ({os_error_name(exc)}).")
            return
        self._send_json(200, {"ok": True, "file": dest.name, "path": str(dest), "reused": reused})

    def do_OPTIONS(self):
        # No CORS, ever: preflights fail, so cross-site scripts can't send our custom header.
        self._method_not_allowed()

    def do_DELETE(self):
        self._method_not_allowed()

    def do_PATCH(self):
        self._method_not_allowed()

    # ---------------------------------------------------------------- API
    def _api_get(self, path: str) -> None:
        build_header = {"X-Hub-Build": self.server.build}
        if path == "/api/health":
            info = {"ok": True, "app": APP_NAME, "version": APP_VERSION, "build": self.server.build,
                    "pid": os.getpid(), "instance": self.server.instance, "listen": self.server.listen_kind}
            info.update(self.store.health())
            self._send_json(200, info, headers=build_header)
            return
        if path == "/api/data":
            try:
                state, raw = self.store.snapshot(self._none_match)  # validators first: a 304 reads nothing
            except FolderUnusable as exc:  # creating the first data.json failed
                self._folder_error(exc, "Could not create data.json")
                return
            except OSError as exc:
                self._error(500, f"Could not read data ({os_error_name(exc)}).")
                return
            headers = {"ETag": state.etag, "Vary": "Accept-Encoding", **build_header}
            if raw is None:
                self._send(304, b"", "application/json; charset=utf-8", headers=headers)
                return
            if not state.valid:
                # Never overwrite a damaged file: the user restores from data/backups instead.
                self._error(500, "data/data.json is not valid JSON. Restore a file from data/backups (see README).")
                return
            body = raw
            if len(raw) >= GZIP_MIN_BYTES and self._accepts_gzip():
                body = self.store.gzipped(state, raw)  # the ETag stays the hash of the stored bytes
                headers["Content-Encoding"] = "gzip"
            self._send(200, body, "application/json; charset=utf-8", headers=headers)
            return
        if path == "/api/backup":
            self._method_not_allowed()
            return
        self._error(404, "Unknown API endpoint.")


def read_static(handle) -> bytes:
    return handle.read()


# --------------------------------------------------------------------- main
def build_server(settings: Settings, store: HubStore, *, instance: str = "") -> HubServer:
    common = dict(store=store, policy=AccessPolicy.for_settings(settings), build=settings.build,
                  instance=instance, timeouts=settings.timeouts)
    if settings.socket_path is not None:
        return HubUnixServer(str(settings.socket_path), HubHandler, tunnel_port=settings.port, **common)
    cls = HubServerV6 if settings.bind_host == "::1" else HubServer
    return cls((settings.bind_host, settings.port), HubHandler, **common)


def build_tailscale_server(settings: Settings, store: HubStore, *, instance: str = "") -> HubServer | None:
    """The opt-in second listener for Tailscale Serve (None when Tailscale mode is off). It shares
    the store (and so the write lock) with the main listener, but has a policy of its own."""
    ts = settings.tailscale
    if ts is None:
        return None
    return TailscaleUnixServer(str(ts.socket_path), HubHandler, tunnel_port=settings.port, store=store,
                               policy=TailscalePolicy(ts), build=settings.build, instance=instance,
                               timeouts=settings.timeouts)


def notify_systemd(message: str) -> None:
    """sd_notify(3) without dependencies; a no-op unless started by systemd with Type=notify."""
    address = os.environ.get("NOTIFY_SOCKET", "")
    if not address or not HAS_UNIX_SOCKETS or address[0] not in "/@":
        return
    if address[0] == "@":
        address = "\0" + address[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.connect(address)
            sock.sendall(message.encode("ascii"))
    except OSError as exc:
        log_event(logging.WARNING, "sd_notify_failed", error=exc.__class__.__name__)


def fetch_health(settings: Settings) -> dict | None:
    """GET /api/health from whatever listens on our TCP address (plain http.client: no proxy)."""
    conn = http.client.HTTPConnection(settings.bind_host, settings.port, timeout=2)
    try:
        conn.request("GET", "/api/health", headers={"Host": f"{settings.url_host}:{settings.port}"})
        resp = conn.getresponse()
        if resp.status != 200:
            return None
        info = json.loads(resp.read(65536))
        return info if isinstance(info, dict) else None
    except Exception:  # noqa: BLE001 - any failure means "not provably our hub"
        return None
    finally:
        conn.close()


def running_hub(settings: Settings) -> dict | None:
    """Our hub's instance record if it is provably the listener on this exact address, else None.

    Answering {"app": "fitness-hub"} proves nothing (any program can say that). Our data
    folder's lock must be held by a running hub, its record must name this address, and the
    listener must report the same pid and instance id as that record."""
    probe = DataDirLock(settings.data_dir)
    try:
        free = probe.acquire()
    except OSError:
        return None
    if free:
        probe.release()
        return None  # no hub uses our data folder, so the listener is someone else's
    record = read_instance(settings.data_dir)
    if not record or record.get("listen") != settings.listen or not isinstance(record.get("instance"), str):
        return None
    health = fetch_health(settings)
    if (health is not None and health.get("app") == APP_NAME and health.get("pid") == record.get("pid")
            and health.get("instance") == record.get("instance")):
        return record
    return None


def port_in_use(settings: Settings, exc: OSError, open_browser: bool) -> int:
    """The TCP port is taken: say why, and only ever trust our own, verified hub."""
    where = f"{settings.bind_host}:{settings.port}"
    sys.stderr.write(f"Could not listen on {where} ({exc.strerror or exc}).\n")
    if os.name == "nt" and (getattr(exc, "winerror", None) == 10013 or exc.errno == errno.EACCES):
        sys.stderr.write("Windows refused the port. It may be in a range Windows reserves (Hyper-V, WSL or Docker);\n"
                         "check with:  netsh int ipv4 show excludedportrange protocol=tcp\n")
    if settings.under_systemd:
        sys.stderr.write(f"Port {settings.port} is in use by another program. Stop the other program; don't change "
                         f"the port. Find it with:  ss -ltnp 'sport = :{settings.port}'\n")
        return 1
    record = running_hub(settings)
    if record is not None:
        sys.stderr.write(f"The Fitness Hub is already running at {settings.url} (pid {record.get('pid')}).\n")
        if open_browser:
            webbrowser.open(settings.url)
            return 0
        return 1
    sys.stderr.write(f"Another program is using port {settings.port}, so the hub can't start there. "
                     "Close that program, or set FITNESS_HUB_PORT to another port.\n")
    return 1


def run_check(settings: Settings) -> int:
    """--check: validate settings and folders without starting the server."""
    problems = 0

    def report(ok: bool, text: str) -> None:
        nonlocal problems
        print(f"check: {'OK  ' if ok else 'FAIL'} {text}")
        problems += 0 if ok else 1

    if settings.socket_path is not None:
        report(True, f"listen socket {settings.socket_path} (Unix socket only, no TCP; "
                     f"the tunnel's Host is 127.0.0.1:{settings.port})")
        folder = settings.socket_path.parent
        try:
            check_socket_folder(folder, create=False)
            report(True, f"socket folder {folder} (700, yours)")
        except FileNotFoundError:
            report(True, f"socket folder {folder} doesn't exist yet (it is created 700 at start)")
        except (UnsafeSocket, OSError) as exc:
            report(False, str(exc))
    else:
        report(True, f"listen address {settings.bind_host}:{settings.port} (loopback only)")
    ts = settings.tailscale
    if ts is not None:
        count = len(ts.users)
        report(True, f"Tailscale socket {ts.socket_path} (opt-in phone access: https://{ts.host}/ through "
                     f"Tailscale Serve, {count} allowed login{'' if count == 1 else 's'}, no Funnel, no TCP)")
    print(f"check: OK   build {settings.build}")
    report((PUBLIC_DIR / "index.html").is_file(), f"app folder {PUBLIC_DIR}")
    data_dir = settings.data_dir
    try:
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        probe = data_dir / f".check-{os.getpid()}.tmp"
        probe.write_bytes(b"")
        probe.unlink()
        report(True, f"data folder {data_dir} (writable)")
    except OSError as exc:
        report(False, f"data folder {data_dir} is not writable ({os_error_name(exc)})")
    if os.name != "nt" and data_dir.is_dir() and data_dir.stat().st_mode & 0o077:
        print(f"check: WARN data folder can be read by other users: run  chmod 700 {data_dir}")
    data_file = data_dir / "data.json"
    if data_file.exists():
        try:
            doc = parse_json_document(data_file.read_bytes())
            valid = isinstance(doc, dict) and isinstance(doc.get("schema_version"), int)
        except (OSError, ValueError, RecursionError):
            valid = False
        size = data_file.stat().st_size
        report(valid, f"data file {data_file.name} ({size} bytes, {'valid' if valid else 'NOT valid: restore a backup'})")
    else:
        print("check: OK   data file not created yet (the hub creates it on first use)")
    print("check: all good" if not problems else f"check: {problems} problem(s) found")
    return 0 if not problems else 1


def serve(servers: list[HubServer], settings: Settings, open_browser: bool) -> int:
    """Run every listener (the main one, plus the Tailscale socket when that is on) until a signal."""
    ts = settings.tailscale
    log_event(logging.INFO, "start", version=APP_VERSION, build=settings.build, python=platform.python_version(),
              pid=os.getpid(), listen=settings.listen, ts_listen=ts.listen if ts else None,
              data_dir=str(settings.data_dir))
    stop = threading.Event()

    def on_signal(signum, _frame):
        if not stop.is_set():
            log_event(logging.INFO, "stop", signal=signal.Signals(signum).name)
        stop.set()

    for name in ("SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, on_signal)
            except (OSError, ValueError, RuntimeError):
                pass
    workers = [threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.5},
                                name=f"accept-{httpd.listen_kind}", daemon=True) for httpd in servers]
    for worker in workers:
        worker.start()
    tunnel = settings.socket_path is not None
    log_event(logging.INFO, "ready", url=settings.url, via="ssh-tunnel" if tunnel else None,
              tailscale=f"https://{ts.host}/" if ts else None, ts_logins=len(ts.users) if ts else None)
    notify_systemd("READY=1")
    if sys.stdout.isatty():
        if tunnel:
            print(f"Fitness Hub is listening on {settings.socket_path} (no TCP port).")
            print(f"Open it from your PC through the SSH tunnel: {settings.url}")
        else:
            print(f"Fitness Hub is running at {settings.url}")
        if ts:
            print(f"Phone access through Tailscale Serve: https://{ts.host}/ (socket {ts.socket_path}, "
                  f"{len(ts.users)} allowed login(s))")
        print(f"Your data folder: {settings.data_dir}")
        print("Press Ctrl+C (or close this window) to stop the hub.")
        sys.stdout.flush()
    if open_browser and tunnel:
        log_event(logging.INFO, "open_ignored", reason="socket mode has no local URL")
    elif open_browser:
        threading.Timer(0.5, webbrowser.open, args=(settings.url,)).start()
    exit_code = 0
    try:
        while not stop.wait(0.5):
            dead = [httpd.listen_kind for httpd, worker in zip(servers, workers) if not worker.is_alive()]
            if dead:
                log_event(logging.ERROR, "accept_loop_stopped", listener=",".join(dead))
                exit_code = 1
                break
    except KeyboardInterrupt:
        log_event(logging.INFO, "stop", signal="SIGINT")
    notify_systemd("STOPPING=1")
    for httpd in servers:
        httpd.stopping.set()  # new connections get 503 while we finish
    stoppers = [threading.Thread(target=httpd.shutdown, daemon=True) for httpd in servers]
    for stopper in stoppers:
        stopper.start()
    joined_by = time.monotonic() + 3.0
    for stopper in stoppers:
        stopper.join(max(0.0, joined_by - time.monotonic()))
    deadline = time.monotonic() + SHUTDOWN_GRACE  # one grace period shared by every listener
    idle = all([httpd.wait_idle(max(0.0, deadline - time.monotonic())) for httpd in servers])
    no_save_running = WRITE_LOCK.acquire(timeout=SHUTDOWN_GRACE)  # held until exit: no new saves
    for httpd in servers:
        httpd.server_close()
    log_event(logging.INFO, "stopped", clean=idle and no_save_running)
    return exit_code


def main(argv: list[str] | None = None) -> int:
    if sys.version_info < (3, 10):
        sys.stderr.write("The Fitness Hub needs Python 3.10 or newer.\n")
        return 1
    os.umask(0o077)  # everything the hub creates is private to this user, however it was started
    parser = argparse.ArgumentParser(description="Run the Fitness Hub on this computer only (loopback or a private Unix socket).")
    parser.add_argument("--open", action="store_true", help="open the hub in your browser once it is running")
    parser.add_argument("--check", action="store_true", help="check the settings and folders, then exit")
    args = parser.parse_args(argv)
    try:
        settings = resolve_settings(os.environ)
    except ConfigError as exc:
        sys.stderr.write(f"Refusing to start: {exc}\n")
        return 2
    setup_logging(settings.log_level)
    if args.check:
        return run_check(settings)
    if not PUBLIC_DIR.is_dir():
        sys.stderr.write(f"Can't find the app folder: {PUBLIC_DIR}\n")
        return 1
    try:
        settings.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as exc:
        sys.stderr.write(f"Can't create the data folder {settings.data_dir} ({os_error_name(exc)}).\n")
        return 1
    store = HubStore(settings.data_dir)
    instance = secrets.token_hex(16)
    try:
        httpd = build_server(settings, store, instance=instance)
    except NonLoopbackBind as exc:
        sys.stderr.write(f"Refusing to serve: the socket is bound to {exc}, which is not loopback.\n")
        return 2
    except UnsafeSocket as exc:
        sys.stderr.write(f"Refusing to serve: {exc}\n")
        return 2
    except SocketInUse as exc:
        sys.stderr.write(f"Another Fitness Hub is already listening on {exc}. Stop it first "
                         "(systemctl --user stop fitness-hub); don't start a second one.\n")
        return 1
    except OSError as exc:
        if settings.socket_path is not None:
            sys.stderr.write(f"Could not listen on {settings.socket_path} ({exc.strerror or exc}).\n")
            return 1
        return port_in_use(settings, exc, args.open)
    servers = [httpd]
    try:
        ts_httpd = build_tailscale_server(settings, store, instance=instance)
    except (UnsafeSocket, ValueError) as exc:
        httpd.server_close()  # never run with only some of the configured listeners
        sys.stderr.write(f"Refusing to serve: {exc}\n")
        return 2
    except SocketInUse as exc:
        httpd.server_close()
        sys.stderr.write(f"Something is already listening on the Tailscale socket {exc}. Stop it first; "
                         "only the hub may serve there.\n")
        return 1
    except OSError as exc:
        httpd.server_close()
        sys.stderr.write(f"Could not listen on the Tailscale socket {settings.tailscale.socket_path} "
                         f"({exc.strerror or exc}).\n")
        return 1
    if ts_httpd is not None:
        ts_httpd.static_gzip = httpd.static_gzip  # one cache of compressed app files for both listeners
        servers.append(ts_httpd)
    lock = DataDirLock(settings.data_dir)
    if not lock.acquire():
        for listener in servers:
            listener.server_close()
        sys.stderr.write(f"Another Fitness Hub is already using the data folder {settings.data_dir}. Stop it first.\n")
        return 1
    try:
        store.cleanup_temp_files()
        write_instance(settings.data_dir, {"pid": os.getpid(), "listen": settings.listen, "instance": instance,
                                           "started": _dt.datetime.now().astimezone().isoformat(timespec="seconds")})
        return serve(servers, settings, args.open)
    finally:
        remove_instance(settings.data_dir, instance)
        lock.release()


if __name__ == "__main__":
    sys.exit(main())
