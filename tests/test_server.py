#!/usr/bin/env python3
"""Server and deploy tests: run with `python3 tests/test_server.py` (standard library only, 3.10+).

Every server started here listens on a free loopback port (never 8642) or on a Unix socket in a
temporary folder, with a temporary data folder. The user's live instance (port 8642 and the real
hub/data/ folder) is never touched, and nothing here contacts another host.

The suite also runs inside staged copies (deploy/make_bundle.py, deploy/update.sh) where a real
BUILD_ID sits next to server.py, so every write sends the server's own X-Hub-Build.
Tests that need Unix sockets or real POSIX permissions are skipped where the platform lacks them.
"""
from __future__ import annotations

import email.message
import email.utils
import errno
import gzip
import hashlib
import http.client
import http.server
import importlib.util
import io
import json
import logging
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

HUB = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HUB))
sys.dont_write_bytecode = True  # never leave __pycache__ folders in the hub (or in a staged bundle)
import server  # noqa: E402  (the pure helpers are tested in-process)

LIVE_PORT = 8642
REAL_DATA_DIR = (HUB / "data").resolve()
CSP = server.CSP
WRITE = {"Content-Type": "application/json", "X-Fitness-Hub": "1"}
LOG_LINE = re.compile(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d (DEBUG|INFO|WARNING|ERROR) event=[a-z_]+( |$)")
POSIX_PERMS = os.name == "posix"
UNIX_SOCKETS = server.HAS_UNIX_SOCKETS and os.name == "posix"
AMBIENT = ("INVOCATION_ID", "NOTIFY_SOCKET", "JOURNAL_STREAM", "LISTEN_FDS", "LISTEN_PID")


def free_port() -> int:
    while True:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if port != LIVE_PORT:
            return port


def clean_env(**extra) -> dict:
    """The environment without any hub setting or systemd context, plus `extra`."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("FITNESS_HUB_") and k not in AMBIENT}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.update(extra)
    return env


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float = 10):
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._path)
        self.sock = sock


def http_request(port, method, path, body=None, headers=None, host=None, timeout=10, unix_path=None):
    assert port != LIVE_PORT, "tests never contact the live hub"
    if unix_path is not None:
        conn = UnixHTTPConnection(unix_path, timeout=timeout)
    else:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        hdrs = {"Host": host if host is not None else f"127.0.0.1:{port}"}
        hdrs.update(headers or {})
        if body is not None and not isinstance(body, bytes):
            body = body.encode("utf-8")
        conn.request(method, path, body=body, headers=hdrs)
        resp = conn.getresponse()
        data = resp.read()
        return resp.status, {k.lower(): v for k, v in resp.getheaders()}, data
    finally:
        conn.close()


def raw_exchange(port, payload: bytes, timeout=10) -> bytes:
    assert port != LIVE_PORT
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        s.sendall(payload)
        chunks = []
        while True:
            try:
                chunk = s.recv(65536)
            except (ConnectionResetError, ConnectionAbortedError):
                break
            if not chunk:
                break
            chunks.append(chunk)
    return b"".join(chunks)


def primary_ip() -> str | None:
    """This machine's main non-loopback address (a UDP connect sends no packets)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            return s.getsockname()[0]
    except OSError:
        return None


def public_file(pattern: str, under: str = "", min_size: int = 0) -> str | None:
    base = HUB / "public" / under
    for p in sorted(base.rglob(pattern)) if base.is_dir() else []:
        if p.is_file() and "dev-fixtures" not in p.parts and p.stat().st_size >= min_size:
            return "/" + p.relative_to(HUB / "public").as_posix()
    return None


def mini_hub(root: Path, build: str | None = None, name: str = "tree") -> Path:
    """A minimal hub folder (server.py, public/index.html, optional BUILD_ID) for build tests."""
    tree = root / name
    (tree / "public" / "js").mkdir(parents=True)
    shutil.copy2(HUB / "server.py", tree / "server.py")
    (tree / "public" / "index.html").write_text("<!doctype html><title>Fitness Hub</title>\n", encoding="utf-8")
    (tree / "public" / "js" / "app.js").write_text("export const ok = 1;\n", encoding="utf-8")
    if build is not None:
        (tree / "BUILD_ID").write_text(build + "\n", encoding="ascii")
    return tree


def private_tmp() -> tempfile.TemporaryDirectory:
    tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    if POSIX_PERMS:
        os.chmod(tmp.name, 0o700)
    return tmp


# ----------------------------------------------------- opt-in Tailscale mode
LINUX_SOCKETS = UNIX_SOCKETS and sys.platform.startswith("linux")  # Tailscale mode is Linux-only
TS_HOST = "homeserver.tail1234.ts.net"
TS_LOGIN = "alex@example.com"
TS_MAIN_SOCKET = Path("/run/user/1000/fitness-hub/hub.sock")
TS_ENV = {"FITNESS_HUB_TS_SOCKET": "/run/user/1000/fitness-hub/ts.sock", "FITNESS_HUB_TS_HOST": TS_HOST,
          "FITNESS_HUB_TS_USERS": TS_LOGIN}
# What Tailscale Serve adds when a signed-in user opens https://TS_HOST/ (it sends Host: localhost to a
# unix: target). Nothing here talks to Tailscale: the tests play Serve's part themselves.
SERVE_HEADERS = {"X-Forwarded-Host": TS_HOST, "X-Forwarded-For": "100.101.102.103", "X-Forwarded-Proto": "https",
                 "Tailscale-User-Login": TS_LOGIN, "Tailscale-User-Name": "Alex",
                 "Tailscale-User-Profile-Pic": "https://example.com/photo.jpg",
                 "Tailscale-Headers-Info": "https://tailscale.com/s/serve-headers"}


def without(headers: dict, *names: str) -> dict:
    drop = {name.lower() for name in names}
    return {k: v for k, v in headers.items() if k.lower() not in drop}


def header_set(*pairs) -> email.message.Message:
    """Request headers as the handler sees them (repeats allowed), for the pure policy tests."""
    msg = email.message.Message()
    for name, value in pairs:
        msg[name] = value
    return msg


def serve_pairs(*, host="localhost", drop=(), add=(), **values) -> list:
    """Host plus SERVE_HEADERS as (name, value) pairs. Keyword values replace by name
    (x_forwarded_host=...), drop removes names, add appends extra pairs."""
    over = {k.replace("_", "-").lower(): v for k, v in values.items()}
    gone = {name.lower() for name in drop}
    pairs = [] if "host" in gone else [("Host", host)]
    pairs += [(k, over.get(k.lower(), v)) for k, v in SERVE_HEADERS.items() if k.lower() not in gone]
    return pairs + list(add)


def ts_settings(users=(TS_LOGIN,), host=TS_HOST):
    return server.TailscaleSettings(TS_MAIN_SOCKET.parent / "ts.sock", host, tuple(users))


class HubProcess:
    """server.py in a subprocess with its own port (or Unix socket), data folder and log file."""

    def __init__(self, root: Path, *, name: str = "hub", data_dir: Path | None = None, env: dict | None = None,
                 hub_root: Path = HUB, socket_path: Path | None = None):
        self.port = free_port()
        self.data_dir = data_dir or (root / f"{name}-data")
        assert self.data_dir.resolve() != REAL_DATA_DIR, "tests must never use the real data folder"
        self.log_path = root / f"{name}-{self.port}.log"
        self.hub_root = hub_root
        self.socket_path = socket_path
        settings = {"FITNESS_HUB_PORT": str(self.port), "FITNESS_HUB_DATA_DIR": str(self.data_dir)}
        if socket_path is not None:
            settings["FITNESS_HUB_SOCKET"] = str(socket_path)
        settings.update(env or {})
        self.env = clean_env(**settings)
        self.proc: subprocess.Popen | None = None
        self.build = None
        self._log = None

    def start(self, wait: bool = True) -> "HubProcess":
        self._log = open(self.log_path, "wb")
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        self.proc = subprocess.Popen([sys.executable, str(self.hub_root / "server.py")], cwd=str(self.hub_root),
                                     env=self.env, stdout=self._log, stderr=subprocess.STDOUT, creationflags=flags)
        if wait:
            self.wait_ready()
        return self

    def wait_ready(self, timeout: float = 15) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"server exited early ({self.proc.returncode}):\n{self.log()}")
            try:
                status, _, body = self.req("GET", "/api/health", timeout=2)
                if status == 200:
                    self.build = json.loads(body)["build"]
                    return
            except OSError:
                pass
            time.sleep(0.1)
        raise RuntimeError("server did not start")

    def req(self, method, path, body=None, headers=None, host=None, timeout=10):
        unix = str(self.socket_path) if self.socket_path is not None else None
        return http_request(self.port, method, path, body, headers, host, timeout, unix_path=unix)

    def write_headers(self, etag=None, **extra) -> dict:
        h = dict(WRITE, **{"X-Hub-Build": self.build or "dev"})
        if etag is not None:
            h["If-Match"] = etag
        h.update(extra)
        return h

    def get_data(self):
        status, h, body = self.req("GET", "/api/data")
        assert status == 200, body
        return json.loads(body), h["etag"]

    def log(self) -> str:
        return self.log_path.read_text(encoding="utf-8", errors="replace")

    def stop(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        if self._log is not None:
            self._log.close()
            self._log = None


def run_server(env: dict, *args: str, timeout: float = 20, hub_root: Path = HUB) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(hub_root / "server.py"), *args], cwd=str(hub_root), env=env,
                          capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)


class FakeHubListener:
    """A loopback listener that claims to be the hub (answers {"app": "fitness-hub"}): a stand-in
    for some other program on the port. It must never be trusted."""

    def __init__(self, port: int, payload: dict):
        body = json.dumps(payload).encode()

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        class Server(http.server.HTTPServer):
            allow_reuse_address = False

        self.httpd = Server(("127.0.0.1", port), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(5)


# =========================================================== shared server
class HubServerTests(unittest.TestCase):
    """One shared server (debug logging, timeouts x0.2) for the API and guard tests."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        cls.hub = HubProcess(Path(cls.tmp.name), env={"FITNESS_HUB_LOG_LEVEL": "debug",
                                                     "FITNESS_HUB_TIMEOUT_SCALE": "0.2"}).start()
        cls.port = cls.hub.port
        cls.data_dir = cls.hub.data_dir
        cls.build = cls.hub.build

    @classmethod
    def tearDownClass(cls):
        cls.hub.stop()
        cls.tmp.cleanup()

    # ----------------------------------------------------------- helpers
    def req(self, method, path, body=None, headers=None, host=None, timeout=10):
        return http_request(self.port, method, path, body, headers, host, timeout)

    def raw(self, payload: bytes) -> bytes:
        return raw_exchange(self.port, payload)

    def write_headers(self, extra=None, etag=None):
        h = self.hub.write_headers(etag)
        h.update(extra or {})
        return h

    def get_data(self):
        status, h, body = self.req("GET", "/api/data")
        self.assertEqual(status, 200, body)
        return json.loads(body), h["etag"]

    def put(self, obj, etag, extra=None):
        return self.req("PUT", "/api/data", json.dumps(obj), self.write_headers(extra, etag))

    def file_etag(self) -> str:
        return '"' + hashlib.sha256((self.data_dir / "data.json").read_bytes()).hexdigest() + '"'

    # ------------------------------------------------------------ binding
    def test_00_isolated_and_loopback_only(self):
        self.assertNotEqual(self.port, LIVE_PORT)
        self.assertNotEqual(self.data_dir.resolve(), REAL_DATA_DIR)
        ip = primary_ip()
        if not ip or ip.startswith("127."):
            self.skipTest("this machine has no non-loopback address")
        with self.assertRaises(OSError, msg=f"the hub must not be reachable on {ip}"):
            socket.create_connection((ip, self.port), timeout=2).close()

    # ---------------------------------------------------------------- API
    def test_01_health_and_headers(self):
        status, h, body = self.req("GET", "/api/health")
        self.assertEqual(status, 200)
        info = json.loads(body)
        self.assertIs(info["ok"], True)
        self.assertEqual(info["app"], "fitness-hub")
        self.assertEqual(info["version"], server.APP_VERSION)
        for key in ("build", "pid", "instance", "listen", "data_bytes", "last_backup", "backups", "data_file", "backup_dir"):
            self.assertIn(key, info)
        self.assertEqual(info["listen"], "tcp")
        self.assertRegex(info["instance"], r"^[0-9a-f]{32}$")
        self.assertEqual(h.get("x-hub-build"), info["build"])
        self.assertEqual(h.get("content-security-policy"), CSP)
        self.assertEqual(h.get("x-content-type-options"), "nosniff")
        self.assertEqual(h.get("referrer-policy"), "no-referrer")
        self.assertEqual(h.get("x-frame-options"), "DENY")
        self.assertEqual(h.get("cross-origin-resource-policy"), "same-origin")
        self.assertEqual(h.get("cache-control"), "no-store")
        self.assertFalse(any(k.startswith("access-control-") for k in h), "no CORS headers")

    def test_02_default_data_and_strong_etag(self):
        d, etag = self.get_data()
        self.assertEqual(d["schema_version"], 1)
        self.assertEqual(d["profile"]["name"], "", "no name until the user gives one")
        self.assertIsNone(d["profile"]["program_start"], "no start date: the app uses the next Monday")
        self.assertIsNone(d["profile"]["injury_date"])
        self.assertEqual(d["arm"]["appointments"], [], "no appointment is made up")
        for k in ("checkins", "workouts", "hikes", "tests", "measurements", "weekly_reviews"):
            self.assertEqual(d[k], [])
        self.assertRegex(etag, r'^"[0-9a-f]{64}"$', "strong ETag: quoted sha256 hex")
        self.assertEqual(etag, self.file_etag(), "ETag is the sha256 of the stored bytes")
        status, h, _ = self.req("GET", "/api/data")
        self.assertEqual(h.get("cache-control"), "no-store")
        self.assertEqual(h.get("vary"), "Accept-Encoding")
        info = json.loads(self.req("GET", "/api/health")[2])
        self.assertEqual(info["data_bytes"], (self.data_dir / "data.json").stat().st_size)

    def test_03_put_requires_if_match(self):
        d, etag = self.get_data()
        before = (self.data_dir / "data.json").read_bytes()
        status, _, body = self.req("PUT", "/api/data", json.dumps(d), self.write_headers())
        self.assertEqual(status, 428, body)
        self.assertIn(b"If-Match", body)
        status, _, _ = self.req("PUT", "/api/data", json.dumps(d), self.write_headers(etag="*"))
        self.assertEqual(status, 428, '"*" is not a specific version')
        for bad in ("abc", etag.strip('"'), '"unterminated', '"a" "b"'):
            status, _, _ = self.req("PUT", "/api/data", json.dumps(d), self.write_headers(etag=bad))
            self.assertEqual(status, 400, bad)
        # 428 is decided before the build and the body (verify.sh relies on it, with no X-Hub-Build at all)
        status, _, _ = self.req("PUT", "/api/data", '{"verify": "no-if-match"}', WRITE)
        self.assertEqual(status, 428)
        self.assertEqual((self.data_dir / "data.json").read_bytes(), before, "rejected writes never touch the file")

    def test_04_put_round_trip_etag_and_daily_backup(self):
        d, etag = self.get_data()
        d["checkins"].append({"date": "2026-11-21", "weight_kg": 72.4, "notes": "Caf\u00e9 \u2713"})
        status, h, body = self.put(d, etag)
        self.assertEqual(status, 200, body)
        info = json.loads(body)
        self.assertIs(info["ok"], True)
        self.assertIsNone(info["auto_backup"], "a growing array needs no safety copy")
        self.assertEqual(h.get("etag"), info["etag"])
        self.assertEqual(info["etag"], self.file_etag(), "the new ETag matches the stored bytes")
        self.assertNotEqual(info["etag"], etag)
        self.assertEqual(h.get("cache-control"), "no-store")
        again, etag2 = self.get_data()
        self.assertEqual(etag2, info["etag"])
        self.assertEqual(again["checkins"][0]["weight_kg"], 72.4)
        self.assertEqual(again["checkins"][0]["notes"], "Caf\u00e9 \u2713")
        backups = list((self.data_dir / "backups").glob("data-*.json"))
        self.assertEqual(len(backups), 1, "first save of the day backs up the previous file")
        self.assertEqual(json.loads(backups[0].read_text(encoding="utf-8"))["checkins"], [])
        again["checkins"][0]["notes"] = "second save"
        status, _, body = self.put(again, etag2)
        self.assertEqual(status, 200, body)
        self.assertEqual(len(list((self.data_dir / "backups").glob("data-*.json"))), 1, "only one daily backup")
        self.assertFalse(list(self.data_dir.glob(".tmp-*")), "no temp files left behind")
        self.assertFalse(list((self.data_dir / "backups").glob(".tmp-*")))

    def test_05_stale_if_match_gets_412(self):
        d, etag = self.get_data()
        status, _, body = self.put(d | {"hike_ladder": {"1": {"done": "2026-11-21"}}}, etag)
        self.assertEqual(status, 200, body)
        current = json.loads(body)["etag"]
        before = (self.data_dir / "data.json").read_bytes()
        status, h, body = self.put(d, etag)  # the old ETag
        self.assertEqual(status, 412, body)
        info = json.loads(body)
        self.assertIn("error", info)
        self.assertEqual(info["current_etag"], current)
        self.assertEqual(h.get("etag"), current)
        status, _, _ = self.put(d, "W/" + current)
        self.assertEqual(status, 412, "If-Match uses strong comparison: weak tags never match")
        self.assertEqual((self.data_dir / "data.json").read_bytes(), before, "a 412 never writes")
        status, _, body = self.put(d, f'"{"0" * 64}", {current}')
        self.assertEqual(status, 200, "a list matches if any entity-tag matches")
        new = json.loads(body)["etag"]
        for _ in range(3):  # chaining: each save uses the ETag the previous one returned
            d["kit_owned"] = {"boots": not d.get("kit_owned", {}).get("boots")}
            status, _, body = self.put(d, new)
            self.assertEqual(status, 200, body)
            new = json.loads(body)["etag"]
        self.assertEqual(new, self.file_etag())

    def test_06_concurrent_puts_are_serialised(self):
        base, etag = self.get_data()
        results = []
        start = threading.Event()

        def writer(i):
            doc = dict(base, checkins=[{"date": "2026-11-22", "notes": f"writer {i}"}])
            start.wait()
            status, _, _ = self.put(doc, etag)
            results.append((status, i))

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        start.set()
        for t in threads:
            t.join(30)
        statuses = sorted(s for s, _ in results)
        self.assertEqual(len(statuses), 8)
        self.assertEqual(statuses.count(200), 1, statuses)
        self.assertEqual(statuses.count(412), 7, statuses)
        winner = next(i for s, i in results if s == 200)
        d, _ = self.get_data()
        self.assertEqual(d["checkins"][0]["notes"], f"writer {winner}", "the one 200 is what's stored")

    def test_07_put_same_origin_allowed(self):
        for origin in (f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}"):
            d, etag = self.get_data()
            status, _, body = self.put(d, etag, {"Origin": origin, "Sec-Fetch-Site": "same-origin"})
            self.assertEqual(status, 200, (origin, body))

    def test_08_csrf_guards(self):
        d, etag = self.get_data()
        body = json.dumps(d)
        build = {"X-Hub-Build": self.build}
        cases = [
            ("no custom header", {"Content-Type": "application/json", "If-Match": etag, **build}),
            ("wrong custom header", {"Content-Type": "application/json", "X-Fitness-Hub": "yes", "If-Match": etag, **build}),
            ("form content type", {"Content-Type": "application/x-www-form-urlencoded", "X-Fitness-Hub": "1", "If-Match": etag, **build}),
            ("text/plain", {"Content-Type": "text/plain", "X-Fitness-Hub": "1", "If-Match": etag, **build}),
            ("evil origin", self.write_headers({"Origin": "http://evil.example"}, etag)),
            ("null origin", self.write_headers({"Origin": "null"}, etag)),
            ("other port origin", self.write_headers({"Origin": f"http://127.0.0.1:{self.port + 1}"}, etag)),
            ("https origin", self.write_headers({"Origin": f"https://127.0.0.1:{self.port}"}, etag)),
            ("ts.net origin", self.write_headers({"Origin": "https://hub.example-tailnet.ts.net"}, etag)),
            ("cross-site fetch", self.write_headers({"Sec-Fetch-Site": "cross-site"}, etag)),
            ("same-site fetch", self.write_headers({"Sec-Fetch-Site": "same-site"}, etag)),
        ]
        for label, hdrs in cases:
            status, h, _ = self.req("PUT", "/api/data", body, hdrs)
            self.assertEqual(status, 403, label)
            self.assertFalse(any(k.startswith("access-control-") for k in h))
        status, _, _ = self.req("POST", "/api/backup", "{}", {"Content-Type": "application/json"})
        self.assertEqual(status, 403, "backup also needs the header")
        self.assertEqual(self.get_data()[1], etag, "nothing was written")

    def test_09_put_validation(self):
        _, etag = self.get_data()
        deep_ok = '{"schema_version": 1, "x": ' + "[" * 60 + "]" * 60 + "}"
        deep_bad = '{"schema_version": 1, "x": ' + "[" * 70 + "]" * 70 + "}"
        very_deep = '{"schema_version": 1, "x": ' + "[" * 200_000 + "]" * 200_000 + "}"
        cases = [("invalid json", "{nope"), ("array", "[1,2]"), ("no version", '{"profile": {}}'),
                 ("string version", '{"schema_version": "1"}'), ("bool version", '{"schema_version": true}'),
                 ("zero version", '{"schema_version": 0}'), ("NaN", '{"schema_version": 1, "x": NaN}'),
                 ("Infinity", '{"schema_version": 1, "x": Infinity}'), ("float version", '{"schema_version": 1.5}'),
                 ("too deep", deep_bad), ("far too deep", very_deep),
                 ("lone surrogate", '{"schema_version": 1, "x": "\\ud800"}'),
                 ("lone low surrogate", '{"schema_version": 1, "x": "\\udc00 \\ud83d\\ude00"}'),
                 ("not utf-8", b'{"schema_version": 1, "x": "\xff"}')]
        for label, payload in cases:
            status, _, body = self.req("PUT", "/api/data", payload, self.write_headers(etag=etag))
            self.assertEqual(status, 400, (label, body))
        self.assertEqual(self.get_data()[1], etag, "bad writes never reach the file")
        status, _, body = self.req("PUT", "/api/data", deep_ok, self.write_headers(etag=etag))
        self.assertEqual(status, 200, body)
        pair = '{"schema_version": 1, "x": "\\ud83d\\ude00 and \\\\ud800 is just text"}'
        status, _, body = self.req("PUT", "/api/data", pair, self.write_headers(etag=json.loads(body)["etag"]))
        self.assertEqual(status, 200, ("a proper surrogate pair and an escaped backslash are fine", body))
        d = server.default_data()
        status, _, body = self.put(d, json.loads(body)["etag"])
        self.assertEqual(status, 200, body)

    def test_10_body_limits(self):
        head = (f"PUT /api/data HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nContent-Type: application/json\r\n"
                f"X-Fitness-Hub: 1\r\nX-Hub-Build: {self.build}\r\nIf-Match: \"x\"\r\n")
        try:
            resp = self.raw((head + f"Content-Length: {11 * 1024 * 1024}\r\n\r\n").encode())
            self.assertIn(b" 413 ", resp.split(b"\r\n", 1)[0])
        except (ConnectionAbortedError, ConnectionResetError):
            pass  # Windows may reset the socket after the early 413; that's still a rejection
        for label, extra, expected in [
            ("two lengths", "Content-Length: 2\r\nContent-Length: 3\r\n\r\n{}", b" 400 "),
            ("underscore", "Content-Length: 1_0\r\n\r\n{}", b" 400 "),
            ("plus sign", "Content-Length: +2\r\n\r\n{}", b" 400 "),
            ("chunked", "Transfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n", b" 411 "),
            ("no length", "\r\n", b" 411 "),
        ]:
            resp = self.raw((head + extra).encode())
            self.assertIn(expected, resp.split(b"\r\n", 1)[0], label)
        # Early rejections read the body first, so the client always gets to see the reply.
        big = json.dumps({"schema_version": 1, "pad": "x" * (2 * 1024 * 1024)})
        for _ in range(3):
            status, _, _ = self.req("PUT", "/api/data", big, self.write_headers())
            self.assertEqual(status, 428)
            status, _, _ = self.req("PUT", "/api/data", big, self.write_headers(etag='"stale"'))
            self.assertEqual(status, 412, "a stale If-Match is refused without parsing the body")
            status, _, _ = self.req("PUT", "/api/data", big, {"Content-Type": "application/json"})
            self.assertEqual(status, 403)
        status, _, _ = self.req("POST", "/api/backup", json.dumps({"pad": "x" * 2048}), self.write_headers())
        self.assertEqual(status, 413, "the backup endpoint takes tiny bodies only")
        self.assertEqual(self.req("GET", "/api/health")[0], 200, "still healthy")

    def test_11_host_header_rebinding(self):
        for host in ("evil.example", f"evil.example:{self.port}", "127.0.0.1", f"127.0.0.1.nip.io:{self.port}",
                     f"0.0.0.0:{self.port}", f"localhost:{self.port + 1}", "hub.example-tailnet.ts.net", "localhost"):
            status, h, body = self.req("GET", "/api/data", host=host)
            self.assertEqual(status, 403, host)
            self.assertNotIn(b"schema_version", body)
            self.assertEqual(self.req("GET", "/", host=host)[0], 403, host)
        self.assertEqual(self.req("GET", "/api/health", host=f"localhost:{self.port}")[0], 200)
        resp = self.raw(b"GET /api/data HTTP/1.0\r\n\r\n")
        self.assertIn(b" 403 ", resp.split(b"\r\n", 1)[0], "no Host header is rejected")
        resp = self.raw(f"GET /api/data HTTP/1.0\r\nHost: 127.0.0.1:{self.port}\r\nHost: evil.example\r\n\r\n".encode())
        self.assertIn(b" 403 ", resp.split(b"\r\n", 1)[0], "two Host headers are rejected")

    def test_12_api_reads_refuse_cross_site_fetches(self):
        for site in ("cross-site", "same-site"):
            status, _, body = self.req("GET", "/api/data", headers={"Sec-Fetch-Site": site})
            self.assertEqual(status, 403, site)
            self.assertNotIn(b"schema_version", body)
        for site in ("same-origin", "none"):
            self.assertEqual(self.req("GET", "/api/data", headers={"Sec-Fetch-Site": site})[0], 200, site)
        self.assertEqual(self.req("GET", "/", headers={"Sec-Fetch-Site": "cross-site"})[0], 200,
                         "a link from another site may still open the app itself")

    def test_13_traversal_and_private_paths(self):
        self.get_data()
        paths = ["/../data/data.json", "/%2e%2e/data/data.json", "/%2E%2E/%2E%2E/data/data.json", "/data/data.json",
                 "/data/", "/data/backups/", "/..%2fdata/data.json", "/content/..%5c..%5cdata%5cdata.json",
                 "/content\\..\\..\\data\\data.json", "/.git/config", "/js/.secret", "/server.py", "/../server.py",
                 "//etc/passwd", "/index.html%00.js", "/CON", "/js/nul.js", "/index.html.", "/js/app.js::$DATA",
                 "/deploy/install.sh", "/../deploy/install.sh", "/.hub.lock", "/.hub.instance", "/BUILD_ID",
                 "/tests/test_server.py"]
        for p in paths:
            status, _, body = self.req("GET", p)
            self.assertIn(status, (400, 403, 404), p)
            self.assertNotIn(b"schema_version", body, p)
            self.assertNotIn(b"import argparse", body, p)

    def test_14_no_directory_listing(self):
        for p in ("/content/", "/content", "/js/", "/js", "/dev-fixtures/", "/css/"):
            status, _, body = self.req("GET", p)
            self.assertEqual(status, 404, p)
            self.assertNotIn(b"Directory listing", body, p)
        status, _, body = self.req("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"Fitness Hub", body)

    def test_15_static_types_and_caching(self):
        expected = {"/index.html": "text/html; charset=utf-8", "/js/app.js": "text/javascript; charset=utf-8",
                    "/css/app.css": "text/css; charset=utf-8"}
        json_file, md_file = public_file("*.json", "content"), public_file("*.md", "content")
        if json_file:
            expected[json_file] = "application/json; charset=utf-8"
        if md_file:
            expected[md_file] = "text/markdown; charset=utf-8"
        for path, ctype in expected.items():
            status, h, body = self.req("GET", path)
            self.assertEqual(status, 200, path)
            self.assertEqual(h.get("content-type"), ctype, path)
            self.assertEqual(h.get("content-length"), str(len(body)), path)
            self.assertNotIn("content-encoding", h, "identity unless the client asks for gzip")
            self.assertEqual(h.get("content-security-policy"), CSP, path)
            self.assertEqual(h.get("x-content-type-options"), "nosniff", path)
            self.assertEqual(h.get("cache-control"), "no-cache", f"{path}: every app file revalidates on each use")
            self.assertRegex(h.get("etag", ""), r'^"[A-Za-z0-9._-]+-[0-9a-f]+-[0-9a-f]+"$', path)
            self.assertTrue(h["etag"].startswith(f'"{self.build}-'), "the ETag carries the build id")
            self.assertIn("GMT", h.get("last-modified", ""), path)
            status, h2, body2 = self.req("GET", path, headers={"If-None-Match": h["etag"]})
            self.assertEqual((status, body2), (304, b""), path)
            self.assertEqual(h2.get("etag"), h["etag"])
            self.assertEqual(h2.get("cache-control"), "no-cache")
            status, _, _ = self.req("GET", path, headers={"If-Modified-Since": h["last-modified"]})
            self.assertEqual(status, 304, path)
            later = email.utils.formatdate(email.utils.parsedate_to_datetime(h["last-modified"]).timestamp() + 3600,
                                           usegmt=True)
            status, _, _ = self.req("GET", path, headers={"If-Modified-Since": later})
            self.assertEqual(status, 200, "only the exact date is a 304: after a rollback the files are older")
            status, _, _ = self.req("GET", path, headers={"If-None-Match": '"different"', "If-Modified-Since": h["last-modified"]})
            self.assertEqual(status, 200, "If-None-Match wins over If-Modified-Since")
        status, h, body = self.req("HEAD", "/")
        self.assertEqual((status, body), (200, b""))
        self.assertGreater(int(h.get("content-length", "0")), 0)

    def test_16_methods(self):
        for method, path in (("OPTIONS", "/api/data"), ("OPTIONS", "/"), ("POST", "/api/data"), ("DELETE", "/api/data"),
                             ("PATCH", "/api/data"), ("PUT", "/index.html"), ("POST", "/api/health"), ("HEAD", "/api/data")):
            status, h, _ = self.req(method, path, "{}" if method in ("POST", "PUT", "PATCH") else None, self.write_headers())
            self.assertEqual(status, 405, (method, path))
            self.assertFalse(any(k.startswith("access-control-") for k in h))
        self.assertEqual(self.req("GET", "/api/nothing")[0], 404)
        self.assertEqual(self.req("TRACE", "/")[0], 501)

    def test_17_manual_backup_and_health(self):
        status, _, body = self.req("POST", "/api/backup", "{}", self.write_headers())
        self.assertEqual(status, 200, body)
        info = json.loads(body)
        self.assertTrue(info["file"].startswith("manual-"))
        self.assertIs(info["reused"], False)
        self.assertTrue((self.data_dir / "backups" / info["file"]).exists())
        health = json.loads(self.req("GET", "/api/health")[2])
        self.assertIsInstance(health["last_backup"], str)
        self.assertGreaterEqual(health["backups"], 1)
        status, _, body = self.req("POST", "/api/backup", "{}", self.write_headers())
        again = json.loads(body)
        self.assertEqual((status, again["file"], again["reused"]), (200, info["file"], True),
                         "unchanged data reuses the last manual backup instead of writing another file")

    def test_18_corrupt_file_is_never_overwritten(self):
        f = self.data_dir / "data.json"
        good = f.read_bytes()
        try:
            f.write_bytes(b"{ broken")
            status, _, body = self.req("GET", "/api/data")
            self.assertEqual(status, 500)
            self.assertIn(b"backups", body)
            status, _, body = self.req("PUT", "/api/data", json.dumps(server.default_data()), self.write_headers(etag='"x"'))
            self.assertEqual(status, 412, body)
            stale_tag = json.loads(body)["current_etag"]
            status, _, body = self.req("PUT", "/api/data", json.dumps(server.default_data()), self.write_headers(etag=stale_tag))
            self.assertEqual(status, 409, "even with the right ETag a damaged file is not replaced")
            self.assertNotEqual(json.loads(body)["error"], "build_mismatch")
            self.assertEqual(f.read_bytes(), b"{ broken")
        finally:
            f.write_bytes(good)
        self.assertEqual(self.get_data()[1], self.file_etag(), "an outside change is noticed (cache keyed by stat)")

    def test_19_conditional_get_on_data(self):
        _, etag = self.get_data()
        status, h, body = self.req("GET", "/api/data", headers={"If-None-Match": etag})
        self.assertEqual((status, body), (304, b""))
        self.assertEqual(h.get("etag"), etag)
        self.assertEqual(h.get("vary"), "Accept-Encoding")
        self.assertEqual(self.req("GET", "/api/data", headers={"If-None-Match": '"other"'})[0], 200)

    def test_20_malformed_requests_are_not_echoed(self):
        for line in (b"GET /<script>alert(1)</script> HTTP/x.y\r\n\r\n", b"GET /<b>x</b> a b c\r\n\r\n"):
            resp = self.raw(line)
            head, _, body = resp.partition(b"\r\n\r\n")
            self.assertIn(b" 400 ", head.split(b"\r\n", 1)[0])
            self.assertIn(b"Content-Security-Policy:", head)
            self.assertNotIn(b"<script>", body)
            self.assertNotIn(b"<b>", body)
        resp = self.raw(b"GET /" + b"a" * 70000 + b" HTTP/1.1\r\n\r\n")
        self.assertIn(b" 414 ", resp.split(b"\r\n", 1)[0])

    def test_21_connection_cap(self):
        idle = []
        try:
            for _ in range(server.MAX_CONNECTIONS):
                idle.append(socket.create_connection(("127.0.0.1", self.port), timeout=5))
            time.sleep(0.3)  # let the server accept them all
            try:
                resp = raw_exchange(self.port, f"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode(), timeout=5)
            except OSError:
                resp = b""
            self.assertNotIn(b" 200 ", resp.split(b"\r\n", 1)[0] if resp else b"", "over the cap: refused")
            if resp:
                self.assertIn(b" 503 ", resp.split(b"\r\n", 1)[0])
        finally:
            for s in idle:
                s.close()
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                if self.req("GET", "/api/health", timeout=3)[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(0.2)
        else:
            self.fail("server did not recover after the connection flood")

    def test_22_proxy_tripwire(self):
        d, etag = self.get_data()
        headers = [("Forwarded", "for=192.0.2.60;proto=https"), ("X-Forwarded-For", "192.0.2.60"),
                   ("X-Forwarded-Host", "hub.example-tailnet.ts.net"), ("X-Forwarded-Proto", "https"),
                   ("X-Real-IP", "192.0.2.60"), ("Via", "1.1 proxy"), ("x-forwarded-port", "443"),
                   ("X-FORWARDED-FOR", "192.0.2.61"), ("Tailscale-User-Login", "someone@example.com"),
                   ("True-Client-IP", "192.0.2.62"), ("CF-Connecting-IP", "192.0.2.63")]
        for name, value in headers:
            for method, path, body, extra in (("GET", "/api/health", None, {}), ("GET", "/api/data", None, {}),
                                              ("GET", "/", None, {}), ("HEAD", "/", None, {}),
                                              ("PUT", "/api/data", json.dumps(d), self.write_headers(etag=etag)),
                                              ("POST", "/api/backup", "{}", self.write_headers())):
                status, h, resp = self.req(method, path, body, dict(extra, **{name: value}))
                self.assertEqual(status, 403, (name, method, path))
                self.assertNotIn(b"schema_version", resp)
                if method != "HEAD":
                    self.assertIn(b"proxy", resp, (name, path))
        self.assertEqual(self.get_data()[1], etag, "nothing was written through a proxy")
        self.assertEqual(self.req("GET", "/api/health", headers={"X-Requested-With": "x", "Viaduct": "y"})[0], 200,
                         "ordinary headers with similar names are fine")
        time.sleep(0.2)
        self.assertIn("event=proxy_refused", self.hub.log())
        self.assertNotIn("192.0.2.60", self.hub.log(), "header values are never logged")

    def test_23_put_stores_the_body_as_sent(self):
        _, etag = self.get_data()
        compact = json.dumps(server.default_data() | {"note": "compact"}, separators=(",", ":")).encode()
        status, h, body = self.req("PUT", "/api/data", compact, self.write_headers(etag=etag))
        self.assertEqual(status, 200, body)
        self.assertEqual((self.data_dir / "data.json").read_bytes(), compact, "stored byte for byte, no re-dump")
        self.assertEqual(h["etag"], server.strong_etag(compact), "so the ETag is the hash of what was sent")
        spaced = b'{ "schema_version" : 1,\n  "kept": "as sent" }'
        status, h, body = self.req("PUT", "/api/data", server.UTF8_BOM + spaced, self.write_headers(etag=h["etag"]))
        self.assertEqual(status, 200, body)
        self.assertEqual((self.data_dir / "data.json").read_bytes(), spaced, "only a leading BOM is dropped")
        status, _, raw = self.req("GET", "/api/data")
        self.assertEqual(raw, spaced)
        status, _, body = self.put(server.default_data(), h["etag"])
        self.assertEqual(status, 200, body)

    def test_24_preconditions_come_before_the_body(self):
        _, etag = self.get_data()
        broken = "{ this is not json"
        status, _, _ = self.req("PUT", "/api/data", broken, self.write_headers(etag='"' + "1" * 64 + '"'))
        self.assertEqual(status, 412, "a stale If-Match wins over a body that would be a 400")
        status, _, _ = self.req("PUT", "/api/data", broken, self.write_headers())
        self.assertEqual(status, 428)
        status, _, _ = self.req("PUT", "/api/data", broken, self.write_headers(etag=etag))
        self.assertEqual(status, 400, "with a current ETag the body is read and refused")


# ======================================================= features (own server)
class HubFeatureTests(unittest.TestCase):
    """A server of its own for compression, auto backups and the backup rate limit."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        cls.hub = HubProcess(Path(cls.tmp.name), name="feat").start()

    @classmethod
    def tearDownClass(cls):
        cls.hub.stop()
        cls.tmp.cleanup()

    def put(self, doc, etag):
        status, h, body = self.hub.req("PUT", "/api/data", json.dumps(doc), self.hub.write_headers(etag))
        self.assertEqual(status, 200, body)
        return json.loads(body)

    def backups(self, prefix):
        folder = self.hub.data_dir / "backups"
        return sorted(p.name for p in folder.glob(f"{prefix}-*.json")) if folder.is_dir() else []

    def test_gzip_data_keeps_the_etag_of_the_stored_bytes(self):
        d, etag = self.hub.get_data()
        d["checkins"] = [{"date": f"2026-10-{1 + i % 28:02d}", "weight_kg": 80.5, "notes": "steady"} for i in range(60)]
        saved = self.put(d, etag)
        stored = (self.hub.data_dir / "data.json").read_bytes()
        self.assertGreater(len(stored), server.GZIP_MIN_BYTES)
        status, h, body = self.hub.req("GET", "/api/data", headers={"Accept-Encoding": "gzip, deflate, br"})
        self.assertEqual(status, 200)
        self.assertEqual(h.get("content-encoding"), "gzip")
        self.assertEqual(h.get("vary"), "Accept-Encoding")
        self.assertEqual(int(h["content-length"]), len(body))
        self.assertEqual(gzip.decompress(body), stored)
        self.assertEqual(h["etag"], server.strong_etag(stored), "ETag = sha256 of the stored bytes, not the gzip")
        self.assertEqual(h["etag"], saved["etag"])
        d["profile"]["diet_notes"] = "vegetarian"
        self.put(d, h["etag"])  # If-Match with the ETag from a gzipped response works unchanged
        for refused in ("gzip;q=0", "identity", "br", "*;q=0", ""):
            status, h, body = self.hub.req("GET", "/api/data", headers={"Accept-Encoding": refused})
            self.assertNotIn("content-encoding", h, refused)
            self.assertEqual(body, (self.hub.data_dir / "data.json").read_bytes())
        status, h, _ = self.hub.req("GET", "/api/data", headers={"Accept-Encoding": "*"})
        self.assertEqual(h.get("content-encoding"), "gzip", "'*' allows gzip")

    def test_gzip_static_has_its_own_etag(self):
        path = "/js/app.js"
        status, plain_h, plain = self.hub.req("GET", path)
        status, h, body = self.hub.req("GET", path, headers={"Accept-Encoding": "gzip"})
        self.assertEqual(status, 200)
        self.assertEqual(h.get("content-encoding"), "gzip")
        self.assertEqual(h.get("vary"), "Accept-Encoding")
        self.assertEqual(gzip.decompress(body), plain)
        self.assertEqual(h["etag"], plain_h["etag"][:-1] + '-gz"')
        for tag in (h["etag"], plain_h["etag"], "W/" + h["etag"]):
            status, h2, body2 = self.hub.req("GET", path, headers={"Accept-Encoding": "gzip", "If-None-Match": tag})
            self.assertEqual((status, body2), (304, b""), tag)
            self.assertEqual(h2.get("vary"), "Accept-Encoding")
        status, hh, hbody = self.hub.req("HEAD", path, headers={"Accept-Encoding": "gzip"})
        self.assertEqual((status, hbody), (200, b""))
        self.assertEqual(hh.get("content-length"), str(len(body)))
        tiny = None
        for candidate in sorted((HUB / "public").rglob("*")):
            if (candidate.is_file() and candidate.suffix in (".js", ".css", ".json") and "dev-fixtures" not in candidate.parts
                    and candidate.stat().st_size < server.GZIP_MIN_BYTES):
                tiny = "/" + candidate.relative_to(HUB / "public").as_posix()
                break
        if tiny:
            status, th, _ = self.hub.req("GET", tiny, headers={"Accept-Encoding": "gzip"})
            self.assertEqual(status, 200)
            self.assertNotIn("content-encoding", th, "tiny files are sent as they are")

    def test_shrinking_save_takes_an_auto_backup_first(self):
        d, etag = self.hub.get_data()
        d["workouts"] = [{"id": f"w{i}", "date": "2026-11-0" + str(1 + i % 9)} for i in range(40)]
        etag = self.put(d, etag)["etag"]
        before = self.backups("auto")
        d["workouts"] = d["workouts"][:38]  # 2 of 40 (5%): no copy
        result = self.put(d, etag)
        self.assertIsNone(result["auto_backup"])
        self.assertEqual(self.backups("auto"), before)
        d["workouts"] = d["workouts"][:31]  # 7 records (> 5): copy first
        result = self.put(d, result["etag"])
        self.assertIsNotNone(result["auto_backup"])
        copy = json.loads((self.hub.data_dir / "backups" / result["auto_backup"]).read_text(encoding="utf-8"))
        self.assertEqual(len(copy["workouts"]), 38, "the copy is the data as it was before the save")
        d["arm"]["appointments"] = [{"date": "2026-12-08", "type": "Fracture clinic", "notes": "", "outcome": ""}]
        result = self.put(d, result["etag"])
        self.assertIsNone(result["auto_backup"], "adding a record never needs a copy")
        d["arm"]["appointments"] = []  # 1 of 1 (100% > 10%): copy first
        result = self.put(d, result["etag"])
        self.assertIsNotNone(result["auto_backup"])
        del d["hikes"]  # an array that disappears counts as emptied, but it was empty: no copy
        result = self.put(d, result["etag"])
        self.assertIsNone(result["auto_backup"])
        health = json.loads(self.hub.req("GET", "/api/health")[2])
        self.assertTrue(health["last_backup_file"].startswith(("auto-", "data-", "manual-")))
        self.assertIn("event=backup kind=auto", self.hub.log())

    def test_nested_lists_count_for_the_auto_backup(self):
        """README: a copy is taken before a save removes many records from ANY list, nested ones too."""
        d, etag = self.hub.get_data()
        sets = [{"kg": 40, "reps": 8, "done": True} for _ in range(3)]
        d["workouts"] = [{"id": f"n{i}", "date": "2026-11-02",
                          "exercises": [{"exercise": "goblet-squat", "sets": list(sets)} for _ in range(2)]}
                         for i in range(10)]
        d["arm"]["logs"] = [{"date": f"2026-11-{1 + i:02d}", "values": {"pain_rest": 1}, "notes": ""} for i in range(20)]
        etag = self.put(d, etag)["etag"]
        d["workouts"][0]["exercises"][0]["sets"].pop()  # 1 set of 60: an ordinary edit, no copy
        result = self.put(d, etag)
        self.assertIsNone(result["auto_backup"])
        for workout in d["workouts"]:  # all 10 workouts kept, but their 20 exercises (59 sets) gone
            workout["exercises"] = []
        result = self.put(d, result["etag"])
        self.assertIsNotNone(result["auto_backup"], "emptying workouts[].exercises is a big shrink")
        copy = json.loads((self.hub.data_dir / "backups" / result["auto_backup"]).read_text(encoding="utf-8"))
        self.assertEqual(sum(len(w["exercises"]) for w in copy["workouts"]), 20, "the copy is from before the save")
        self.assertEqual(len(copy["workouts"]), 10)
        d["arm"]["logs"] = d["arm"]["logs"][:12]  # 8 of 20 arm logs
        result = self.put(d, result["etag"])
        self.assertIsNotNone(result["auto_backup"], "arm.logs is a list like any other")


# =========================================================== slow clients
class SlowClientTests(unittest.TestCase):
    """A server with timeouts x0.05: headers 0.5 s, body 3 s, single read 0.75 s."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        cls.hub = HubProcess(Path(cls.tmp.name), name="slow", env={"FITNESS_HUB_TIMEOUT_SCALE": "0.05"}).start()

    @classmethod
    def tearDownClass(cls):
        cls.hub.stop()
        cls.tmp.cleanup()

    def test_idle_connection_is_closed(self):
        with socket.create_connection(("127.0.0.1", self.hub.port), timeout=10) as s:
            started = time.monotonic()
            try:
                data = s.recv(1024)
            except (ConnectionResetError, ConnectionAbortedError):
                data = b""
            self.assertEqual(data, b"")
            self.assertLess(time.monotonic() - started, 3.0)

    def test_trickled_headers_are_cut_off(self):
        request = f"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{self.hub.port}\r\nX-Pad: {'a' * 40}\r\n\r\n".encode()
        with socket.create_connection(("127.0.0.1", self.hub.port), timeout=10) as s:
            started = time.monotonic()
            try:
                for byte in request:  # one byte every 0.2 s: each read is quick, the whole is too slow
                    s.sendall(bytes([byte]))
                    time.sleep(0.2)
            except OSError:
                pass
            try:
                data = s.recv(1024)
            except OSError:
                data = b""
        self.assertNotIn(b" 200 ", data)
        self.assertLess(time.monotonic() - started, 8.0, "cut off at the header deadline, not after the whole drip")

    def test_slow_body_gets_408(self):
        _, h, _ = self.hub.req("GET", "/api/data")
        port = self.hub.port
        head = (f"PUT /api/data HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n"
                f"X-Fitness-Hub: 1\r\nX-Hub-Build: {self.hub.build}\r\nIf-Match: {h['etag']}\r\n"
                "Content-Length: 100\r\n\r\n").encode()
        stop = threading.Event()
        with socket.create_connection(("127.0.0.1", port), timeout=15) as s:
            s.sendall(head)
            started = time.monotonic()

            def drip():
                try:
                    while not stop.is_set():
                        s.sendall(b" ")
                        time.sleep(0.3)
                except OSError:
                    pass

            dripper = threading.Thread(target=drip, daemon=True)
            dripper.start()
            try:
                data = s.recv(4096)
            except OSError:
                data = b""
            elapsed = time.monotonic() - started
            stop.set()
        dripper.join(5)
        self.assertIn(b" 408 ", data.split(b"\r\n", 1)[0])
        self.assertTrue(2.0 < elapsed < 8.0, elapsed)
        self.assertEqual(self.hub.req("GET", "/api/health")[0], 200)


# ================================================================ build id
class BuildIdTests(unittest.TestCase):
    """A hub folder with BUILD_ID: saves from app code of another build get 409 (SPEC 5.7a)."""

    BUILD = "abc123def4567890"

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        root = Path(cls.tmp.name)
        cls.tree = mini_hub(root, cls.BUILD)
        cls.hub = HubProcess(root, name="build", hub_root=cls.tree).start()

    @classmethod
    def tearDownClass(cls):
        cls.hub.stop()
        cls.tmp.cleanup()

    def put(self, body, **headers):
        h = dict(WRITE, **headers)
        return self.hub.req("PUT", "/api/data", body, h)

    def test_health_reports_the_build(self):
        status, h, body = self.hub.req("GET", "/api/health")
        self.assertEqual(json.loads(body)["build"], self.BUILD)
        self.assertEqual(h.get("x-hub-build"), self.BUILD)
        status, h, _ = self.hub.req("GET", "/api/data")
        self.assertEqual(h.get("x-hub-build"), self.BUILD)

    def test_mismatched_or_missing_build_gets_409(self):
        d, etag = self.hub.get_data()
        body = json.dumps(d)
        for headers in ({}, {"X-Hub-Build": "0000000000000000"}, {"X-Hub-Build": "dev"}, {"X-Hub-Build": ""},
                        {"X-Hub-Build": self.BUILD.upper()}):
            status, _, resp = self.put(body, **{"If-Match": etag}, **headers)
            self.assertEqual(status, 409, headers)
            info = json.loads(resp)
            self.assertEqual((info["error"], info["build"]), ("build_mismatch", self.BUILD))
            self.assertIn("Reload", info["message"])
        status, _, resp = self.put(body, **{"If-Match": etag, "X-Hub-Build": self.BUILD})
        self.assertEqual(status, 200, resp)
        self.assertEqual(json.loads(resp)["ok"], True)

    def test_build_is_checked_before_the_body_and_after_if_match(self):
        _, etag = self.hub.get_data()
        status, _, _ = self.put("{ not json", **{"If-Match": etag, "X-Hub-Build": "other"})
        self.assertEqual(status, 409, "the body is never parsed for a stale build")
        status, _, _ = self.put("{ not json", **{"If-Match": '"' + "2" * 64 + '"', "X-Hub-Build": "other"})
        self.assertEqual(status, 409, "build before staleness: an old app must reload, not merge")
        status, _, _ = self.put('{"verify": "no-if-match"}', **{"X-Hub-Build": "other"})
        self.assertEqual(status, 428, "a missing If-Match is still 428 (verify.sh sends no build header)")
        time.sleep(0.2)
        self.assertIn("event=build_mismatch", self.hub.log())

    def test_dev_build_accepts_any_header(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as t:
            tree = mini_hub(Path(t), None, name="devtree")
            hub = HubProcess(Path(t), name="dev", hub_root=tree).start()
            try:
                self.assertEqual(hub.build, "dev")
                for headers in ({}, {"X-Hub-Build": "anything"}):
                    d, etag = hub.get_data()
                    d["n"] = len(headers)
                    status, _, body = hub.req("PUT", "/api/data", json.dumps(d), dict(WRITE, **{"If-Match": etag}, **headers))
                    self.assertEqual(status, 200, (headers, body))
            finally:
                hub.stop()

    def test_a_reload_after_an_update_gets_the_new_code(self):
        """App files are served no-cache with an ETag that holds the build id: every reload revalidates
        (a cheap 304 while nothing changed), and after an update the browser's old ETag gets the new file,
        even one whose size and mtime stayed the same. Gzip is kept."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as t:
            root = Path(t)
            tree = mini_hub(root, "build-one", name="cachetree")
            (tree / "public" / "css").mkdir()
            (tree / "public" / "css" / "app.css").write_text("body { color: #123456; }\n" * 80, encoding="utf-8")
            (tree / "public" / "content").mkdir()
            (tree / "public" / "content" / "program.json").write_text('{"phases": []}', encoding="utf-8")
            paths = ("/", "/index.html", "/js/app.js", "/css/app.css", "/content/program.json")
            app_js = tree / "public" / "js" / "app.js"
            hub = HubProcess(root, name="cache1", hub_root=tree).start()
            try:
                before = {}
                for path in paths:
                    status, h, body = hub.req("GET", path)
                    self.assertEqual((status, h.get("cache-control")), (200, "no-cache"), path)
                    self.assertTrue(h["etag"].startswith('"build-one-'), (path, h["etag"]))
                    status, h2, body2 = hub.req("GET", path, headers={"If-None-Match": h["etag"]})
                    self.assertEqual((status, body2, h2.get("cache-control")), (304, b"", "no-cache"), path)
                    before[path] = h["etag"]
                status, h, body = hub.req("GET", "/css/app.css", headers={"Accept-Encoding": "gzip"})
                self.assertEqual((h.get("content-encoding"), h.get("cache-control")), ("gzip", "no-cache"))
                self.assertEqual(h["etag"], before["/css/app.css"][:-1] + '-gz"')
                self.assertEqual(gzip.decompress(body), (tree / "public" / "css" / "app.css").read_bytes())
            finally:
                hub.stop()
            # "Update": new code of the same size with the old mtime, and a new BUILD_ID.
            info = app_js.stat()
            new_code = app_js.read_bytes().replace(b"ok = 1", b"ok = 2")
            app_js.write_bytes(new_code)
            self.assertEqual(app_js.stat().st_size, info.st_size)
            os.utime(app_js, ns=(info.st_atime_ns, info.st_mtime_ns))
            (tree / "BUILD_ID").write_text("build-two\n", encoding="ascii")
            hub = HubProcess(root, name="cache2", hub_root=tree).start()
            try:
                status, h, body = hub.req("GET", "/js/app.js", headers={"If-None-Match": before["/js/app.js"]})
                self.assertEqual((status, body), (200, new_code), "the reload gets the new code")
                self.assertTrue(h["etag"].startswith('"build-two-'))
                for path in paths:
                    status, _, _ = hub.req("GET", path, headers={"If-None-Match": before[path]})
                    self.assertEqual(status, 200, f"{path}: an old ETag never matches a new build")
            finally:
                hub.stop()

    def test_bad_build_file_is_refused(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as t:
            for value in ("has space", "x" * 65, "semi;colon", ""):
                tree = mini_hub(Path(t), value, name=f"bad{len(value)}{value[:1]}")
                env = clean_env(FITNESS_HUB_PORT=str(free_port()), FITNESS_HUB_DATA_DIR=str(Path(t) / "d"))
                r = run_server(env, hub_root=tree)
                self.assertEqual(r.returncode, 2, (value, r.stderr))
                self.assertIn(b"build id", r.stderr)
            tree = mini_hub(Path(t), self.BUILD, name="checkme")
            env = clean_env(FITNESS_HUB_PORT=str(free_port()), FITNESS_HUB_DATA_DIR=str(Path(t) / "d2"))
            r = run_server(env, "--check", hub_root=tree)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn(f"build {self.BUILD}".encode(), r.stdout)


# ======================================================== process lifecycle
class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def env(self, **extra):
        settings = {"FITNESS_HUB_PORT": str(free_port()), "FITNESS_HUB_DATA_DIR": str(self.root / "data")}
        settings.update(extra)
        return clean_env(**settings)

    def test_refuses_non_loopback_bind(self):
        for host in ("0.0.0.0", "192.168.1.5", "::", "[::]", "example.com", "127.0.0.2", "*"):
            r = run_server(self.env(FITNESS_HUB_HOST=host))
            self.assertEqual(r.returncode, 2, host)
            self.assertIn(b"loopback", r.stderr, host)

    def test_refuses_bad_settings(self):
        for key, value in (("FITNESS_HUB_PORT", "0"), ("FITNESS_HUB_PORT", "70000"), ("FITNESS_HUB_PORT", "80a"),
                           ("FITNESS_HUB_TIMEOUT_SCALE", "5")):
            env = self.env()
            env[key] = value
            r = run_server(env)
            self.assertEqual(r.returncode, 2, (key, value, r.stderr))
            self.assertIn(b"Refusing to start", r.stderr)

    def test_extra_hosts_was_removed_and_is_refused(self):
        for value in ("hub.example-tailnet.ts.net", "*.ts.net", "192.168.1.5"):
            r = run_server(self.env(FITNESS_HUB_EXTRA_HOSTS=value))
            self.assertEqual(r.returncode, 2, value)
            self.assertIn(b"FITNESS_HUB_EXTRA_HOSTS has been removed", r.stderr)
        r = run_server(self.env(FITNESS_HUB_EXTRA_HOSTS=""), "--check")
        self.assertEqual(r.returncode, 0, "an empty value is harmless")

    def test_tailscale_settings_are_checked_before_anything_starts(self):
        r = run_server(self.env(FITNESS_HUB_TS_HOST=TS_HOST))
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn(b"needs all three settings", r.stderr)
        for args in ((), ("--check",)):
            # Without FITNESS_HUB_SOCKET: refused on Linux (socket mode needed) and everywhere else (Linux only).
            r = run_server(self.env(**TS_ENV), *args)
            self.assertEqual(r.returncode, 2, r.stderr)
            self.assertIn(b"Refusing to start", r.stderr)
        r = run_server(self.env(**dict(TS_ENV, FITNESS_HUB_TS_USERS="*")))
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertFalse((self.root / "data").exists(), "refused before the data folder is touched")
        r = run_server(self.env(**{name: "" for name in server.TS_VARS}), "--check")
        self.assertEqual(r.returncode, 0, "empty values mean no phone access")
        self.assertNotIn(b"Tailscale", r.stdout)

    def test_refuses_data_dir_in_or_around_public(self):
        inside = HUB / "public" / "__must_not_exist__"
        for target in (inside, HUB):
            r = run_server(self.env(FITNESS_HUB_DATA_DIR=str(target)))
            self.assertEqual(r.returncode, 2, target)
            self.assertIn(b"web", r.stderr)
        self.assertFalse(inside.exists())

    def test_one_hub_per_data_folder(self):
        first = HubProcess(self.root, name="first").start()
        try:
            r = run_server(clean_env(FITNESS_HUB_PORT=str(free_port()), FITNESS_HUB_DATA_DIR=str(first.data_dir)))
            self.assertEqual(r.returncode, 1, r.stderr)
            self.assertIn(b"already using the data folder", r.stderr)
        finally:
            first.stop()

    def test_graceful_stop_on_signal(self):
        hub = HubProcess(self.root, name="stop").start()
        try:
            if os.name == "nt":
                try:
                    hub.proc.send_signal(signal.CTRL_BREAK_EVENT)
                except (OSError, ValueError) as exc:
                    self.skipTest(f"can't send CTRL_BREAK here: {exc}")
            else:
                hub.proc.send_signal(signal.SIGTERM)
            code = hub.proc.wait(timeout=15)
        finally:
            hub.stop()
        log = hub.log()
        self.assertEqual(code, 0, log)
        self.assertIn("event=stop signal=", log)
        self.assertIn("event=stopped clean=True", log)
        self.assertFalse((hub.data_dir / ".hub.instance").exists(), "the instance record goes at a clean stop")
        again = HubProcess(self.root, name="again", data_dir=hub.data_dir).start()  # the folder lock was released
        again.stop()

    def test_startup_removes_stray_temp_files(self):
        data = self.root / "stray"
        (data / "backups").mkdir(parents=True)
        for stray in (data / ".tmp-abc123.json", data / "backups" / ".tmp-x1.json", data / ".check-99.tmp"):
            stray.write_text("{}")
        keep = data / "notes.txt"
        keep.write_text("mine")
        hub = HubProcess(self.root, name="stray", data_dir=data).start()
        hub.stop()
        self.assertFalse(list(data.rglob(".tmp-*")))
        self.assertFalse((data / ".check-99.tmp").exists())
        self.assertTrue(keep.exists(), "only the hub's own temp files are removed")

    def test_check_mode(self):
        env = self.env()
        r = run_server(env, "--check")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn(b"check: all good", r.stdout)
        self.assertIn(b"check: OK   build ", r.stdout)
        self.assertNotIn(b"extra hosts", r.stdout)
        (self.root / "data" / "data.json").write_text("{ broken", encoding="utf-8")
        r = run_server(env, "--check")
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn(b"NOT valid", r.stdout)
        r = run_server(dict(env, FITNESS_HUB_HOST="0.0.0.0"), "--check")
        self.assertEqual(r.returncode, 2)

    # ------------------------------------------------- port already taken
    def test_listener_claiming_to_be_the_hub_is_not_trusted(self):
        port = free_port()
        fake = FakeHubListener(port, {"ok": True, "app": "fitness-hub", "pid": 1, "instance": "0" * 32})
        try:
            r = run_server(self.env(FITNESS_HUB_PORT=str(port)), "--open")
        finally:
            fake.close()
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn(b"Another program is using port", r.stderr)
        self.assertNotIn(b"already running", r.stderr, "answering app=fitness-hub proves nothing")

    def test_under_systemd_a_taken_port_means_stop_the_other_program(self):
        port = free_port()
        holder = socket.socket()
        holder.bind(("127.0.0.1", port))
        holder.listen(1)
        try:
            r = run_server(self.env(FITNESS_HUB_PORT=str(port), INVOCATION_ID="0123456789abcdef"))
        finally:
            holder.close()
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn(b"Stop the other program; don't change the port", r.stderr)
        self.assertNotIn(b"FITNESS_HUB_PORT", r.stderr, "no advice to move the port under systemd")

    def test_our_own_hub_is_recognised_by_pid_and_instance(self):
        first = HubProcess(self.root, name="mine").start()
        try:
            r = run_server(clean_env(FITNESS_HUB_PORT=str(first.port), FITNESS_HUB_DATA_DIR=str(first.data_dir)))
            self.assertEqual(r.returncode, 1, r.stderr)
            self.assertIn(b"already running", r.stderr)
            record = json.loads((first.data_dir / ".hub.instance").read_text(encoding="utf-8"))
            self.assertEqual(record["listen"], f"127.0.0.1:{first.port}")
            self.assertEqual(record["pid"], first.proc.pid)
            # Replaying our hub's real pid and instance from another port is still refused.
            health = json.loads(first.req("GET", "/api/health")[2])
            port = free_port()
            fake = FakeHubListener(port, health)
            try:
                r = run_server(clean_env(FITNESS_HUB_PORT=str(port), FITNESS_HUB_DATA_DIR=str(first.data_dir)))
            finally:
                fake.close()
            self.assertEqual(r.returncode, 1, r.stderr)
            self.assertIn(b"Another program is using port", r.stderr)
        finally:
            first.stop()

    def test_backup_endpoint_is_rate_limited(self):
        hub = HubProcess(self.root, name="rate").start()
        try:
            d, etag = hub.get_data()
            for i in range(server.BACKUP_WINDOW_MAX):
                d["n"] = i
                status, h, body = hub.req("PUT", "/api/data", json.dumps(d), hub.write_headers(etag))
                etag = h["etag"]
                status, _, body = hub.req("POST", "/api/backup", "{}", hub.write_headers())
                self.assertEqual(status, 200, (i, body))
            status, _, body = hub.req("POST", "/api/backup", "{}", hub.write_headers())
            self.assertEqual((status, json.loads(body)["reused"]), (200, True), "unchanged data: no new file needed")
            d["n"] = "more"
            hub.req("PUT", "/api/data", json.dumps(d), hub.write_headers(etag))
            status, h, body = hub.req("POST", "/api/backup", "{}", hub.write_headers())
            self.assertEqual(status, 429, body)
            self.assertGreater(int(h["retry-after"]), 0)
            self.assertEqual(json.loads(body)["retry_after"], int(h["retry-after"]))
            files = list((hub.data_dir / "backups").glob("manual-*.json"))
            self.assertEqual(len(files), server.BACKUP_WINDOW_MAX)
        finally:
            hub.stop()

    @unittest.skipIf(server.HAS_UNIX_SOCKETS, "this platform has Unix sockets")
    def test_socket_mode_needs_unix_sockets(self):
        r = run_server(self.env(FITNESS_HUB_SOCKET="/run/user/1000/fitness-hub/hub.sock"))
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn(b"Unix sockets", r.stderr)


# ============================================================ socket mode
@unittest.skipUnless(UNIX_SOCKETS, "needs Unix sockets and POSIX permissions (Linux)")
class SocketModeTests(unittest.TestCase):
    """The Linux server mode: a 0600 socket in a 0700 folder, and no TCP listener at all."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = private_tmp()
        cls.root = Path(cls.tmp.name)
        (cls.root / "rt").mkdir(mode=0o700)
        cls.sock = cls.root / "rt" / "fitness-hub" / "hub.sock"
        cls.hub = HubProcess(cls.root, name="sock", socket_path=cls.sock).start()

    @classmethod
    def tearDownClass(cls):
        cls.hub.stop()
        cls.tmp.cleanup()

    def test_socket_and_folder_are_private(self):
        info = os.lstat(self.sock)
        self.assertTrue(stat.S_ISSOCK(info.st_mode))
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
        self.assertEqual(info.st_uid, os.getuid())
        folder = os.lstat(self.sock.parent)
        self.assertEqual(stat.S_IMODE(folder.st_mode), 0o700)
        self.assertEqual(folder.st_uid, os.getuid())

    def test_no_tcp_listener_at_all(self):
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", self.hub.port), timeout=2).close()
        fd_dir = Path(f"/proc/{self.hub.proc.pid}/fd")
        if not fd_dir.is_dir():
            self.skipTest("no /proc here")
        inodes = set()
        for fd in fd_dir.iterdir():
            try:
                target = os.readlink(fd)
            except OSError:
                continue
            if target.startswith("socket:["):
                inodes.add(target[8:-1])
        tcp_inodes = set()
        for table in ("/proc/net/tcp", "/proc/net/tcp6"):
            try:
                rows = Path(table).read_text().splitlines()[1:]
            except OSError:
                continue
            tcp_inodes.update(row.split()[9] for row in rows if len(row.split()) > 9)
        self.assertTrue(inodes, "the hub has its Unix socket open")
        self.assertFalse(inodes & tcp_inodes, "the hub holds no TCP socket of any kind")

    def test_http_over_the_socket(self):
        status, h, body = self.hub.req("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["listen"], "unix")
        for host in ("localhost", "evil.example", f"127.0.0.1:{self.hub.port + 1}", "hub.example-tailnet.ts.net"):
            self.assertEqual(self.hub.req("GET", "/api/health", host=host)[0], 403, host)
        self.assertEqual(self.hub.req("GET", "/api/health", headers={"X-Forwarded-For": "100.64.0.1"})[0], 403)
        self.assertEqual(self.hub.req("GET", "/api/health", headers={"Tailscale-User-Login": "a@b.c"})[0], 403)
        d, etag = self.hub.get_data()
        d["checkins"].append({"date": "2026-11-21"})
        status, h, body = self.hub.req("PUT", "/api/data", json.dumps(d), self.hub.write_headers(etag))
        self.assertEqual(status, 200, body)
        self.assertEqual(self.hub.get_data()[1], h["etag"])


@unittest.skipUnless(UNIX_SOCKETS, "needs Unix sockets and POSIX permissions (Linux)")
class SocketRefusalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = private_tmp()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def env(self, sock, **extra):
        return clean_env(FITNESS_HUB_PORT=str(free_port()), FITNESS_HUB_DATA_DIR=str(self.root / "data"),
                         FITNESS_HUB_SOCKET=str(sock), **extra)

    def test_unsafe_places_are_refused(self):
        open_dir = self.root / "open"
        open_dir.mkdir()
        os.chmod(open_dir, 0o755)
        r = run_server(self.env(open_dir / "hub.sock"))
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn(b"other users", r.stderr)
        shared = self.root / "shared"
        shared.mkdir()
        os.chmod(shared, 0o777)  # writable by everyone, no sticky bit
        r = run_server(self.env(shared / "fitness-hub" / "hub.sock"))
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertFalse((shared / "fitness-hub").exists() and any((shared / "fitness-hub").iterdir()))
        private = self.root / "private"
        private.mkdir(mode=0o700)
        regular = private / "hub.sock"
        regular.write_text("not a socket")
        r = run_server(self.env(regular))
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn(b"not a socket", r.stderr)
        self.assertEqual(regular.read_text(), "not a socket", "never removed")
        link = private / "link"
        os.symlink(private, link)
        r = run_server(self.env(link / "hub.sock"))
        self.assertEqual(r.returncode, 2, r.stderr)

    def test_bad_socket_settings_are_refused(self):
        for value in ("relative/hub.sock", "/tmp/../tmp/hub.sock", "/" + "x" * 120 + "/hub.sock"):
            r = run_server(self.env(value))
            self.assertEqual(r.returncode, 2, (value, r.stderr))
        r = run_server(self.env(self.root / "s" / "hub.sock", FITNESS_HUB_HOST="127.0.0.1"))
        self.assertEqual(r.returncode, 2)
        self.assertIn(b"not both", r.stderr)

    def test_stale_socket_is_replaced_and_live_one_is_refused(self):
        folder = self.root / "rt"
        folder.mkdir(mode=0o700)
        path = folder / "hub.sock"
        stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stale.bind(str(path))
        stale.close()  # leaves the socket file behind, with nobody listening
        hub = HubProcess(self.root, name="a", socket_path=path).start()
        try:
            self.assertEqual(hub.req("GET", "/api/health")[0], 200)
            r = run_server(clean_env(FITNESS_HUB_PORT=str(free_port()), FITNESS_HUB_DATA_DIR=str(self.root / "other"),
                                     FITNESS_HUB_SOCKET=str(path)))
            self.assertEqual(r.returncode, 1, r.stderr)
            self.assertIn(b"already listening", r.stderr)
            self.assertEqual(hub.req("GET", "/api/health")[0], 200, "the running hub's socket was not touched")
        finally:
            hub.stop()
        self.assertFalse(path.exists(), "a clean stop removes the socket")

    def test_check_reports_socket_mode(self):
        r = run_server(self.env(self.root / "rt2" / "hub.sock"), "--check")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn(b"Unix socket only, no TCP", r.stdout)


@unittest.skipUnless(LINUX_SOCKETS, "Tailscale mode needs Linux (Unix sockets and POSIX permissions)")
class TailscaleSocketTests(unittest.TestCase):
    """Opt-in phone access end to end: the main socket and the Tailscale socket, two listeners with
    two policies over one data folder. The tests play Tailscale Serve's part on ts.sock."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = private_tmp()
        cls.root = Path(cls.tmp.name)
        (cls.root / "rt").mkdir(mode=0o700)
        cls.sock = cls.root / "rt" / "fitness-hub" / "hub.sock"
        cls.ts_sock = cls.sock.parent / "ts.sock"
        cls.hub = HubProcess(cls.root, name="ts", socket_path=cls.sock, env={
            "FITNESS_HUB_TS_SOCKET": str(cls.ts_sock), "FITNESS_HUB_TS_HOST": TS_HOST,
            "FITNESS_HUB_TS_USERS": f"{TS_LOGIN.upper()},alex@github", "FITNESS_HUB_LOG_LEVEL": "debug"}).start()

    @classmethod
    def tearDownClass(cls):
        cls.hub.stop()
        cls.tmp.cleanup()

    def ts_req(self, method, path, body=None, headers=None, host="localhost"):
        return http_request(self.hub.port, method, path, body, headers, host, unix_path=str(self.ts_sock))

    def test_both_sockets_are_private_and_there_is_no_tcp(self):
        for path in (self.sock, self.ts_sock):
            info = os.lstat(path)
            self.assertTrue(stat.S_ISSOCK(info.st_mode), path)
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o600, path)
            self.assertEqual(info.st_uid, os.getuid(), path)
        self.assertEqual(stat.S_IMODE(os.lstat(self.sock.parent).st_mode), 0o700)
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", self.hub.port), timeout=2).close()
        self.assertIn("event=ready", self.hub.log())
        self.assertIn(f"tailscale=https://{TS_HOST}/", self.hub.log())

    def test_each_socket_keeps_its_own_policy(self):
        status, h, body = self.ts_req("GET", "/api/health", headers=SERVE_HEADERS)
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["listen"], "tailscale")
        self.assertEqual(h.get("cache-control"), "no-store")
        self.assertEqual(json.loads(self.hub.req("GET", "/api/health")[2])["listen"], "unix")
        for name, value in SERVE_HEADERS.items():  # the main socket never takes Serve's headers
            self.assertEqual(self.hub.req("GET", "/api/health", headers={name: value})[0], 403, name)
        self.assertEqual(self.hub.req("GET", "/api/health", host="localhost", headers=SERVE_HEADERS)[0], 403)
        self.assertEqual(self.ts_req("GET", "/api/health", host=f"127.0.0.1:{self.hub.port}")[0], 403,
                         "the Tailscale socket never takes the tunnel's requests")
        for headers in (without(SERVE_HEADERS, "Tailscale-User-Login"),
                        dict(SERVE_HEADERS, **{"Tailscale-User-Login": "someone@example.com"}),
                        dict(SERVE_HEADERS, Via="1.1 forged"), dict(SERVE_HEADERS, **{"X-Forwarded-Host": "evil.example"})):
            for path in ("/api/data", "/"):
                status, _, body = self.ts_req("GET", path, headers=headers)
                self.assertEqual(status, 403, (path, headers))
                self.assertNotIn(b"schema_version", body)
        other = dict(SERVE_HEADERS, **{"Tailscale-User-Login": "ALEX@GitHub"})
        self.assertEqual(self.ts_req("GET", "/", headers=other)[0], 200, "any allowed login, any case")

    def test_a_save_through_tailscale_is_seen_through_the_tunnel(self):
        d, etag = self.hub.get_data()
        d["checkins"].append({"date": "2025-11-24", "notes": "logged at the gym"})
        write = dict(SERVE_HEADERS, **self.hub.write_headers(etag), Origin=f"https://{TS_HOST}")
        status, h, body = self.ts_req("PUT", "/api/data", json.dumps(d), write)
        self.assertEqual(status, 200, body)
        self.assertEqual(self.hub.get_data()[1], h["etag"], "one data file behind both sockets")
        for bad in (without(write, "Origin"), dict(write, Origin=f"http://{TS_HOST}"), dict(write, Origin="null")):
            bad["If-Match"] = h["etag"]
            self.assertEqual(self.ts_req("PUT", "/api/data", json.dumps(d), bad)[0], 403, bad.get("Origin"))
        self.assertEqual(self.ts_req("PUT", "/api/data", json.dumps(d), without(write, "If-Match"))[0], 428)
        self.assertEqual(self.ts_req("POST", "/api/backup", "{}", write)[0], 200)
        refused = dict(SERVE_HEADERS, **{"Tailscale-User-Login": "intruder@example.net"})
        self.assertEqual(self.ts_req("GET", "/api/data", headers=refused)[0], 403)
        time.sleep(0.2)
        log = self.hub.log()
        self.assertNotIn("intruder@example.net", log, "refused logins are not logged")
        self.assertIn(f"via=tailscale login={TS_LOGIN}", log)
        self.assertIn("event=ts_refused", log)
        self.assertNotIn("logged at the gym", log, "request bodies are never logged")
        self.assertNotIn("100.101.102.103", log, "header values are never logged")


@unittest.skipUnless(LINUX_SOCKETS, "Tailscale mode needs Linux (Unix sockets and POSIX permissions)")
class TailscaleSocketLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = private_tmp()
        self.root = Path(self.tmp.name)
        self.folder = self.root / "rt" / "fitness-hub"
        self.folder.mkdir(parents=True, mode=0o700)
        os.chmod(self.folder.parent, 0o700)
        os.chmod(self.folder, 0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def env(self):
        return {"FITNESS_HUB_TS_SOCKET": str(self.folder / "ts.sock"), "FITNESS_HUB_TS_HOST": TS_HOST,
                "FITNESS_HUB_TS_USERS": TS_LOGIN}

    def test_a_clean_stop_removes_both_sockets(self):
        hub = HubProcess(self.root, name="life", socket_path=self.folder / "hub.sock", env=self.env()).start()
        hub.stop()
        self.assertEqual(hub.proc.returncode, 0, hub.log())
        self.assertFalse((self.folder / "hub.sock").exists())
        self.assertFalse((self.folder / "ts.sock").exists())

    def test_a_busy_tailscale_socket_stops_the_whole_hub(self):
        holder = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            holder.bind(str(self.folder / "ts.sock"))
            holder.listen(1)
            r = run_server(clean_env(FITNESS_HUB_PORT=str(free_port()), FITNESS_HUB_DATA_DIR=str(self.root / "data"),
                                     FITNESS_HUB_SOCKET=str(self.folder / "hub.sock"), **self.env()))
        finally:
            holder.close()
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn(b"already listening on the Tailscale socket", r.stderr)
        self.assertFalse((self.folder / "hub.sock").exists(), "never half started: the main socket is gone too")

    def test_check_reports_the_tailscale_socket(self):
        r = run_server(clean_env(FITNESS_HUB_PORT=str(free_port()), FITNESS_HUB_DATA_DIR=str(self.root / "data"),
                                 FITNESS_HUB_SOCKET=str(self.folder / "hub.sock"), **self.env()), "--check")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn(f"Tailscale socket {self.folder / 'ts.sock'}".encode(), r.stdout)
        self.assertIn(b"1 allowed login, no Funnel, no TCP", r.stdout)
        self.assertNotIn(TS_LOGIN.encode(), r.stdout, "--check never prints the logins")


# ============================================================ in process
class InProcessTests(unittest.TestCase):
    """A real HubServer in this process, so internals can be observed."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        root = Path(self.tmp.name)
        self.port = free_port()
        settings = server.resolve_settings({"FITNESS_HUB_PORT": str(self.port), "FITNESS_HUB_DATA_DIR": str(root / "data")},
                                           build_file=root / "no-build-file")
        settings.data_dir.mkdir(parents=True)
        self.store = server.HubStore(settings.data_dir)
        self.httpd = server.build_server(settings, self.store, instance="test")
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(5)
        self.tmp.cleanup()

    def req(self, *args, **kwargs):
        return http_request(self.port, *args, **kwargs)

    def test_parses_run_one_at_a_time(self):
        status, h, body = self.req("GET", "/api/data")
        etag = h["etag"]
        lock = threading.Lock()
        state = {"active": 0, "peak": 0, "calls": 0}
        real = server.parse_json_document

        def slow_parse(raw):
            with lock:
                state["active"] += 1
                state["calls"] += 1
                state["peak"] = max(state["peak"], state["active"])
            time.sleep(0.05)
            try:
                return real(raw)
            finally:
                with lock:
                    state["active"] -= 1

        results = []
        with mock.patch.object(server, "parse_json_document", slow_parse):
            def writer(i):
                doc = dict(json.loads(body), n=i)
                results.append(self.req("PUT", "/api/data", json.dumps(doc), dict(WRITE, **{"If-Match": etag}))[0])

            threads = [threading.Thread(target=writer, args=(i,)) for i in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(30)
        self.assertEqual(sorted(results).count(200), 1, results)
        self.assertGreaterEqual(state["calls"], 1)
        self.assertEqual(state["peak"], 1, "never two parses at once")

    def test_validators_are_checked_before_files_are_read(self):
        with mock.patch.object(server, "read_static", wraps=server.read_static) as reads:
            status, h, _ = self.req("GET", "/js/app.js")
            self.assertEqual((status, reads.call_count), (200, 1))
            status, _, _ = self.req("GET", "/js/app.js", headers={"If-None-Match": h["etag"]})
            self.assertEqual((status, reads.call_count), (304, 1), "a 304 never reads the file")
        status, h, _ = self.req("GET", "/api/data")
        data_file = self.store.data_file
        real = Path.read_bytes
        reads = []

        def counting(path):
            if path == data_file:
                reads.append(path)
            return real(path)

        with mock.patch.object(Path, "read_bytes", counting):
            status, _, _ = self.req("GET", "/api/data", headers={"If-None-Match": h["etag"]})
            self.assertEqual(status, 304)
            self.assertEqual(reads, [], "a 304 for /api/data never reads data.json")
            status, h2, body = self.req("GET", "/api/data")
            self.assertEqual(status, 200)
            self.assertEqual(len(reads), 1, "one read for a 200, and no re-parse (the ETag is cached)")
            put = self.req("PUT", "/api/data", body, dict(WRITE, **{"If-Match": h2["etag"]}))
            self.assertEqual(put[0], 200)
            self.assertEqual(len(reads), 1, "an unchanged save reads nothing")

    def assert_folder_error(self, status, body, role, folder):
        self.assertEqual(status, 500, body)
        info = json.loads(body)
        self.assertEqual((info["folder_role"], info["folder"]), (role, str(folder)))
        self.assertIn(f"the {role} folder {folder}", info["error"], "the message names the folder")
        self.assertIn("permissions", info["error"])
        if os.name == "nt":
            self.assertIn("Controlled Folder Access", info["error"])

    def test_an_unusable_backups_folder_is_a_500_that_names_it(self):
        status, h, body = self.req("GET", "/api/data")
        doc = dict(json.loads(body), checkins=[{"date": "2025-11-24", "notes": "x"}])
        backups = self.store.backup_dir
        backups.write_text("a file where the backups folder should be")
        status, _, resp = self.req("PUT", "/api/data", json.dumps(doc), dict(WRITE, **{"If-Match": h["etag"]}))
        self.assert_folder_error(status, resp, "backups", backups)
        self.assertEqual(self.store.current_etag(), h["etag"], "no safety copy, no save")
        status, _, resp = self.req("POST", "/api/backup", "{}", WRITE)
        self.assert_folder_error(status, resp, "backups", backups)
        backups.unlink()
        self.assertEqual(self.req("PUT", "/api/data", json.dumps(doc), dict(WRITE, **{"If-Match": h["etag"]}))[0], 200)

    def test_a_folder_that_refuses_new_files_is_a_fast_500_not_a_hang(self):
        """Windows Controlled Folder Access: creating any file in data/ raises PermissionError."""
        status, h, body = self.req("GET", "/api/data")
        doc = json.loads(body)
        doc["profile"]["diet_notes"] = "first save of the day: writes the daily copy"
        status, h, _ = self.req("PUT", "/api/data", json.dumps(doc), dict(WRITE, **{"If-Match": h["etag"]}))
        self.assertEqual(status, 200)
        real_open, refused = os.open, []

        def guarded_open(path, flags, mode=0o777, *args, **kwargs):
            if Path(path).name.startswith(".tmp-"):
                refused.append(path)
                raise PermissionError(errno.EACCES, "Access is denied", str(path))
            return real_open(path, flags, mode, *args, **kwargs)

        doc["profile"]["diet_notes"] = "refused"
        with mock.patch.object(server.os, "open", guarded_open):
            started = time.monotonic()
            status, _, resp = self.req("PUT", "/api/data", json.dumps(doc), dict(WRITE, **{"If-Match": h["etag"]}))
            elapsed = time.monotonic() - started
        self.assert_folder_error(status, resp, "data", self.store.data_dir)
        self.assertLess(elapsed, 5.0, "fails fast")
        self.assertEqual(len(refused), 1, "the PermissionError is not retried")
        self.assertEqual(self.store.current_etag(), h["etag"])
        status, _, _ = self.req("PUT", "/api/data", json.dumps(doc), dict(WRITE, **{"If-Match": h["etag"]}))
        self.assertEqual(status, 200, "the write lock was released")


class TailscaleInProcessTests(unittest.TestCase):
    """The Tailscale policy on a real HubServer in this process, next to the main (loopback) one,
    both over one store. Test only: in the hub the Tailscale policy only ever runs on its own Unix
    socket (TailscaleUnixServer, tested on Linux); a loopback port stands in for that socket here,
    so the request handling is covered on every platform."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        root = Path(self.tmp.name)
        self.port = free_port()
        settings = server.resolve_settings({"FITNESS_HUB_PORT": str(self.port), "FITNESS_HUB_DATA_DIR": str(root / "data")},
                                           build_file=root / "no-build-file")
        settings.data_dir.mkdir(parents=True)
        self.store = server.HubStore(settings.data_dir)
        self.main = server.build_server(settings, self.store, instance="test")
        self.ts_port = free_port()
        self.ts = server.HubServer(("127.0.0.1", self.ts_port), server.HubHandler, store=self.store,
                                   policy=server.TailscalePolicy(ts_settings(users=(TS_LOGIN, "alex@github"))),
                                   instance="test", timeouts=settings.timeouts)
        self.ts.listen_kind = self.ts.log_via = "tailscale"
        self.stream = io.StringIO()
        self.handler = logging.StreamHandler(self.stream)
        self.saved = (server.LOG.level, server.LOG.propagate)
        server.LOG.addHandler(self.handler)
        server.LOG.setLevel(logging.DEBUG)
        server.LOG.propagate = False
        self.threads = [threading.Thread(target=s.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
                        for s in (self.main, self.ts)]
        for t in self.threads:
            t.start()

    def tearDown(self):
        for s in (self.main, self.ts):
            s.shutdown()
            s.server_close()
        for t in self.threads:
            t.join(5)
        server.LOG.removeHandler(self.handler)
        server.LOG.setLevel(self.saved[0])
        server.LOG.propagate = self.saved[1]
        self.tmp.cleanup()

    def ts_req(self, method, path, body=None, headers=None, host="localhost"):
        return http_request(self.ts_port, method, path, body, headers, host)

    def write(self, etag=None, **extra):
        h = dict(SERVE_HEADERS, **WRITE, Origin=f"https://{TS_HOST}")
        if etag is not None:
            h["If-Match"] = etag
        h.update(extra)
        return h

    def test_identity_gate(self):
        status, h, body = self.ts_req("GET", "/api/health", headers=SERVE_HEADERS)
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["listen"], "tailscale")
        self.assertEqual(h.get("cache-control"), "no-store")
        self.assertEqual(h.get("content-security-policy"), CSP)
        self.assertEqual(self.ts_req("GET", "/", headers=SERVE_HEADERS)[0], 200)
        self.assertEqual(self.ts_req("GET", "/api/data", headers=SERVE_HEADERS, host=TS_HOST)[0], 200)
        cases = [("login_missing", without(SERVE_HEADERS, "Tailscale-User-Login"), "localhost"),
                 ("login_missing", dict(SERVE_HEADERS, **{"Tailscale-User-Login": ""}), "localhost"),
                 ("login_not_allowed", dict(SERVE_HEADERS, **{"Tailscale-User-Login": "someone@example.com"}), "localhost"),
                 ("proxy", dict(SERVE_HEADERS, Via="1.1 forged"), "localhost"),
                 ("proxy", dict(SERVE_HEADERS, **{"X-Real-IP": "100.64.0.1"}), "localhost"),
                 ("funnel", dict(SERVE_HEADERS, **{"Tailscale-Funnel-Request": "?1"}), "localhost"),
                 ("forwarded_host", dict(SERVE_HEADERS, **{"X-Forwarded-Host": "evil.example"}), "localhost"),
                 ("forwarded_host", without(SERVE_HEADERS, "X-Forwarded-Host"), "localhost"),
                 ("proto", dict(SERVE_HEADERS, **{"X-Forwarded-Proto": "http"}), "localhost"),
                 ("proto", without(SERVE_HEADERS, "X-Forwarded-Proto"), "localhost"),
                 ("host", SERVE_HEADERS, f"127.0.0.1:{self.ts_port}"),
                 ("host", SERVE_HEADERS, "evil.example")]
        for reason, headers, host in cases:
            for method, path in (("GET", "/api/data"), ("GET", "/"), ("HEAD", "/"), ("GET", "/api/health")):
                status, h, body = self.ts_req(method, path, headers=headers, host=host)
                self.assertEqual(status, 403, (reason, method, path))
                self.assertNotIn(b"schema_version", body)
                self.assertFalse(any(k.startswith("access-control-") for k in h))
                if method == "GET":
                    self.assertEqual(json.loads(body)["reason"], reason, (method, path))
        status, _, body = self.ts_req("GET", "/api/health", headers=dict(SERVE_HEADERS, **{"Tailscale-User-Login": "ALEX@GITHUB"}))
        self.assertEqual(status, 200, "every allowed login, compared ignoring case")
        # The main listener is unchanged: no Serve header, not even an allowed login, gets through it.
        self.assertEqual(http_request(self.port, "GET", "/api/health")[0], 200)
        for name, value in SERVE_HEADERS.items():
            status, _, body = http_request(self.port, "GET", "/api/health", headers={name: value})
            self.assertEqual(status, 403, name)
            self.assertNotIn(b"reason", body, "the main listener's refusals are as before")
        self.assertEqual(http_request(self.port, "GET", "/api/data", headers=SERVE_HEADERS, host="localhost")[0], 403)

    def test_writes_need_the_tailscale_origin(self):
        status, h, body = self.ts_req("GET", "/api/data", headers=SERVE_HEADERS)
        etag = h["etag"]
        doc = json.loads(body)
        doc["checkins"].append({"date": "2025-11-24", "notes": "from the phone"})
        payload = json.dumps(doc)
        refusals = [(403, without(self.write(etag), "Origin")), (403, self.write(etag, Origin=f"http://{TS_HOST}")),
                    (403, self.write(etag, Origin=f"https://{TS_HOST}:443")), (403, self.write(etag, Origin="https://evil.example")),
                    (403, self.write(etag, Origin="null")), (403, self.write(etag, Origin=f"http://127.0.0.1:{self.port}")),
                    (403, without(self.write(etag), "X-Fitness-Hub")), (403, self.write(etag, **{"Content-Type": "text/plain"})),
                    (403, self.write(etag, **{"Sec-Fetch-Site": "cross-site"})), (403, without(self.write(etag), "Tailscale-User-Login")),
                    (428, self.write()), (412, self.write('"' + "0" * 64 + '"'))]
        for expected, headers in refusals:
            status, _, body = self.ts_req("PUT", "/api/data", payload, headers)
            self.assertEqual(status, expected, (headers.get("Origin"), body))
        self.assertEqual(self.store.current_etag(), etag, "nothing was written")
        status, h, body = self.ts_req("PUT", "/api/data", payload, self.write(etag, **{"Sec-Fetch-Site": "same-origin"}))
        self.assertEqual(status, 200, body)
        status, mh, mbody = http_request(self.port, "GET", "/api/data")
        self.assertEqual((status, mh["etag"]), (200, h["etag"]), "the tunnel sees the save made through Tailscale")
        self.assertIn("from the phone", mbody.decode())
        status, _, body = http_request(self.port, "PUT", "/api/data", mbody, dict(WRITE, **{"If-Match": mh["etag"]},
                                                                                   Origin=f"https://{TS_HOST}"))
        self.assertEqual(status, 403, "the Tailscale origin can't write through the main listener")
        self.assertEqual(self.ts_req("POST", "/api/backup", "{}", self.write())[0], 200)
        self.assertEqual(self.ts_req("POST", "/api/backup", "{}", without(self.write(), "Origin"))[0], 403)

    def test_logs_name_the_allowed_login_but_never_bodies_or_values(self):
        _, h, _ = self.ts_req("GET", "/api/data", headers=SERVE_HEADERS)
        doc = dict(server.default_data(), marker="secret-body-marker-42")
        self.assertEqual(self.ts_req("PUT", "/api/data", json.dumps(doc), self.write(h["etag"]))[0], 200)
        self.ts_req("GET", "/api/data", headers=dict(SERVE_HEADERS, **{"Tailscale-User-Login": "intruder@example.net"}))
        self.ts_req("GET", "/api/data", headers=dict(SERVE_HEADERS, Via="1.1 sneaky-proxy-value"))
        self.assertEqual(http_request(self.port, "GET", "/api/main-listener-probe")[0], 404)
        time.sleep(0.2)
        log = self.stream.getvalue()
        main_lines = [line for line in log.splitlines() if "path=/api/main-listener-probe" in line]
        self.assertEqual(len(main_lines), 1, log)
        self.assertNotIn("via=", main_lines[0], "main listener lines are as before (no via=, no login=)")
        self.assertNotIn("login=", main_lines[0])
        self.assertIn(f"path=/api/data status=200", log)
        self.assertRegex(log, rf"event=http method=PUT path=/api/data status=200 .*via=tailscale login={re.escape(TS_LOGIN)}")
        self.assertIn("event=ts_refused reason=login_not_allowed path=/api/data", log)
        self.assertIn("event=ts_refused reason=proxy headers=via path=/api/data", log)
        for secret in ("secret-body-marker-42", "intruder@example.net", "sneaky-proxy-value", "100.101.102.103", "Alex"):
            self.assertNotIn(secret, log)


# ============================================================ pure helpers
class HelperTests(unittest.TestCase):
    def test_json_depth_scan(self):
        f = server.json_too_deep
        doc = b'{"a": [1, {"b": []}]}'
        self.assertFalse(f(doc, 4))
        self.assertTrue(f(doc, 3))
        self.assertFalse(f(b'{"a": "[[[[[[[[[[{{{{"}', 1), "brackets inside strings don't count")
        self.assertFalse(f(b'{"a": "\\"[[[[\\"", "b": [[]]}', 3), "escaped quotes stay inside the string")
        self.assertTrue(f(b'{"a": "\\"[[[[\\"", "b": [[]]}', 2))
        self.assertFalse(f(b'{"a": "\\\\", "b": [[[]]]}', 4), "an escaped backslash ends before the quote")
        self.assertTrue(f(b'{"a": "\\\\", "b": [[[]]]}', 3))
        at_limit = b"[" * 64 + b"]" * 64
        self.assertFalse(f(at_limit))
        node, depth = server.parse_json_document(at_limit), 0
        while isinstance(node, list) and node:
            node, depth = node[0], depth + 1
        self.assertEqual(depth, 63, "64 nested lists parse fine; the innermost is empty")
        hostile = (b"[" * 65 + b'"' + b'\\"' * 300_000,   # unterminated string full of escaped quotes
                   b"[" * 2_000_000,                      # sheer depth
                   b"[{" * 40 + b'"' * 400_001,           # a flood of quotes
                   b"[" * 65 + b"\\" * 600_001)            # a flood of backslashes
        for evil in hostile:
            started = time.perf_counter()
            self.assertTrue(f(evil))
            self.assertLess(time.perf_counter() - started, 3.0, "linear time on hostile input")
        with self.assertRaises(server.JsonTooDeep):
            server.parse_json_document(b"[" * 100 + b"]" * 100)

    def test_lone_surrogates(self):
        f = server.has_lone_surrogate
        for ok in (b'{"a": "plain"}', b'{"a": "\\ud83d\\ude00"}', b'{"a": "\\\\ud800"}', b'{"a": "\\u00e9 \\n"}',
                   b'{"a": "\\uD83D\\uDE00"}'):
            self.assertFalse(f(ok), ok)
        for bad in (b'{"a": "\\ud800"}', b'{"a": "\\ud800x"}', b'{"a": "\\udc00"}', b'["\\ud800", "\\udc00"]',
                    b'{"a": "\\ud83d\\ud83d\\ude00"}', b'{"a": "\\\\\\ud800"}'):
            self.assertTrue(f(bad), bad)
        started = time.perf_counter()
        self.assertFalse(f(b'{"a": "' + b"\\ud83d\\ude00" * 200_000 + b'"}'))
        self.assertLess(time.perf_counter() - started, 3.0)

    def test_accept_encoding(self):
        f = server.accepts_gzip
        for yes in ("gzip", "gzip, deflate, br", "br;q=1.0, gzip;q=0.8", "*", "x-gzip", "GZIP", "deflate, *;q=0.1"):
            self.assertTrue(f(yes), yes)
        for no in ("", "identity", "br", "gzip;q=0", "gzip;q=0.0, *", "*;q=0", "gzip;q=abc", "deflate"):
            self.assertFalse(f(no), no)

    def test_shape_and_shrinkage(self):
        before = server.array_shape({"a": list(range(100)), "b": list(range(3)), "o": {"c": list(range(10))},
                                     "w": [{"inner": [1, 2, 3]}, {"inner": [4]}, [5, 6]]})
        self.assertEqual(before, {("a",): 100, ("b",): 3, ("o", "c"): 10, ("w",): 3, ("w", None, "inner"): 4,
                                  ("w", None): 2}, "lists inside a list's records are added up per path")
        self.assertEqual(server.shrinkage(before, {**before, ("w", None, "inner"): 0}), (1, 4),
                         "emptying the inner lists is a shrink, though no record of w went")
        self.assertEqual(server.shrinkage(before, {**before, ("a",): 95}), (0, 0), "5 of 100: not more than 5, 5%")
        self.assertEqual(server.shrinkage(before, {**before, ("a",): 94}), (1, 6), "6 records")
        self.assertEqual(server.shrinkage(before, {**before, ("o", "c"): 8}), (1, 2), "20%")
        self.assertEqual(server.shrinkage(before, {**before, ("o", "c"): 9}), (0, 0), "exactly 10% is allowed")
        self.assertEqual(server.shrinkage(before, {k: v for k, v in before.items() if k != ("b",)}), (1, 3), "gone = emptied")
        self.assertEqual(server.shrinkage({}, before), (0, 0))
        deep = {"x": {}}
        node = deep["x"]
        for _ in range(20):
            node["y"] = {}
            node = node["y"]
        node["z"] = [1]
        self.assertFalse(any(len(p) > server.MAX_SHAPE_DEPTH + 1 for p in server.array_shape(deep)))
        data = server.default_data()
        data["arm"]["appointments"] = [{"date": "2026-12-08", "type": "Fracture clinic"}]
        data["workouts"] = [{"exercises": [{"sets": [{}, {}]}], "cardio": []}]
        data["checkins"] = [{"arm_flags": ["pain_increasing"]}]
        shape = server.array_shape(data)
        for path, count in ((("workouts",), 1), (("workouts", None, "exercises"), 1),
                            (("workouts", None, "exercises", None, "sets"), 2), (("workouts", None, "cardio"), 0),
                            (("checkins", None, "arm_flags"), 1), (("arm", "logs"), 0), (("arm", "appointments"), 1)):
            self.assertEqual(shape.get(path), count, path)
        with mock.patch.object(server, "MAX_SHAPE_NODES", 10):
            big = server.array_shape({"x": [[1]] * 50})
        self.assertIn(server.SHAPE_TRUNCATED, big)
        self.assertEqual(server.shrinkage(big, big), (1, 0), "a document too big to walk always gets its copy")
        started = time.perf_counter()
        wide = server.array_shape({"x": [[]] * 1_000_000, "y": [{"z": [1]}] * 200_000})
        self.assertLess(time.perf_counter() - started, 5.0, "linear time, bounded memory")
        self.assertEqual((wide[("x",)], wide[("x", None)], wide[("y", None, "z")]), (1_000_000, 0, 200_000))

    def test_parse_etag_list(self):
        p = server.parse_etag_list
        self.assertEqual(p('"abc"'), [(False, '"abc"')])
        self.assertEqual(p('W/"abc"'), [(True, '"abc"')])
        self.assertEqual(p(' "a", W/"b" ,"c" '), [(False, '"a"'), (True, '"b"'), (False, '"c"')])
        self.assertEqual(p("*"), [(False, "*")])
        for bad in ("abc", '"abc', '"a" "b"', "", "W/abc", '"a";"b"'):
            self.assertIsNone(p(bad), bad)

    def test_settings(self):
        s = server.resolve_settings({})
        self.assertEqual((s.bind_host, s.url_host, s.port), ("127.0.0.1", "127.0.0.1", 8642))
        self.assertIsNone(s.socket_path)
        self.assertFalse(s.under_systemd)
        self.assertEqual(s.listen, "127.0.0.1:8642")
        self.assertEqual(s.data_dir, REAL_DATA_DIR)  # computed only, never created here
        self.assertEqual(s.timeouts, server.Timeouts())
        s = server.resolve_settings({"FITNESS_HUB_HOST": "localhost", "FITNESS_HUB_TIMEOUT_SCALE": "0.1"})
        self.assertEqual((s.bind_host, s.url_host), ("127.0.0.1", "localhost"))
        self.assertAlmostEqual(s.timeouts.header, server.HEADER_TIMEOUT * 0.1)
        self.assertEqual(server.resolve_settings({"FITNESS_HUB_HOST": "::1"}).bind_host, "::1")
        self.assertTrue(server.resolve_settings({"INVOCATION_ID": "x"}).under_systemd)
        for env in ({"FITNESS_HUB_HOST": "0.0.0.0"}, {"FITNESS_HUB_HOST": "::"}, {"FITNESS_HUB_PORT": "-1"},
                    {"FITNESS_HUB_TIMEOUT_SCALE": "0"}, {"FITNESS_HUB_TIMEOUT_SCALE": "x"},
                    {"FITNESS_HUB_DATA_DIR": str(HUB / "public" / "x")}, {"FITNESS_HUB_DATA_DIR": str(HUB.parent)},
                    {"FITNESS_HUB_EXTRA_HOSTS": "hub.x.ts.net"}):
            with self.assertRaises(server.ConfigError, msg=env):
                server.resolve_settings(env)

    @unittest.skipUnless(server.HAS_UNIX_SOCKETS, "needs AF_UNIX")
    def test_socket_settings(self):
        s = server.resolve_settings({"FITNESS_HUB_SOCKET": "/run/user/1000/fitness-hub/hub.sock"})
        self.assertEqual((s.bind_host, s.url_host, s.port), (None, "127.0.0.1", 8642))
        self.assertEqual(s.listen, "unix:/run/user/1000/fitness-hub/hub.sock")
        self.assertEqual(s.url, "http://127.0.0.1:8642/")
        for env in ({"FITNESS_HUB_SOCKET": "hub.sock"}, {"FITNESS_HUB_SOCKET": "/a/../b.sock"},
                    {"FITNESS_HUB_SOCKET": "/" + "x" * 200}, {"FITNESS_HUB_SOCKET": "/s.sock", "FITNESS_HUB_HOST": "127.0.0.1"}):
            with self.assertRaises(server.ConfigError, msg=env):
                server.resolve_settings(env)

    def test_build_file(self):
        with tempfile.TemporaryDirectory() as t:
            path = Path(t) / "BUILD_ID"
            self.assertEqual(server.read_build(path), "dev")
            path.write_text(" 0123456789abcdef \n", encoding="ascii")
            self.assertEqual(server.read_build(path), "0123456789abcdef")
            for bad in ("", "a b", "x" * 65, "\u00e9t\u00e9"):
                path.write_text(bad, encoding="utf-8")
                with self.assertRaises(server.ConfigError, msg=bad):
                    server.read_build(path)

    def test_access_policy(self):
        policy = server.AccessPolicy.for_settings(server.resolve_settings({}))
        self.assertEqual(policy.hosts, {"127.0.0.1:8642", "localhost:8642"})
        loopback = policy.authority_for("127.0.0.1:8642")
        self.assertEqual(loopback.name, "loopback")
        self.assertEqual(loopback.origins, {"http://127.0.0.1:8642", "http://localhost:8642"})
        self.assertIsNone(policy.authority_for("localhost"), "Tailscale Serve's Host for a unix: target is refused")
        self.assertIsNone(policy.authority_for("hub.example-tailnet.ts.net"))
        self.assertIn("[::1]:8642", server.AccessPolicy.for_settings(server.resolve_settings({"FITNESS_HUB_HOST": "::1"})).hosts)
        self.assertEqual(loopback.proxy_violations(["Host", "Accept", "X-Fitness-Hub", "Sec-Fetch-Site", "Viable"]), [])
        found = loopback.proxy_violations(["Via", "X-Forwarded-For", "forwarded", "X-Real-IP", "Tailscale-User-Login",
                                           "x-forwarded-anything"])
        self.assertEqual(len(found), 5, "reported names are capped")
        self.assertIn("via", found)
        relaxed = server.Authority("example", frozenset(), frozenset(), frozenset({"x-forwarded-for"}))
        self.assertEqual(relaxed.proxy_violations(["X-Forwarded-For", "Via"]), ["via"],
                         "an authority can allow exactly the headers its proxy adds")

    def test_ensure_loopback(self):
        class FakeSocket:
            def __init__(self, addr):
                self.addr = addr

            def getsockname(self):
                return (self.addr, 1234)

        for ok in ("127.0.0.1", "::1"):
            server.ensure_loopback(FakeSocket(ok))
        for bad in ("0.0.0.0", "::", "192.168.1.5", "fe80::1%eth0", "localhost"):
            with self.assertRaises(server.NonLoopbackBind, msg=bad):
                server.ensure_loopback(FakeSocket(bad))

    def test_socket_folder_rules(self):
        """check_socket_folder with fake stat results, so the rules are tested on every platform."""
        def fake(mode, uid=1000):
            return os.stat_result((mode, 1, 1, 1, uid, uid, 0, 0, 0, 0))

        cases = [(stat.S_IFDIR | 0o700, stat.S_IFDIR | 0o700, 1000, None),
                 (stat.S_IFDIR | 0o750, stat.S_IFDIR | 0o700, 1000, "other users"),
                 (stat.S_IFDIR | 0o707, stat.S_IFDIR | 0o700, 1000, "other users"),
                 (stat.S_IFDIR | 0o700, stat.S_IFDIR | 0o700, 1001, "another user"),
                 (stat.S_IFLNK | 0o777, stat.S_IFDIR | 0o700, 1000, "plain folder"),
                 (stat.S_IFREG | 0o600, stat.S_IFDIR | 0o700, 1000, "plain folder"),
                 (stat.S_IFDIR | 0o700, stat.S_IFDIR | 0o777, 1000, "swap"),
                 (stat.S_IFDIR | 0o700, stat.S_IFDIR | 0o1777, 1000, None)]  # sticky /tmp-like parent is fine
        for folder_mode, parent_mode, owner, problem in cases:
            with mock.patch.object(server.os, "lstat", return_value=fake(folder_mode, owner)), \
                 mock.patch.object(server.os, "stat", return_value=fake(parent_mode, 0)), \
                 mock.patch.object(server.os, "geteuid", create=True, return_value=1000):
                if problem is None:
                    server.check_socket_folder(Path("/run/user/1000/fitness-hub"), create=False)
                else:
                    with self.assertRaisesRegex(server.UnsafeSocket, problem):
                        server.check_socket_folder(Path("/run/user/1000/fitness-hub"), create=False)

    def test_atomic_write_fsyncs_file_and_folder(self):
        calls = []
        real_fsync = os.fsync

        def spy(fd):
            calls.append(fd)
            return real_fsync(fd)

        with tempfile.TemporaryDirectory() as t, mock.patch.object(server.os, "fsync", spy):
            target = Path(t) / "sub" / "x.json"
            server.atomic_write(target, b'{"a": 1}')
            self.assertEqual(target.read_bytes(), b'{"a": 1}')
            self.assertFalse(list(target.parent.glob(".tmp-*")))
        self.assertGreaterEqual(len(calls), 1 if os.name == "nt" else 2, "file fsync, plus the folder on POSIX")

    def test_atomic_write_fails_fast_and_never_spins(self):
        """Windows' mkstemp retries 2**31 names while a PermissionError lasts (Controlled Folder
        Access), with the write lock held. The hub's own temp file creation raises it at once."""
        with tempfile.TemporaryDirectory() as t:
            target = Path(t) / "x.json"
            tried = []

            def refuse(error):
                def fake_open(path, *args, **kwargs):
                    tried.append(str(path))
                    raise error(errno.EACCES if error is PermissionError else errno.EEXIST, "refused", str(path))
                return fake_open

            with mock.patch.object(server.os, "open", refuse(PermissionError)):
                started = time.monotonic()
                with self.assertRaises(PermissionError):
                    server.atomic_write(target, b"{}")
            self.assertLess(time.monotonic() - started, 1.0)
            self.assertEqual(len(tried), 1, "a PermissionError is never retried")
            tried.clear()
            with mock.patch.object(server.os, "open", refuse(FileExistsError)):
                with self.assertRaises(FileExistsError):
                    server.atomic_write(target, b"{}")
            self.assertEqual(len(tried), server.TEMP_NAME_TRIES, "a name clash is retried, a bounded number of times")
            self.assertEqual(len(set(tried)), server.TEMP_NAME_TRIES, "with a new random name each time")
            self.assertTrue(all(server.TEMP_RE.match(Path(name).name) for name in tried), "startup cleanup finds them")
            self.assertFalse(target.exists())
            with mock.patch.object(tempfile, "mkstemp", side_effect=AssertionError("mkstemp must not be used")):
                server.atomic_write(target, b"line 1\nline 2\n")
            self.assertEqual(target.read_bytes(), b"line 1\nline 2\n", "binary: no newline translation on Windows")
            if POSIX_PERMS:
                self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o600)

    def test_backup_order_is_the_date_in_the_name_then_the_mtime(self):
        names = ["auto-2026-11-21-120000-2.json", "auto-2026-11-21-120000.json", "auto-2026-11-20-235959.json",
                 "auto-2026-11-21-115959.json"]
        ordered = sorted(names, key=lambda name: server.backup_order(name, 0))
        self.assertEqual(ordered, ["auto-2026-11-20-235959.json", "auto-2026-11-21-115959.json",
                                   "auto-2026-11-21-120000.json", "auto-2026-11-21-120000-2.json"])
        self.assertLess(server.backup_order("data-2026-11-20.json", 9), server.backup_order("data-2026-11-21.json", 1),
                        "the name's date wins over the mtime")
        self.assertLess(server.backup_order("odd.json", 1), server.backup_order("odd2.json", 2), "the mtime breaks ties")

    def test_store_save_semantics(self):
        with tempfile.TemporaryDirectory() as t:
            store = server.HubStore(Path(t))
            raw = store.read()
            self.assertEqual(raw, server.dump_json(server.default_data()), "the default document is stored compact")
            tag = server.strong_etag(raw)
            self.assertEqual(store.save(b'{"schema_version": 1}', ['"nope"']), server.SaveResult("conflict", tag))
            self.assertEqual(store.save(raw, [tag]).status, "unchanged")
            new = b'{"schema_version": 1, "x": 1}'
            result = store.save(new, [tag])
            self.assertEqual((result.status, result.etag, result.size), ("saved", server.strong_etag(new), len(new)))
            self.assertIsNone(result.auto_backup, "every list in the default document is empty: nothing to copy")
            one = b'{"schema_version": 1, "arm": {"appointments": [{"date": "2026-12-08"}]}}'
            result = store.save(one, [result.etag])
            self.assertEqual((result.status, result.auto_backup), ("saved", None))
            result = store.save(new, [result.etag])
            self.assertEqual(result.status, "saved")
            self.assertIsNotNone(result.auto_backup, "the one appointment disappeared: copied first")
            self.assertEqual(store.data_file.read_bytes(), new)
            store.data_file.write_bytes(b"{ broken")
            result = store.save(b'{"schema_version": 1}', [server.strong_etag(b"{ broken")])
            self.assertEqual(result.status, "damaged")
            self.assertEqual(store.data_file.read_bytes(), b"{ broken")

    def test_store_reads_only_when_the_file_changed(self):
        with tempfile.TemporaryDirectory() as t:
            store = server.HubStore(Path(t))
            first = store.current_etag()
            real = Path.read_bytes
            reads = []

            def counting(path):
                reads.append(path)
                return real(path)

            with mock.patch.object(Path, "read_bytes", counting):
                for _ in range(5):
                    self.assertEqual(store.current_etag(), first)
                self.assertEqual(reads, [], "the ETag is cached by the file's stat")
            outside = b'{"schema_version": 1, "changed": "outside the hub"}'
            store.data_file.write_bytes(outside)
            os.utime(store.data_file, ns=(time.time_ns(), time.time_ns() + 5_000_000_000))
            self.assertEqual(store.current_etag(), server.strong_etag(outside), "an outside change is picked up")

    def test_manual_backups_are_rate_limited_and_deduplicated(self):
        now = [1000.0]
        with tempfile.TemporaryDirectory() as t:
            store = server.HubStore(Path(t), clock=lambda: now[0])
            tag = store.current_etag()
            first, reused = store.manual_backup()
            self.assertFalse(reused)
            self.assertEqual(store.manual_backup(), (first, True), "same data: the same file")
            for i in range(server.BACKUP_WINDOW_MAX - 1):
                payload = json.dumps({"schema_version": 1, "i": i}).encode()
                tag = store.save(payload, [tag], shape={}).etag
                now[0] += 1
                store.manual_backup()
            tag = store.save(b'{"schema_version": 1, "i": "last"}', [tag], shape={}).etag
            with self.assertRaises(server.BackupRateLimited) as caught:
                store.manual_backup()
            self.assertEqual(caught.exception.retry_after, int(server.BACKUP_WINDOW_S) - (server.BACKUP_WINDOW_MAX - 1))
            now[0] += server.BACKUP_WINDOW_S
            self.assertFalse(store.manual_backup()[1], "the window moves on")

    def test_prune_keeps_the_newest_names_whatever_the_mtimes(self):
        with tempfile.TemporaryDirectory() as t:
            folder = Path(t)
            future = time.time() + 5 * 365 * 86400
            for i in range(70):  # names ascending, mtimes descending and years in the future
                p = folder / f"data-2026-{1 + i // 28:02d}-{1 + i % 28:02d}.json"
                p.write_text("{}")
                os.utime(p, (future - i, future - i))
            (folder / "manual-2026-01-01-000000.json").write_text("{}")
            self.assertEqual(server.prune(folder, server.DAILY_RE, 60), 10)
            daily = sorted(p.name for p in folder.glob("data-*.json"))
            self.assertEqual(len(daily), 60)
            self.assertNotIn("data-2026-01-10.json", daily, "the oldest names go, however new their mtimes look")
            self.assertIn("data-2026-01-11.json", daily)
            self.assertIn("data-2026-03-14.json", daily, "the newest name is kept")
            self.assertTrue((folder / "manual-2026-01-01-000000.json").exists(), "only the pattern is pruned")
            for i in range(60):  # files that sort newer than anything written today
                p = folder / f"manual-2099-01-{1 + i % 28:02d}-{i:06d}.json"
                p.write_text("{}")
                os.utime(p, (future, future))
            just_written = folder / "manual-2026-11-21-120000.json"
            just_written.write_text("{}")
            self.assertEqual(server.prune(folder, server.MANUAL_RE, 60, protect={just_written.name}), 1)
            self.assertTrue(just_written.exists(), "the file just written is never pruned")
            self.assertFalse((folder / "manual-2026-01-01-000000.json").exists())

    def test_store_never_prunes_todays_copy_or_the_file_it_just_wrote(self):
        with tempfile.TemporaryDirectory() as t:
            store = server.HubStore(Path(t))
            tag = store.current_etag()
            store.backup_dir.mkdir()
            future = time.time() + 5 * 365 * 86400
            for prefix, name in [("data", f"data-2099-{1 + i // 28:02d}-{1 + i % 28:02d}.json") for i in range(70)] + \
                                [("manual", f"manual-2099-02-{1 + i % 28:02d}-{i:06d}.json") for i in range(70)]:
                p = store.backup_dir / name
                p.write_text("{}")
                os.utime(p, (future, future))
            result = store.save(b'{"schema_version": 1, "x": 1}', [tag], shape={})
            self.assertEqual(result.status, "saved")
            today = store.backup_dir / f"data-{time.strftime('%Y-%m-%d')}.json"
            self.assertTrue(today.exists(), "today's copy survives 70 newer-looking daily files")
            self.assertEqual(len(list(store.backup_dir.glob("data-*.json"))), server.DAILY_BACKUPS_KEPT + 1)
            dest, reused = store.manual_backup()
            self.assertFalse(reused)
            self.assertTrue(dest.exists(), "and so does the manual backup it just wrote")

    def test_log_values_are_escaped(self):
        self.assertEqual(server._log_value("/api/data"), "/api/data")
        self.assertEqual(server._log_value("a b"), '"a b"')
        escaped = server._log_value("x\n\x1b[31mINFO event=fake\u202e")
        self.assertNotIn("\n", escaped)
        self.assertNotIn("\x1b", escaped)
        self.assertTrue(escaped.isascii())


# ================================================== Tailscale mode, pure
class TailscalePolicyTests(unittest.TestCase):
    """TailscalePolicy.admit() on header sets as Serve would send them. Pure: runs everywhere."""

    def setUp(self):
        self.policy = server.TailscalePolicy(ts_settings(users=(TS_LOGIN, "alex@github")))

    def admit(self, pairs):
        return self.policy.admit(header_set(*pairs))

    def refused(self, pairs, reason):
        verdict = self.admit(pairs)
        self.assertFalse(verdict.allowed, pairs)
        self.assertEqual(verdict.reason, reason, pairs)
        self.assertIsNone(verdict.login)
        self.assertEqual(verdict.fields["reason"], reason)
        return verdict

    def test_a_request_from_an_allowed_login_through_serve_is_admitted(self):
        verdict = self.admit(serve_pairs())
        self.assertTrue(verdict.allowed)
        self.assertEqual(verdict.login, TS_LOGIN)
        self.assertEqual(verdict.authority.name, "tailscale")
        self.assertTrue(verdict.authority.origin_required)
        self.assertEqual(verdict.authority.origins, {f"https://{TS_HOST}"})
        minimal = [("Host", "localhost"), ("X-Forwarded-Host", TS_HOST), ("X-Forwarded-Proto", "https"),
                   ("Tailscale-User-Login", TS_LOGIN)]
        self.assertTrue(self.admit(minimal).allowed, "X-Forwarded-For and the other identity headers are optional")
        self.refused([pair for pair in minimal if pair[0] != "X-Forwarded-Proto"], "proto")
        self.assertTrue(self.admit(serve_pairs(host=TS_HOST)).allowed, "Host may also be the Tailscale name itself")
        self.assertTrue(self.admit(serve_pairs(host="LOCALHOST")).allowed)

    def test_login_missing_empty_wrong_or_repeated_is_refused(self):
        self.refused(serve_pairs(drop=("Tailscale-User-Login",)), "login_missing")
        for empty in ("", "   "):
            self.refused(serve_pairs(tailscale_user_login=empty), "login_missing")
        for wrong in ("someone@example.com", "alex@example.co", "xalex@example.com", "alex@example.com.evil.net",
                      "alex", "@example.com", "example.com", "*", "*@example.com", f"{TS_LOGIN}, someone@example.com",
                      f"{TS_LOGIN} x", "=?utf-8?q?alex=40example.com?=", "alex@github.evil"):
            self.refused(serve_pairs(tailscale_user_login=wrong), "login_not_allowed")
        self.refused(serve_pairs(add=(("Tailscale-User-Login", "someone@example.com"),)), "repeated")
        self.refused(serve_pairs(add=(("Tailscale-User-Login", TS_LOGIN),)), "repeated")

    def test_login_compare_ignores_case_and_covers_every_listed_user(self):
        for ok, login in (("ALEX@Example.COM", TS_LOGIN), (f"  {TS_LOGIN}  ", TS_LOGIN), ("alex@github", "alex@github"),
                          ("Alex@GitHub", "alex@github")):
            verdict = self.admit(serve_pairs(tailscale_user_login=ok))
            self.assertTrue(verdict.allowed, ok)
            self.assertEqual(verdict.login, login)
        one = server.TailscalePolicy(ts_settings(users=(TS_LOGIN,)))
        self.assertFalse(one.admit(header_set(*serve_pairs(tailscale_user_login="alex@github"))).allowed,
                         "only the logins in this listener's own list")

    def test_only_the_exact_tailscale_name_over_https(self):
        self.refused(serve_pairs(drop=("X-Forwarded-Host",)), "forwarded_host")
        for forged in ("evil.example", f"{TS_HOST}:443", f"{TS_HOST}.", "other.tail1234.ts.net", "100.101.102.103",
                       f"evil.example, {TS_HOST}", "localhost", "", f"x{TS_HOST}"):
            self.refused(serve_pairs(x_forwarded_host=forged), "forwarded_host")
        self.assertTrue(self.admit(serve_pairs(x_forwarded_host=TS_HOST.upper())).allowed, "DNS names ignore case")
        self.refused(serve_pairs(add=(("X-Forwarded-Host", TS_HOST),)), "repeated")
        for host in ("127.0.0.1:8642", "localhost:8642", "localhost:80", "evil.example", "100.101.102.103", "", f"{TS_HOST}:443"):
            self.refused(serve_pairs(host=host), "host")
        self.refused(serve_pairs(drop=("Host",)), "host")
        self.refused(serve_pairs(add=(("Host", "localhost"),)), "host")
        for proto in ("http", "", "   ", "https, http", "wss"):
            self.refused(serve_pairs(x_forwarded_proto=proto), "proto")
        self.refused(serve_pairs(drop=("X-Forwarded-Proto",)), "proto")  # Serve always sends it for HTTPS
        self.refused(serve_pairs(add=(("X-Forwarded-Proto", "https"),)), "repeated")
        self.assertTrue(self.admit(serve_pairs(x_forwarded_proto=" HTTPS ")).allowed)

    def test_headers_serve_never_adds_are_refused(self):
        for name in ("Via", "Forwarded", "X-Real-IP", "X-Forwarded-Port", "X-Forwarded-Server", "True-Client-IP",
                     "CF-Connecting-IP", "X-Original-Forwarded-For", "Tailscale-App-Capabilities", "Tailscale-User-Extra",
                     "tailscale-anything"):
            verdict = self.refused(serve_pairs(add=((name, "x"),)), "proxy")
            self.assertEqual(verdict.proxy_headers, (name.lower(),))
            self.assertEqual(verdict.fields["proxy_headers"], [name.lower()])
        self.refused(serve_pairs(add=(("Tailscale-Funnel-Request", "?1"),)), "funnel")
        self.refused([("Host", "localhost"), ("Tailscale-Funnel-Request", "?1")], "funnel")
        for name in ("X-Forwarded-For", "Tailscale-User-Name", "Tailscale-User-Profile-Pic", "Tailscale-Headers-Info"):
            self.refused(serve_pairs(add=((name, "x"),)), "repeated")
        ordinary = (("X-Requested-With", "x"), ("Viaduct", "y"), ("Accept", "*/*"), ("Sec-Fetch-Site", "same-origin"))
        self.assertTrue(self.admit(serve_pairs(add=ordinary)).allowed, "ordinary headers with similar names are fine")

    def test_writes_need_exactly_the_tailscale_origin(self):
        authority = self.admit(serve_pairs()).authority
        self.assertTrue(authority.origin_ok([f"https://{TS_HOST}"]))
        self.assertTrue(authority.origin_ok([f"HTTPS://{TS_HOST.upper()} "]))
        for bad in ([], [""], ["null"], [f"http://{TS_HOST}"], [f"https://{TS_HOST}:443"], ["https://evil.example"],
                    [f"https://{TS_HOST}.evil.example"], ["http://127.0.0.1:8642"], [f"https://{TS_HOST}/"],
                    [f"https://{TS_HOST}", f"https://{TS_HOST}"]):
            self.assertFalse(authority.origin_ok(bad), bad)
        loopback = server.AccessPolicy.for_settings(server.resolve_settings({})).authority_for("127.0.0.1:8642")
        self.assertFalse(loopback.origin_required)
        self.assertTrue(loopback.origin_ok([]), "the main listener keeps its rule: an Origin, if sent, must match")
        self.assertTrue(loopback.origin_ok(["http://127.0.0.1:8642"]))
        self.assertFalse(loopback.origin_ok([f"https://{TS_HOST}"]))

    def test_there_is_never_an_allow_all(self):
        for users in ((), ("",), (" ",)):
            with self.assertRaises(ValueError, msg=users):
                server.TailscalePolicy(ts_settings(users=users))
        with self.assertRaises(TypeError):
            server.TailscaleUnixServer("/nonexistent/ts.sock", server.HubHandler, policy=server.AccessPolicy([]),
                                       tunnel_port=1, store=None)

    def test_the_main_listener_still_refuses_every_serve_header(self):
        policy = server.AccessPolicy.for_settings(server.resolve_settings({}))
        self.assertEqual(policy.name, "loopback")
        self.assertTrue(policy.admit(header_set(("Host", "127.0.0.1:8642"))).allowed)
        for name, value in SERVE_HEADERS.items():
            verdict = policy.admit(header_set(("Host", "127.0.0.1:8642"), (name, value)))
            self.assertEqual((verdict.allowed, verdict.reason), (False, "proxy"), name)
            self.assertEqual(verdict.fields, {"proxy_headers": [name.lower()]}, "the same 403 body as before")
        self.assertEqual(policy.admit(header_set(*serve_pairs())).reason, "host")
        self.assertEqual(policy.admit(header_set(*serve_pairs(host=TS_HOST))).reason, "host")


class TailscaleSettingsTests(unittest.TestCase):
    """resolve_tailscale(): all three settings or none, each exact, Linux socket mode only. Anything
    else refuses to start. Pure (the platform is passed in), so it runs everywhere."""

    def resolve(self, env, main=TS_MAIN_SOCKET, platform="linux", has_unix=True):
        return server.resolve_tailscale(env, main, platform=platform, has_unix=has_unix)

    def refused(self, env, pattern, **kw):
        with self.assertRaisesRegex(server.ConfigError, pattern, msg=env):
            self.resolve(env, **kw)

    def test_off_unless_all_three_are_set(self):
        self.assertIsNone(self.resolve({}))
        self.assertIsNone(self.resolve({name: "  " for name in server.TS_VARS}), "blank values mean off")
        self.assertIsNone(server.resolve_settings({}).tailscale)
        for missing in server.TS_VARS:
            self.refused(without(TS_ENV, missing), f"{missing} is not set")
        self.refused({"FITNESS_HUB_TS_HOST": TS_HOST}, "FITNESS_HUB_TS_SOCKET and FITNESS_HUB_TS_USERS are not set")
        with self.assertRaises(server.ConfigError):
            server.resolve_settings(TS_ENV)  # without FITNESS_HUB_SOCKET (and, off Linux, at all)

    def test_valid_settings_are_normalised(self):
        ts = self.resolve(dict(TS_ENV, FITNESS_HUB_TS_HOST=" HomeServer.Tail1234.TS.NET ",
                               FITNESS_HUB_TS_USERS=" Alex@Example.com,alex@github ,alex@example.com"))
        self.assertEqual(ts.socket_path, TS_MAIN_SOCKET.parent / "ts.sock")
        self.assertEqual(ts.host, TS_HOST)
        self.assertEqual(ts.users, (TS_LOGIN, "alex@github"), "lower-cased, de-duplicated, in order")
        self.assertEqual(ts.origin, f"https://{TS_HOST}")
        self.assertEqual(self.resolve(dict(TS_ENV, FITNESS_HUB_TS_USERS="alex@passkey")).users, ("alex@passkey",))

    def test_host_must_be_this_servers_exact_ts_net_name(self):
        for host, why in (("homeserver.example.com", "must end in .ts.net"), ("homeserver.ts.net.evil.com", "must end in"),
                          ("ts.net", "must end in"), (f"{TS_HOST}.", "must end in"), ("tail1234.ts.net", "isn't a valid"),
                          ("*.tail1234.ts.net", "no wildcards"), ("homeserver.*.ts.net", "no wildcards"),
                          (f"{TS_HOST}:443", "must not include a port"), (f"{TS_HOST}:8443", "must not include a port"),
                          (f"https://{TS_HOST}", "without https://"), (f"{TS_HOST}/", "or a path"),
                          ("home_server.tail1234.ts.net", "isn't a valid"), ("-home.tail1234.ts.net", "isn't a valid"),
                          ("home..tail1234.ts.net", "isn't a valid"), ("a" * 64 + ".tail1234.ts.net", "isn't a valid"),
                          ("home server.tail1234.ts.net", "isn't a valid"), ("<machine>.<tailnet>.ts.net", "placeholder")):
            self.refused(dict(TS_ENV, FITNESS_HUB_TS_HOST=host), why)

    def test_users_must_be_exact_logins(self):
        for users, why in (("", "FITNESS_HUB_TS_USERS is not set"), (" , ", "empty entry"), (f"{TS_LOGIN},", "empty entry"),
                           (f"{TS_LOGIN},,x@y.z", "empty entry"), ("*", "no wildcards"), ("*@example.com", "no wildcards"),
                           ("alex@*", "no wildcards"), ("al?x@example.com", "no wildcards"),
                           ("@example.com", "isn't a Tailscale login"), ("example.com", "isn't a Tailscale login"),
                           ("alex", "isn't a Tailscale login"), ("alex @example.com", "isn't a Tailscale login"),
                           ("alex@example.com@x", "isn't a Tailscale login"), ("\u00e4lex@example.com", "isn't a Tailscale login"),
                           (f"{TS_LOGIN};x@y.z", "isn't a Tailscale login"), ("<your-tailscale-login>", "placeholder")):
            self.refused(dict(TS_ENV, FITNESS_HUB_TS_USERS=users), why)

    def test_socket_must_be_its_own_and_next_to_the_main_socket(self):
        for sock, why in (("ts.sock", "absolute path"), ("relative/ts.sock", "absolute path"),
                          ("/run/user/1000/fitness-hub/../ts.sock", "absolute path"), ("/run/user/1000/ts.sock", "private socket folder"),
                          ("/tmp/ts.sock", "private socket folder"), ("/run/user/1000/fitness-hub/hub.sock", "of its own"),
                          ("/run/user/1000/fitness-hub/" + "x" * 120, "longer than")):
            self.refused(dict(TS_ENV, FITNESS_HUB_TS_SOCKET=sock), why)

    def test_linux_socket_mode_only(self):
        for platform in ("win32", "darwin", "freebsd14"):
            self.refused(TS_ENV, "Linux home server only", platform=platform)
        self.refused(TS_ENV, "Linux home server only", has_unix=False)
        self.refused(TS_ENV, "set FITNESS_HUB_SOCKET too", main=None)
        self.assertIsNotNone(self.resolve(TS_ENV, platform="linux"))

    @unittest.skipUnless(LINUX_SOCKETS, "Tailscale mode needs Linux")
    def test_resolve_settings_on_linux(self):
        s = server.resolve_settings(dict(TS_ENV, FITNESS_HUB_SOCKET=str(TS_MAIN_SOCKET)))
        self.assertEqual(s.tailscale.socket_path, TS_MAIN_SOCKET.parent / "ts.sock")
        self.assertEqual(s.listen, f"unix:{TS_MAIN_SOCKET}", "the main listener is unchanged")


# ======================================================= import crawler
def load_module(name: str, path: Path):
    """Import a deploy/ script by path (it isn't a package). Registered first: dataclasses need it."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


class ImportCrawlerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ci = load_module("check_imports", HUB / "deploy" / "check_imports.py")

    def tree(self, files: dict) -> Path:
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(tmp.cleanup)
        public = Path(tmp.name) / "public"
        for rel, text in files.items():
            path = public / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        return public

    def problems(self, files: dict) -> list[str]:
        return self.ci.check(self.tree(files))[0]

    GOOD = {
        "index.html": '<script src="js/theme.js"></script>\n<script type="module" src="js/app.js"></script>',
        "js/theme.js": "document.documentElement.dataset.theme = 'light';\n",
        "js/app.js": (
            "// import nope from './nope.js'\n"
            "/* export { ghost } from './ghost.js' */\n"
            "import def, { a, b as bee } from './lib/a.js';\n"
            "import * as ns from './lib/ns.js';\n"
            "import './lib/side.js';\n"
            "import data from '../content/data.json' with { type: 'json' };\n"
            "import { y } from './lib/re.js';\n"
            "export { a as alsoA } from './lib/a.js';\n"
            "const s = \"import x from './nope2.js'\";\n"
            "const re = /\"import\"/g, half = 4 / 2;\n"
            "const t = `${import('./lib/lazy.js')} and ${ {k: 1}.k } import('./nope3.js')`;\n"
            "const o = { import: 1, export: 2 }; o.import = o.export;\n"
            "export default function main() { return import('./views/v.js'); }\n"
        ),
        "lib/x": "",
        "js/lib/a.js": "export default 1;\nexport const a = 1, b = 2;\n",
        "js/lib/ns.js": "export function anything() {}\n",
        "js/lib/side.js": "window.x = 1\n",
        "js/lib/lazy.js": "export async function* gen() {}\nexport class K {}\n",
        "js/lib/re.js": "export * from './deep.js';\nexport { z as renamed } from './deep.js';\n",
        "js/lib/deep.js": "export const { y, q: z } = { y: 1, q: 2 }\nexport let w\n",
        "js/views/v.js": "import { a } from '../lib/a.js';\nexport { a };\n",
        "content/data.json": "{}",
    }

    def test_a_good_tree_passes(self):
        problems, stats = self.ci.check(self.tree(self.GOOD))
        self.assertEqual(problems, [])
        self.assertGreaterEqual(stats["imports"], 10)
        self.assertEqual(self.ci.main([str(self.tree(self.GOOD))]), 0)

    def test_broken_imports_are_found(self):
        cases = {
            "missing file": ("import { a } from './gone.js';", "does not exist"),
            "wrong case": ("import { a } from './lib/A.js';", "case matters"),
            "bare name": ("import _ from 'lodash';", "bare module name"),
            "url": ("import x from 'https://cdn.example/x.js';", "is a URL"),
            "missing export": ("import { nope } from './lib/a.js';", "'nope' is not exported"),
            "no default": ("import d from './lib/ns.js';", "no default export"),
            "json without type": ("import d from '../content/data.json';", "with { type"),
            "fixtures": ("import f from '/dev-fixtures/f.js';", "dev-fixtures"),
            "not a module": ("import '../css/app.css';", "not a JavaScript module"),
            "computed": ("const n = 'a'; import(`./lib/${n}.js`);", "computed specifier"),
            "dynamic missing": ("import('./lib/gone.js');", "does not exist"),
            "re-export missing": ("export { ghost } from './lib/a.js';", "'ghost' is not exported"),
            "star chain missing": ("import { nothere } from './lib/re.js';", "'nothere' is not exported"),
            "dotfile": ("import x from './.secret.js';", "refuses to serve"),
        }
        for label, (code, expected) in cases.items():
            files = dict(self.GOOD, **{"js/app.js": code + "\n", "css/app.css": "body{}", "dev-fixtures/f.js": "",
                                       "js/.secret.js": ""})
            problems = self.problems(files)
            self.assertTrue(any(expected in p for p in problems), (label, problems))
            self.assertTrue(all(p.startswith("public/") for p in problems), problems)
        problems = self.problems(dict(self.GOOD, **{"index.html": '<script type="module" src="js/missing.js"></script>'}))
        self.assertTrue(any("index.html" in p and "does not exist" in p for p in problems), problems)
        self.assertEqual(self.ci.main([str(self.tree(dict(self.GOOD, **{"js/app.js": "import './x.js';"})))]), 1)

    def test_unreadable_javascript_is_reported(self):
        problems = self.problems(dict(self.GOOD, **{"js/app.js": "const s = 'unterminated\n"}))
        self.assertTrue(any("can't read this file" in p for p in problems), problems)


# ======================================================= bundle builder
class BundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mb = load_module("make_bundle", HUB / "deploy" / "make_bundle.py")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_collect_leaves_private_and_dev_files_out(self):
        names = [rel for rel, _ in self.mb.collect(HUB)]
        for required in self.mb.REQUIRED:
            self.assertIn(required, names)
        for rel in names:
            self.assertFalse(rel == "data" or rel.startswith("data/"), rel)
            self.assertFalse(rel.startswith("public/dev-fixtures/"), rel)
            self.assertNotEqual(rel, "BUILD_ID")
            self.assertFalse(any(part.startswith(".") for part in rel.split("/")), rel)
            self.assertNotIn("__pycache__", rel)

    def test_build_id_is_a_content_hash_of_public(self):
        files = {"public/index.html": b"a", "public/js/app.js": b"b", "server.py": b"c"}
        build = self.mb.compute_build_id(files)
        self.assertRegex(build, r"^[0-9a-f]{16}$")
        self.assertTrue(server.BUILD_RE.fullmatch(build))
        self.assertEqual(build, self.mb.compute_build_id(dict(files)))
        self.assertEqual(build, self.mb.compute_build_id(dict(files, **{"server.py": b"changed"})), "only public/ counts")
        self.assertNotEqual(build, self.mb.compute_build_id(dict(files, **{"public/js/app.js": b"B"})))
        self.assertNotEqual(build, self.mb.compute_build_id(dict(files, **{"public/js/new.js": b""})))

    def test_bundle_contents_and_modes(self):
        files = {"server.py": b"#!/usr/bin/env python3\n", "deploy/x.sh": b"echo\n", "public/index.html": b"<p>"}
        build = self.mb.compute_build_id(files)
        out = self.root / "fh.zip"
        digest = self.mb.write_bundle(out, files, build)
        self.assertEqual(digest, hashlib.sha256(out.read_bytes()).hexdigest())
        with zipfile.ZipFile(out) as z:
            names = z.namelist()
            self.assertEqual(z.read("fitness-hub/BUILD_ID").decode().strip(), build)
            self.assertNotIn("fitness-hub/data/data.json", names)
            modes = {info.filename: (info.external_attr >> 16) & 0o777 for info in z.infolist()}
        self.assertEqual(modes["fitness-hub/server.py"], 0o700)
        self.assertEqual(modes["fitness-hub/deploy/x.sh"], 0o700)
        self.assertEqual(modes["fitness-hub/public/index.html"], 0o600)
        self.assertFalse(any(mode & 0o077 for mode in modes.values()), "nothing in the bundle is group/other readable")
        self.assertFalse(list(self.root.glob("*.part")))
        with_data = self.root / "with-data.zip"
        self.mb.write_bundle(with_data, files, build, data_raw=b'{"schema_version": 1}')
        with zipfile.ZipFile(with_data) as z:
            info = z.getinfo("fitness-hub/data/data.json")
            self.assertEqual((info.external_attr >> 16) & 0o777, 0o600)
        if POSIX_PERMS:
            self.assertEqual(stat.S_IMODE(os.stat(with_data).st_mode), 0o600, "the zip file itself is 0600")

    def test_a_suite_that_runs_no_tests_does_not_pass(self):
        f = self.mb.tests_ran
        self.assertEqual(f("server tests", "...\nRan 93 tests in 60.4s\n\nOK (skipped=9)\n"), 93)
        self.assertEqual(f("server tests", "Ran 1 test in 0.0s\nOK"), 1)
        self.assertEqual(f("server tests", "Ran 0 tests in 0.000s\n\nNO TESTS RAN"), 0)
        self.assertEqual(f("client tests", "\u2714 a (1ms)\n\u2139 tests 183\n\u2139 pass 183\n"), 183)
        self.assertEqual(f("client tests", "# tests 5\n# pass 5\n"), 5)
        self.assertEqual(f("client tests", "Could not find anything"), 0)
        self.assertIsNone(f("import check", "imports: OK"))
        (self.root / "tests").mkdir()
        (self.root / "deploy").mkdir()
        empty = subprocess.CompletedProcess([], 0, stdout=b"Ran 0 tests in 0.000s\n\nOK\n", stderr=b"")
        with mock.patch.object(self.mb.subprocess, "run", return_value=empty), \
             mock.patch("sys.stdout", new_callable=io.StringIO) as printed:
            self.assertFalse(self.mb.run_checks(self.root))
        self.assertIn("ran no tests", printed.getvalue())

    def test_main_refuses_when_a_check_fails(self):
        out = self.root / "refused.zip"
        with mock.patch.object(self.mb, "run_checks", return_value=False) as checks, \
             mock.patch("sys.stdout", new_callable=io.StringIO), mock.patch("sys.stderr", new_callable=io.StringIO) as err:
            self.assertEqual(self.mb.main(["--out", str(out)]), 1)
        checks.assert_called_once()
        self.assertFalse(out.exists(), "no bundle without passing checks")
        self.assertIn("No bundle was written", err.getvalue())

    def test_main_builds_after_passing_checks_and_list_builds_nothing(self):
        out = self.root / "ok.zip"
        seen = {}

        def fake_checks(root):
            seen["root"] = root
            seen["has_data"] = (root / "data").exists()
            seen["has_fixtures"] = (root / "public" / "dev-fixtures").exists() == (HUB / "public" / "dev-fixtures").exists()
            seen["build"] = (root / "BUILD_ID").read_text().strip()
            return True

        with mock.patch.object(self.mb, "run_checks", side_effect=fake_checks), \
             mock.patch("sys.stdout", new_callable=io.StringIO) as printed:
            self.assertEqual(self.mb.main(["--out", str(out)]), 0)
        self.assertFalse(seen["has_data"], "the checks never run next to data/")
        self.assertTrue(seen["has_fixtures"], "the tests get the dev fixtures in their copy")
        self.assertFalse(seen["root"].exists(), "the temporary copy is removed")
        with zipfile.ZipFile(out) as z:
            self.assertEqual(z.read("fitness-hub/BUILD_ID").decode().strip(), seen["build"])
            self.assertFalse(any(n.startswith("fitness-hub/public/dev-fixtures/") for n in z.namelist()))
            self.assertFalse(any(n.startswith("fitness-hub/data/") for n in z.namelist()))
        self.assertIn(f"build:   {seen['build']}", printed.getvalue())
        listed = self.root / "never.zip"
        with mock.patch.object(self.mb, "run_checks") as checks, mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(self.mb.main(["--list", "--out", str(listed)]), 0)
        checks.assert_not_called()
        self.assertFalse(listed.exists())
        self.assertEqual(self.mb.main(["--out", str(HUB / "inside.zip")]), 2, "never inside the hub folder")


class TailscaleDeployFilesTests(unittest.TestCase):
    """The opt-in drop-in, the service unit and the docs agree with the server's rules."""

    def test_the_drop_in_sets_only_the_three_settings_and_refuses_to_start_until_filled_in(self):
        raw = (HUB / "deploy" / "tailscale.conf.example").read_bytes()
        self.assertNotIn(b"\r", raw)
        text = raw.decode("utf-8")
        lines = [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith(("#", ";"))]
        self.assertEqual(lines[0], "[Service]")
        values = {}
        for line in lines[1:]:
            key, _, assignment = line.partition("=")
            self.assertEqual(key, "Environment", f"nothing but the three settings: {line}")
            name, _, value = assignment.partition("=")
            values[name] = value
        self.assertEqual(sorted(values), sorted(server.TS_VARS))
        self.assertEqual(values["FITNESS_HUB_TS_SOCKET"], "%t/fitness-hub/ts.sock")
        for placeholder in ("<machine>.<tailnet>.ts.net", "<your-tailscale-login>"):
            self.assertEqual(text.count(placeholder), 1, "the guide replaces each placeholder exactly once")
        env = {name: value.replace("%t", "/run/user/1000") for name, value in values.items()}
        for fill in ({}, {"FITNESS_HUB_TS_HOST": TS_HOST}):
            env.update(fill)
            with self.assertRaisesRegex(server.ConfigError, "placeholder"):
                server.resolve_tailscale(env, TS_MAIN_SOCKET, platform="linux", has_unix=True)
        env["FITNESS_HUB_TS_USERS"] = TS_LOGIN
        ts = server.resolve_tailscale(env, TS_MAIN_SOCKET, platform="linux", has_unix=True)
        self.assertEqual(ts.socket_path, TS_MAIN_SOCKET.parent / "ts.sock")
        unit = (HUB / "deploy" / "fitness-hub.service").read_text(encoding="utf-8")
        self.assertIn("\nRestrictAddressFamilies=AF_UNIX\n", unit)
        self.assertIn("\nEnvironment=FITNESS_HUB_SOCKET=%t/fitness-hub/hub.sock\n", unit, "ts.sock sits next to hub.sock")
        settings = "".join(line for line in unit.splitlines(True) if not line.startswith("#"))
        self.assertNotIn("FITNESS_HUB_TS_", settings, "phone access is never on by default")
        self.assertIn("deploy/tailscale.conf.example", load_module("make_bundle_ts", HUB / "deploy" / "make_bundle.py").REQUIRED)

    def test_the_guide_and_docs_agree_about_phone_access(self):
        guide = (HUB / "deploy" / "CODEX_HOSTING_GUIDE.md").read_text(encoding="utf-8")
        self.assertIn("\n## 14. Phone access over Tailscale (only when the user explicitly asks)\n", guide)
        self.assertIn('sudo tailscale serve --bg --https=443 "unix:/run/user/$(id -u)/fitness-hub/ts.sock"', guide)
        docs = {name: (HUB / name).read_text(encoding="utf-8") for name in ("README.md", "MIGRATE.md")}
        docs["guide"] = guide
        for name, text in docs.items():
            self.assertIn("Tailscale", text, name)
            for stale in ("Phone access isn't part of this version", "Phone access is not part of this version",
                          "don't configure it yet", "added in the next release", "Phone access will come later"):
                self.assertNotIn(stale, text, name)


class ServeConfigAnalyzerTests(unittest.TestCase):
    """verify.sh's reading of `tailscale serve status --json` (its Python, taken from verify.sh itself)."""

    SOCK = "/run/user/1000/fitness-hub/ts.sock"
    MARKERS = ("/run/user/1000/fitness-hub", "/home/alex/fitness-hub", "/home/alex/fitness-hub-backups")

    @classmethod
    def setUpClass(cls):
        text = (HUB / "deploy" / "verify.sh").read_text(encoding="utf-8")
        match = re.search(r"^ts_serve_analyzer\(\) \{[^\n]*\n  cat <<'PYEOF'\n(.*?)\nPYEOF\n\}", text, re.S | re.M)
        assert match, "verify.sh has ts_serve_analyzer"
        cls.program = match.group(1)
        cls.mapping = {"TCP": {"443": {"HTTPS": True}},
                       "Web": {f"{TS_HOST}:443": {"Handlers": {"/": {"Proxy": f"unix:{cls.SOCK}"}}}}}

    def analyze(self, config, mode="off"):
        raw = config if isinstance(config, str) else json.dumps(config)
        r = subprocess.run([sys.executable, "-I", "-c", self.program, mode, TS_HOST, self.SOCK, *self.MARKERS],
                           input=raw.encode(), capture_output=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = [tuple(line.split("|", 1)) for line in r.stdout.decode().splitlines()]
        self.assertTrue(lines and all(kind in ("OK", "FAIL", "WARN") for kind, _ in lines), lines)
        return lines

    def kinds(self, config, mode="off"):
        return [kind for kind, _ in self.analyze(config, mode)]

    def with_(self, **changes):
        config = json.loads(json.dumps(self.mapping))
        config.update(changes)
        return config

    def test_without_phone_access_nothing_may_point_at_the_hub(self):
        self.assertEqual(self.kinds({}), ["OK"])
        self.assertEqual(self.kinds(""), ["OK"], "an empty answer is an empty config")
        other = {"TCP": {"8443": {"HTTPS": True}}, "Web": {f"{TS_HOST}:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3000"}}}}}
        self.assertEqual(self.kinds(other), ["OK", "WARN"], "other shares are reported, not failed")
        for config in (self.mapping, {"TCP": {"443": {"TCPForward": "127.0.0.1:8642"}}},
                       {"Web": {f"{TS_HOST}:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8642"}}}}},
                       {"Web": {f"{TS_HOST}:443": {"Handlers": {"/": {"Path": "/home/alex/fitness-hub/data"}}}}},
                       {"Foreground": {"s1": {"Web": {"x:443": {"Handlers": {"/": {"Proxy": "unix:/run/user/1000/fitness-hub/hub.sock"}}}}}}},
                       {"Services": {"svc:hub": {"Web": {"x:443": {"Handlers": {"/": {"Proxy": "unix:/srv/fitness-hub/x.sock"}}}}}}}):
            lines = self.analyze(config)
            self.assertEqual([k for k, _ in lines], ["FAIL"], (config, lines))
            self.assertIn("points at the hub", lines[0][1])

    def test_no_file_share_of_the_hub_its_backups_or_a_folder_above_them(self):
        def share(path, base=None):  # a Serve file share on 8443, next to `base` (another Serve config)
            config = json.loads(json.dumps(base or {}))
            config.setdefault("TCP", {})["8443"] = {"HTTPS": True}
            config.setdefault("Web", {})[f"{TS_HOST}:8443"] = {"Handlers": {"/files": {"Path": path}}}
            return config

        for path in ("/home/alex", "/home/alex/", "/home", "/", "//home//alex/.", "/home/alex/fitness-hub",
                     "/home/alex/fitness-hub-backups", "/home/alex/fitness-hub/../fitness-hub", "/run/user/1000",
                     "relative/path"):
            for mode, base in (("off", None), ("ts", self.mapping)):
                lines = self.analyze(share(path, base), mode)
                self.assertEqual([kind for kind, _ in lines], ["FAIL"], (path, mode, lines))
                self.assertIn("shares files from a folder that is, or holds, the hub's code, data or backups", lines[0][1])
                self.assertIn(path, lines[0][1], "the message names the share")
        for path in ("/media/usb/photos", "/home/alex/photos", "/home/alex/photos-2026"):
            self.assertEqual(self.kinds(share(path)), ["OK", "WARN"], (path, "an unrelated share is only reported"))
            self.assertEqual(self.kinds(share(path, self.mapping), "ts"), ["OK", "WARN"], path)
        inside = self.analyze(share("/home/alex/fitness-hub/data"))
        self.assertEqual([kind for kind, _ in inside], ["FAIL"], "inside the hub: refused as before")
        self.assertIn("points at the hub", inside[0][1])

    def test_funnel_is_never_allowed_anywhere(self):
        for config in ({"AllowFunnel": {f"{TS_HOST}:443": True}}, {"AllowFunnel": {"a:8443": False, "b:10000": True}},
                       {"Foreground": {"s1": {"AllowFunnel": {f"{TS_HOST}:443": True}}}},
                       {"Services": {"svc:x": {"AllowFunnel": {"x:443": True}}}}):
            for mode in ("off", "ts"):
                lines = self.analyze(config if mode == "off" else self.with_(**config), mode)
                self.assertTrue(any(k == "FAIL" and "Funnel is ON" in t for k, t in lines), (mode, config, lines))
        self.assertEqual(self.kinds({"AllowFunnel": {f"{TS_HOST}:443": False}}), ["OK"])
        self.assertEqual(self.kinds(self.with_(AllowFunnel={f"{TS_HOST}:443": False}), "ts"), ["OK"])

    def test_with_phone_access_443_maps_only_to_the_tailscale_socket(self):
        lines = self.analyze(self.mapping, "ts")
        self.assertEqual(lines, [("OK", f"Tailscale Serve maps https://{TS_HOST}/ (HTTPS 443) only to the hub's "
                                        "Tailscale socket, and Funnel is off")])
        handler = {"Proxy": f"unix:{self.SOCK}"}
        bad = [{},
               self.with_(TCP={"443": {"HTTPS": True, "TerminateTLS": "x"}}),
               self.with_(TCP={"443": {"TCPForward": f"unix:{self.SOCK}"}}),
               self.with_(TCP={"443": {"HTTP": True}}),
               self.with_(Web={f"{TS_HOST}:443": {"Handlers": {"/": {"Proxy": "unix:/run/user/1000/fitness-hub/hub.sock"}}}}),
               self.with_(Web={f"{TS_HOST}:443": {"Handlers": {"/": {"Proxy": f"http://127.0.0.1:8642"}}}}),
               self.with_(Web={f"{TS_HOST}:443": {"Handlers": {"/": handler, "/files": {"Path": "/srv"}}}}),
               self.with_(Web={f"{TS_HOST}:443": {"Handlers": {"/hub": handler}}}),
               self.with_(Web={f"{TS_HOST}:443": {"Handlers": {"/": dict(handler, AcceptAppCaps=["example.com/cap"])}}}),
               self.with_(Web={f"{TS_HOST}:443": {"Handlers": {"/": dict(handler, Text="hi")}}}),
               self.with_(Web={f"{TS_HOST}:443": {"Handlers": {"/": handler}}, "other.tail1234.ts.net:443": {"Handlers": {"/": {"Text": "x"}}}}),
               self.with_(TCP={"443": {"HTTPS": True}, "10000": {"TCPForward": "127.0.0.1:8642"}}),
               "[]"]
        for config in bad:
            self.assertIn("FAIL", self.kinds(config, "ts"), config)
        extra = self.with_(TCP={"443": {"HTTPS": True}, "8443": {"HTTPS": True}},
                           Foreground={"s1": {"TCP": {"9000": {"HTTPS": True}}}})
        self.assertEqual(self.kinds(extra, "ts"), ["OK", "WARN"], "unrelated shares are reported")
        self.assertEqual(self.kinds(self.with_(Web={f"{TS_HOST}:443": {"Handlers": {"/": dict(handler, Text="")}}}), "ts"),
                         ["OK"], "empty optional fields are fine")


# ======================================================= deploy scripts
def find_bash() -> str | None:
    """A usable bash: on Windows only Git Bash/MSYS (never WSL's bash.exe, which is another system)."""
    bash = shutil.which("bash")
    if bash is None:
        return None
    if os.name == "nt":
        try:
            kind = subprocess.run([bash, "-c", "uname -s"], capture_output=True, timeout=20).stdout.decode()
        except (OSError, subprocess.SubprocessError):
            return None
        if not kind.startswith(("MINGW", "MSYS", "CYGWIN")):
            return None
    return bash


BASH = find_bash()
SCRIPTS = sorted((HUB / "deploy").glob("*.sh")) + [HUB / "start_hub.sh"]


def to_bash_path(path: Path) -> str:
    return path.as_posix()


def write_fake_tunnel(root: Path) -> Path:
    """A stand-in for ssh's local forward: after a delay it answers /api/health like the hub."""
    script = root / "fake_tunnel.py"
    script.write_text(
        "import http.server, json, sys, threading, time\n"
        "port, delay = int(sys.argv[1]), float(sys.argv[2])\n"
        "assert port != 8642\n"
        "time.sleep(delay)\n"
        "body = json.dumps({'ok': True, 'app': 'fitness-hub'}).encode()\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers()\n"
        "        self.wfile.write(body)\n"
        "    def log_message(self, *a): pass\n"
        "s = http.server.HTTPServer(('127.0.0.1', port), H)\n"
        "threading.Timer(6, s.shutdown).start()\n"
        "s.serve_forever(poll_interval=0.05)\n", encoding="utf-8")
    return script


def write_fake_tailscale(bindir: Path) -> Path:
    """A stand-in for the tailscale CLI, first on PATH, with canned answers from FAKE_TS_* variables.
    Nothing here talks to Tailscale or to the network."""
    script = bindir / "tailscale"
    script.write_text(
        "#!/usr/bin/env bash\n"
        "down() { echo \"failed to connect to local tailscaled; it doesn't appear to be running\" >&2; exit 1; }\n"
        "case \"$*\" in\n"
        "  version) printf '%s\\n  tailscale commit: 0123abcd\\n' \"${FAKE_TS_VERSION:-1.104.4}\" ;;\n"
        "  'status --json')\n"
        "    [ -z \"${FAKE_TS_DOWN:-}\" ] || down\n"
        "    printf '{\"Version\": \"%s-t0123abcd-g4567ef\", \"BackendState\": \"Running\"}\\n' \"${FAKE_TS_DAEMON:-1.104.4}\" ;;\n"
        "  'serve status --json')\n"
        "    [ -z \"${FAKE_TS_DOWN:-}\" ] || down\n"
        "    cat -- \"$FAKE_TS_SERVE\" ;;\n"
        "  *) echo \"unexpected tailscale call: $*\" >&2; exit 64 ;;\n"
        "esac\n", encoding="utf-8", newline="\n")
    script.chmod(0o700)
    return script


def write_fake_systemctl(bindir: Path) -> Path:
    """A stand-in for systemctl, first on PATH: it logs every call to FAKE_SYSTEMCTL_LOG and changes
    nothing. `is-active tailscaled` answers FAKE_TAILSCALED (inactive by default; "none" plays a
    sandbox where the bus can't be reached); `--user start ...` fails with FAKE_SYSTEMCTL_FAIL_START=1."""
    script = bindir / "systemctl"
    script.write_text(
        "#!/usr/bin/env bash\n"
        "[ -z \"${FAKE_SYSTEMCTL_LOG:-}\" ] || printf 'systemctl %s\\n' \"$*\" >> \"$FAKE_SYSTEMCTL_LOG\"\n"
        "case \"$*\" in\n"
        "  'is-active tailscaled')\n"
        "    case \"${FAKE_TAILSCALED:-inactive}\" in\n"
        "      none) echo 'Failed to connect to bus: Operation not permitted' >&2; exit 1 ;;\n"
        "      active) echo active; exit 0 ;;\n"
        "      *) echo \"${FAKE_TAILSCALED:-inactive}\"; exit 3 ;;\n"
        "    esac ;;\n"
        "  '--user start '*) [ -z \"${FAKE_SYSTEMCTL_FAIL_START:-}\" ] || { echo \"Job for $3 failed.\" >&2; exit 1; } ;;\n"
        "  '--user show '*'--property=LoadState'*) echo loaded ;;\n"
        "esac\n"
        "exit 0\n", encoding="utf-8", newline="\n")
    script.chmod(0o700)
    return script


def write_fake_ss(bindir: Path) -> Path:
    """A stand-in for ss, first on PATH. FAKE_SS: "fail" (exit 1, like ss in a sandbox), "complain"
    (exit 0 but an error on stderr), "busy" (a listener on FAKE_SS_PORT), anything else: no sockets."""
    script = bindir / "ss"
    script.write_text(
        "#!/usr/bin/env bash\n"
        "case \"${FAKE_SS:-}\" in\n"
        "  fail) echo 'Cannot open netlink socket: Operation not permitted' >&2; exit 1 ;;\n"
        "  complain) echo 'Cannot open /proc/net/tcp: Permission denied' >&2 ;;\n"
        "  busy) printf 'LISTEN 0      128          0.0.0.0:%s        0.0.0.0:*\\n' \"${FAKE_SS_PORT:-1}\" ;;\n"
        "  user) printf 'LISTEN 0 5 127.0.0.1:631 0.0.0.0:* users:((\"cupsd\",pid=7,fd=3))\\n"
        "LISTEN 0 5 0.0.0.0:8000 0.0.0.0:* users:((\"python3\",pid=42,fd=3))\\n' ;;\n"
        "esac\n"
        "exit 0\n", encoding="utf-8", newline="\n")
    script.chmod(0o700)
    return script


def bash_abs(path: Path) -> str:
    """An absolute path as bash on this system spells it (/c/Users/... in Git Bash)."""
    text = path.resolve().as_posix()
    if os.name == "nt" and len(text) > 2 and text[1] == ":":
        return "/" + text[0].lower() + text[2:]
    return text


@unittest.skipUnless(BASH, "needs bash")
class DeployScriptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = private_tmp()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def bash(self, script: Path, *args, env=None, timeout=120):
        return subprocess.run([BASH, to_bash_path(script), *args], env=env or clean_env(), capture_output=True,
                              timeout=timeout, stdin=subprocess.DEVNULL)

    def test_shell_syntax(self):
        for script in SCRIPTS:
            r = subprocess.run([BASH, "-n", to_bash_path(script)], capture_output=True, timeout=30)
            self.assertEqual(r.returncode, 0, (script.name, r.stderr))
            self.assertNotIn(b"\r", script.read_bytes(), f"{script.name} must have LF line endings")

    def test_update_refuses_test_settings_without_testing_flag(self):
        for name in ("FITNESS_HUB_DIR", "FITNESS_HUB_BACKUP_ROOT", "FITNESS_HUB_NO_SYSTEMD", "FITNESS_HUB_VERIFY_PORT",
                     "FITNESS_HUB_VERIFY_TS_SOCKET", "FITNESS_HUB_VERIFY_TS_LOGIN", "FITNESS_HUB_VERIFY_TAILSCALE"):
            r = self.bash(HUB / "deploy" / "update.sh", "--list", env=clean_env(**{name: str(self.root)}))
            self.assertNotEqual(r.returncode, 0, name)
            self.assertIn(b"FITNESS_HUB_TESTING=1", r.stderr, name)

    def test_update_rejects_odd_rollback_stamps(self):
        hub = self.root / "hub"
        (hub / "data").mkdir(parents=True)
        (hub / "server.py").write_text("")
        env = clean_env(FITNESS_HUB_TESTING="1", FITNESS_HUB_NO_SYSTEMD="1", FITNESS_HUB_DIR=to_bash_path(hub),
                        FITNESS_HUB_BACKUP_ROOT=to_bash_path(self.root / "backups"))
        for stamp in ("../etc", "a/b", "..", "20261121-153000/../x", "-rf", "20261121", "x" * 30):
            r = self.bash(HUB / "deploy" / "update.sh", "--rollback", stamp, env=env)
            self.assertNotEqual(r.returncode, 0, stamp)
            self.assertIn(b"not a saved-copy name", r.stderr, (stamp, r.stderr))
        self.assertTrue((hub / "server.py").exists(), "nothing was touched")

    def test_connect_script_guards(self):
        script = HUB / "deploy" / "connect_from_pc.sh"
        bindir = self.root / "fakebin"
        bindir.mkdir()
        marker = self.root / "ssh-ran"
        fake = bindir / "ssh"  # must never run in these cases; it shadows any real ssh
        fake.write_text(f"#!/usr/bin/env bash\n: > '{to_bash_path(marker)}'\nexit 99\n", encoding="utf-8")
        fake.chmod(0o700)
        with_fake = clean_env(PATH=str(bindir) + os.pathsep + os.environ.get("PATH", ""))
        for server in ("-oProxyCommand=evil", "user host", "a;b", "x$(id)"):
            r = self.bash(script, server, "1000", env=with_fake)
            self.assertNotEqual(r.returncode, 0, server)
            self.assertIn(b"doesn't look like", r.stderr, server)
        r = self.bash(script, "alex@homeserver", "12a", env=with_fake)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"user ID", r.stderr)
        self.assertFalse(marker.exists(), "ssh never ran for a refused request")
        empty_bin = self.root / "nobin"
        empty_bin.mkdir()
        env = clean_env(PATH=to_bash_path(empty_bin))
        r = subprocess.run([BASH, to_bash_path(script), "alex@homeserver", "1000"], env=env, capture_output=True,
                           timeout=60, stdin=subprocess.DEVNULL)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"ssh was not found", r.stderr)
        port = free_port()
        holder = socket.socket()
        holder.bind(("127.0.0.1", port))
        holder.listen(1)
        try:
            env = dict(with_fake, FITNESS_HUB_TESTING="1", FITNESS_HUB_LOCAL_PORT=str(port))
            r = self.bash(script, "alex@homeserver", "1000", env=env)
        finally:
            holder.close()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"already in use", r.stderr)
        r = self.bash(script, "alex@homeserver", "1000", env=dict(with_fake, FITNESS_HUB_LOCAL_PORT=str(port)))
        self.assertIn(b"FITNESS_HUB_TESTING=1", r.stderr, "the port override is for tests only")
        self.assertFalse(marker.exists(), "ssh never ran for a refused request")

    def test_connect_script_opens_the_browser_only_after_health_answers(self):
        port = free_port()
        bindir = self.root / "bin"
        bindir.mkdir()
        argfile = self.root / "ssh-args.txt"
        fake_server = write_fake_tunnel(self.root)
        fake_ssh = bindir / "ssh"  # shadows the real ssh: nothing here ever contacts another host
        fake_ssh.write_text(
            "#!/usr/bin/env bash\n"
            f"printf '%s\\n' \"$@\" > '{to_bash_path(argfile)}'\n"
            f"exec '{to_bash_path(Path(sys.executable))}' '{to_bash_path(fake_server)}' {port} 1.0\n", encoding="utf-8")
        fake_ssh.chmod(0o700)
        env = clean_env(PATH=str(bindir) + os.pathsep + os.environ.get("PATH", ""), FITNESS_HUB_TESTING="1",
                        FITNESS_HUB_LOCAL_PORT=str(port), FITNESS_HUB_OPEN_CMD="echo OPENED")
        found = subprocess.run([BASH, "-c", "command -v ssh"], env=env, capture_output=True, timeout=30).stdout.decode()
        self.assertTrue(found.strip().endswith("/bin/ssh"), ("the fake ssh must come first", found))
        started = time.monotonic()
        r = self.bash(HUB / "deploy" / "connect_from_pc.sh", "--", "alex@homeserver", "1000", env=env, timeout=60)
        out = r.stdout.decode()
        self.assertIn(f"OPENED http://127.0.0.1:{port}/", out, (out, r.stderr))
        self.assertGreater(time.monotonic() - started, 1.0, "not before the tunnel answered")
        args = argfile.read_text().split("\n")
        self.assertIn(f"127.0.0.1:{port}:/run/user/1000/fitness-hub/hub.sock", args)
        self.assertIn("ExitOnForwardFailure=yes", args)
        self.assertEqual(args[args.index("--") + 1], "alex@homeserver", "the login comes after --")

    def private_hub_dir(self) -> Path:
        hub_dir = self.root / "vhub"
        hub_dir.mkdir(mode=0o700)
        (hub_dir / "data").mkdir(mode=0o700)
        if POSIX_PERMS:
            os.chmod(hub_dir, 0o700)
            os.chmod(hub_dir / "data", 0o700)
        return hub_dir

    @unittest.skipUnless(shutil.which("curl"), "needs curl")
    def test_verify_script_against_a_test_hub(self):
        hub = HubProcess(self.root, name="verify").start()
        try:
            env = clean_env(FITNESS_HUB_VERIFY_PORT=str(hub.port), FITNESS_HUB_DIR=to_bash_path(self.private_hub_dir()),
                            FITNESS_HUB_BACKUP_ROOT=to_bash_path(self.root / "no-backups-yet"))
            r = self.bash(HUB / "deploy" / "verify.sh", "--no-systemd", env=env)
            out = r.stdout.decode()
            self.assertIn("proxy headers are refused", out)
            self.assertIn("PUT /api/data without If-Match is refused (428)", out)
            self.assertIn("Listening on 127.0.0.1:", out)
            self.assertEqual([line for line in out.splitlines() if line.startswith("[FAIL]")], [], out)
            self.assertEqual(r.returncode, 0, out)
            self.assertIn("ALL", out.splitlines()[-1])
        finally:
            hub.stop()
        r = self.bash(HUB / "deploy" / "verify.sh", "--no-systemd", env=env)
        self.assertEqual(r.returncode, 1, "with the hub stopped, verification fails")
        self.assertIn(b"/api/data is never fetched then", r.stdout)

    @unittest.skipUnless(UNIX_SOCKETS and shutil.which("curl") and shutil.which("ss") and shutil.which("stat"),
                         "needs Unix sockets, curl, ss and GNU stat (Linux)")
    def test_verify_script_against_a_socket_hub(self):
        (self.root / "rt").mkdir(mode=0o700)
        sock = self.root / "rt" / "fitness-hub" / "hub.sock"
        hub = HubProcess(self.root, name="vsock", socket_path=sock).start()
        try:
            env = clean_env(FITNESS_HUB_VERIFY_SOCKET=str(sock), FITNESS_HUB_VERIFY_PORT=str(hub.port),
                            FITNESS_HUB_DIR=str(self.private_hub_dir()), FITNESS_HUB_BACKUP_ROOT=str(self.root / "nb"))
            r = self.bash(HUB / "deploy" / "verify.sh", "--no-systemd", env=env)
            out = r.stdout.decode()
            self.assertIn("is 600 in a 700 folder", out)
            self.assertIn(f"Nothing listens on TCP port {hub.port}", out)
            self.assertEqual([line for line in out.splitlines() if line.startswith("[FAIL]")], [], out)
            self.assertEqual(r.returncode, 0, out)
        finally:
            hub.stop()

    @unittest.skipUnless(shutil.which("curl"), "needs curl")
    def test_verify_checks_tailscale_with_a_stand_in_cli(self):
        """verify.sh's Tailscale checks (the shell side) against canned `tailscale` answers, with and
        without phone access. The JSON rules themselves are covered by ServeConfigAnalyzerTests."""
        bindir = self.root / "tsbin"
        bindir.mkdir()
        write_fake_tailscale(bindir)
        write_fake_systemctl(bindir)  # never the real one: verify.sh asks it whether tailscaled runs
        serve = self.root / "serve.json"
        sock = "/run/user/1000/fitness-hub/ts.sock"
        mapping = {"TCP": {"443": {"HTTPS": True}}, "Web": {f"{TS_HOST}:443": {"Handlers": {"/": {"Proxy": f"unix:{sock}"}}}}}
        # MSYS2_ARG_CONV_EXCL: Git Bash on Windows would rewrite /run/... arguments into C:/... paths.
        base = clean_env(PATH=str(bindir) + os.pathsep + os.environ.get("PATH", ""), MSYS2_ARG_CONV_EXCL="*",
                         FITNESS_HUB_VERIFY_PORT=str(free_port()), FITNESS_HUB_DIR=to_bash_path(self.private_hub_dir()),
                         FITNESS_HUB_BACKUP_ROOT=to_bash_path(self.root / "nb"), FITNESS_HUB_VERIFY_TAILSCALE="1",
                         FAKE_TS_SERVE=to_bash_path(serve))
        ts_mode = {"FITNESS_HUB_VERIFY_TS_SOCKET": sock, "FITNESS_HUB_VERIFY_TS_HOST": TS_HOST.upper(),
                   "FITNESS_HUB_VERIFY_TS_LOGIN": TS_LOGIN}

        def run(config, **extra):
            serve.write_text(config if isinstance(config, str) else json.dumps(config), encoding="utf-8")
            r = self.bash(HUB / "deploy" / "verify.sh", "--no-systemd", env=dict(base, **extra))
            return r.returncode, r.stdout.decode()

        found = subprocess.run([BASH, "-c", "command -v tailscale; command -v systemctl"], env=base, capture_output=True,
                               timeout=30)
        self.assertEqual([line.rsplit("/", 2)[-2:] for line in found.stdout.decode().splitlines()],
                         [["tsbin", "tailscale"], ["tsbin", "systemctl"]], found)
        # A live test hub without phone access: everything passes, Tailscale included.
        hub = HubProcess(self.root, name="vts").start()
        try:
            code, out = run({}, FITNESS_HUB_VERIFY_PORT=str(hub.port))
        finally:
            hub.stop()
        self.assertEqual(code, 0, out)
        self.assertIn("[ OK ] Tailscale Serve doesn't point at the hub, and Funnel is off", out)
        self.assertIn("[ OK ] Requests carrying proxy headers are refused (403)", out)
        # The rest needs no hub (its HTTP checks are skipped): only the Tailscale lines matter here.
        # The CLI can't reach tailscaled: a PASS only when systemd confirms tailscaled isn't running.
        for state in ("inactive", "failed"):
            code, out = run({}, FAKE_TS_DOWN="1", FAKE_TAILSCALED=state)
            self.assertIn("[ OK ] Tailscale isn't running here, so it shares nothing", out)
        for state, shown in (("active", "'active'"), ("none", "'unknown'"), ("activating", "'activating'")):
            code, out = run({}, FAKE_TS_DOWN="1", FAKE_TAILSCALED=state)
            self.assertIn(f"[FAIL] The tailscale command can't reach tailscaled (failed to connect", out, state)
            self.assertIn(f"systemd says tailscaled is {shown}", out, state)
            self.assertIn("Run verify.sh outside the sandbox (guide, section 3)", out, state)
            self.assertNotIn("[ OK ] Tailscale isn't running here", out, state)
        code, out = run({"AllowFunnel": {f"{TS_HOST}:8443": True}, "TCP": {"8443": {"HTTPS": True}}})
        self.assertIn("[FAIL] Tailscale Funnel is ON", out)
        self.assertIn("[WARN] Tailscale Serve also shares other things on this server (port 8443)", out)
        # With phone access configured (no ts.sock exists here, so the socket checks fail and are skipped).
        code, out = run(mapping, **ts_mode)
        self.assertIn("[ OK ] Tailscale 1.104.4 (daemon 1.104.4) is 1.104.4 or newer", out)
        self.assertIn(f"[ OK ] Tailscale Serve maps https://{TS_HOST}/ (HTTPS 443) only to the hub's Tailscale "
                      "socket, and Funnel is off", out)
        self.assertIn(f"[FAIL] No Tailscale socket at {sock}", out)
        self.assertNotIn(TS_LOGIN, out, "verify.sh never prints the allowed logins")
        code, out = run({}, FAKE_TS_VERSION="1.104.3", **ts_mode)
        self.assertIn("[FAIL] Tailscale 1.104.3 is too old for phone access: 1.104.4 or newer is needed", out)
        self.assertIn(f"[FAIL] Tailscale Serve doesn't map https://{TS_HOST}/ (HTTPS 443) to exactly one handler", out)
        code, out = run(dict(mapping, AllowFunnel={f"{TS_HOST}:443": True}), FAKE_TS_DAEMON="1.102.0", **ts_mode)
        self.assertIn("[FAIL] The running tailscaled is 1.102.0, older than 1.104.4", out)
        self.assertIn("[FAIL] Tailscale Funnel is ON", out)
        code, out = run(mapping, FAKE_TS_DOWN="1", **ts_mode)
        self.assertIn("[FAIL] Tailscale isn't running here (tailscaled is inactive)", out)
        self.assertEqual(code, 1)
        code, out = run(mapping, FAKE_TS_DOWN="1", FAKE_TAILSCALED="active", **ts_mode)
        self.assertIn("Run verify.sh outside the sandbox", out)

    def test_verify_fails_closed_when_ss_errs(self):
        """An ss that can't read the socket tables (a sandbox) is a FAIL, never "nothing listens"."""
        bindir = self.root / "ssbin"
        bindir.mkdir()
        write_fake_ss(bindir)
        port = free_port()
        base = clean_env(PATH=str(bindir) + os.pathsep + os.environ.get("PATH", ""), MSYS2_ARG_CONV_EXCL="*",
                         FITNESS_HUB_VERIFY_PORT=str(port), FITNESS_HUB_DIR=to_bash_path(self.private_hub_dir()),
                         FITNESS_HUB_BACKUP_ROOT=to_bash_path(self.root / "nb"))
        found = subprocess.run([BASH, "-c", "command -v ss"], env=base, capture_output=True, timeout=30)
        self.assertTrue(found.stdout.decode().strip().endswith("/ssbin/ss"), found)
        socket_mode = {"FITNESS_HUB_VERIFY_SOCKET": "/run/user/1000/fitness-hub-no-such-test/hub.sock"}

        def run(**extra):
            r = self.bash(HUB / "deploy" / "verify.sh", "--no-systemd", env=dict(base, **extra))
            return r.returncode, r.stdout.decode()

        for fake in ("fail", "complain"):
            for mode in (socket_mode, {}):
                code, out = run(FAKE_SS=fake, **mode)
                self.assertEqual(code, 1, out)
                self.assertIn("[FAIL] Couldn't list this machine's listening sockets (ss", out, (fake, mode))
                self.assertIn("Run verify.sh outside the sandbox (guide, section 3)", out)
                self.assertNotIn("Nothing listens on TCP", out)
        code, out = run(FAKE_SS="none", **socket_mode)
        self.assertIn(f"[ OK ] Nothing listens on TCP port {port} here", out)
        code, out = run(FAKE_SS="busy", FAKE_SS_PORT=str(port), **socket_mode)
        self.assertIn(f"[FAIL] Something listens on TCP port {port} on this server (0.0.0.0:{port}", out)
        # The server-only check of the user's own listeners (sourced: it runs only under systemd).
        harness = self.root / "listeners.sh"
        harness.write_text('set -u\nsource "$VERIFY_SH"\ncheck_user_listeners\nprintf "RESULT %s/%s\\n" "$checks" "$fails"\n',
                           encoding="utf-8", newline="\n")
        for fake, verdict, line in (("fail", "RESULT 1/1", "so it can't be shown that none of your programs listens"),
                                    ("complain", "RESULT 1/1", "Run verify.sh outside the sandbox"),
                                    ("none", "RESULT 1/0", "[ OK ] None of your programs listens on a network address"),
                                    ("user", "RESULT 1/1", "Your programs listen on the network: python3 on 0.0.0.0:8000;")):
            r = subprocess.run([BASH, to_bash_path(harness)], capture_output=True, timeout=60, stdin=subprocess.DEVNULL,
                               env=dict(base, VERIFY_SH=to_bash_path(HUB / "deploy" / "verify.sh"), FAKE_SS=fake))
            out = r.stdout.decode()
            self.assertIn(verdict, out, (fake, out))
            self.assertIn(line, out, fake)
            self.assertNotIn("cupsd", out, "loopback listeners are fine")

    @unittest.skipUnless(shutil.which("curl"), "needs curl")
    def test_verify_probes_the_tailscale_policy(self):
        """check_ts_listener's probes against the real TailscalePolicy. verify.sh is sourced and its
        ts_curl pointed at a loopback port standing in for ts.sock, so this runs on every platform."""
        store = server.HubStore(self.root / "tsdata")
        servers = []

        def start(policy) -> int:
            port = free_port()
            httpd = server.HubServer(("127.0.0.1", port), server.HubHandler, store=store, policy=policy,
                                     instance="test", timeouts=server.Timeouts())
            httpd.listen_kind = httpd.log_via = "tailscale"
            thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
            thread.start()
            servers.append((httpd, thread))
            return port

        class FillsIn(server.TailscalePolicy):  # a listener that makes up a header Serve didn't send
            fill: dict = {}

            def admit(self, headers):
                for name, value in self.fill.items():
                    if headers.get(name) is None:
                        headers[name] = value
                return super().admit(headers)

        harness = self.root / "probe.sh"
        harness.write_text(
            'set -u\n'
            'source "$VERIFY_SH"\n'  # main doesn't run when sourced
            'TS_SOCK=unused TS_HOST="$PROBE_TS_HOST" TS_LOGIN="$PROBE_TS_LOGIN" PY="$PROBE_PY"\n'
            'ts_curl() { curl -q -sS --noproxy "*" --max-time 5 --connect-to "localhost:80:127.0.0.1:$PROBE_PORT" "$@"; }\n'
            'check_ts_listener\n'
            'printf "RESULT %s/%s\\n" "$checks" "$fails"\n', encoding="utf-8", newline="\n")

        def probe(port: int) -> str:
            env = clean_env(VERIFY_SH=to_bash_path(HUB / "deploy" / "verify.sh"), PROBE_TS_HOST=TS_HOST,
                            PROBE_TS_LOGIN=TS_LOGIN, PROBE_PY=to_bash_path(Path(sys.executable)), PROBE_PORT=str(port))
            r = subprocess.run([BASH, to_bash_path(harness)], env=env, capture_output=True, timeout=120,
                               stdin=subprocess.DEVNULL)
            return r.stdout.decode() + r.stderr.decode()

        try:
            out = probe(start(server.TailscalePolicy(ts_settings())))
            self.assertIn("[ OK ] Tailscale socket: no login, a wrong login, a forged Via, a wrong or missing "
                          "X-Forwarded-Host and a plain-HTTP or missing X-Forwarded-Proto get 403; an allowed login "
                          "gets 200", out)
            self.assertIn(f"[ OK ] Tailscale socket: saves need Origin https://{TS_HOST} (403 without it), then "
                          "If-Match (428)", out)
            self.assertIn("RESULT 2/0", out)
            for name, value, codes in (("X-Forwarded-Proto", "https", "403/403/403/403/403/403/200/200"),
                                       ("X-Forwarded-Host", TS_HOST, "403/403/403/403/200/403/403/200")):
                lax = FillsIn(ts_settings())
                lax.fill = {name: value}
                out = probe(start(lax))
                self.assertIn("[FAIL] Tailscale socket: expected 403 x7", out, name)
                self.assertIn(f"got {codes}", out, name)
                self.assertIn("RESULT 2/1", out, name)
        finally:
            for httpd, thread in servers:
                httpd.shutdown()
                httpd.server_close()
                thread.join(5)

    @unittest.skipUnless(LINUX_SOCKETS and shutil.which("curl") and shutil.which("ss") and shutil.which("stat"),
                         "needs Linux, curl, ss and GNU stat")
    def test_verify_script_against_a_tailscale_hub(self):
        (self.root / "rt").mkdir(mode=0o700)
        sock = self.root / "rt" / "fitness-hub" / "hub.sock"
        ts_sock = sock.parent / "ts.sock"
        hub = HubProcess(self.root, name="vtsh", socket_path=sock, env={
            "FITNESS_HUB_TS_SOCKET": str(ts_sock), "FITNESS_HUB_TS_HOST": TS_HOST,
            "FITNESS_HUB_TS_USERS": f"{TS_LOGIN},alex@github"}).start()
        bindir = self.root / "tsbin"
        bindir.mkdir()
        write_fake_tailscale(bindir)
        serve = self.root / "serve.json"
        serve.write_text(json.dumps({"TCP": {"443": {"HTTPS": True}},
                                     "Web": {f"{TS_HOST}:443": {"Handlers": {"/": {"Proxy": f"unix:{ts_sock}"}}}}}),
                         encoding="utf-8")
        try:
            env = clean_env(PATH=str(bindir) + os.pathsep + os.environ.get("PATH", ""), FITNESS_HUB_VERIFY_SOCKET=str(sock),
                            FITNESS_HUB_VERIFY_PORT=str(hub.port), FITNESS_HUB_DIR=str(self.private_hub_dir()),
                            FITNESS_HUB_BACKUP_ROOT=str(self.root / "nb"), FITNESS_HUB_VERIFY_TS_SOCKET=str(ts_sock),
                            FITNESS_HUB_VERIFY_TS_HOST=TS_HOST, FITNESS_HUB_VERIFY_TS_LOGIN=TS_LOGIN,
                            FITNESS_HUB_VERIFY_TAILSCALE="1", FAKE_TS_SERVE=str(serve))
            r = self.bash(HUB / "deploy" / "verify.sh", "--no-systemd", env=env)
            out = r.stdout.decode()
            for line in (f"[ OK ] Tailscale socket {ts_sock} is 600 and yours", "an allowed login gets 200",
                         f"[ OK ] Tailscale socket: saves need Origin https://{TS_HOST}", "and Funnel is off",
                         "is 1.104.4 or newer", "[ OK ] Requests carrying proxy headers are refused (403)"):
                self.assertIn(line, out)
            self.assertEqual([line for line in out.splitlines() if line.startswith("[FAIL]")], [], out)
            self.assertEqual(r.returncode, 0, out)
            # A listener that doesn't check identity is caught: pretend the main socket were the Tailscale one.
            r = self.bash(HUB / "deploy" / "verify.sh", "--no-systemd", env=dict(env, FITNESS_HUB_VERIFY_TS_SOCKET=str(sock)))
            out = r.stdout.decode()
            self.assertEqual(r.returncode, 1, out)
            self.assertIn("[FAIL] Tailscale socket: expected 403 x7 (no login, wrong login, Via, wrong host, no host, "
                          "http, no proto) and a 200 health answer", out)
        finally:
            hub.stop()

    def test_update_and_rollback_leave_everything_private(self):
        """SRE1: update.sh, then --rollback, in a stub tree. On POSIX, `find -perm /077` (verify.sh's
        check) must then find nothing. On Windows the flow still runs; only the modes can't be checked."""
        mb = load_module("make_bundle_sre1", HUB / "deploy" / "make_bundle.py")
        hub = self.root / "fitness-hub"
        backups = self.root / "fitness-hub-backups"
        old = mini_hub(self.root, None, name="old")
        shutil.copytree(old, hub)
        (hub / "deploy").mkdir()
        (hub / "data" / "backups").mkdir(parents=True, mode=0o700)
        (hub / "data" / "data.json").write_text(json.dumps(server.default_data()))
        os.chmod(hub / "data" / "data.json", 0o600)
        for path in [hub, *hub.rglob("*")]:  # an old install with the usual loose modes, data/ included
            os.chmod(path, 0o755 if path.is_dir() else 0o644)
        files = {"server.py": (HUB / "server.py").read_bytes(), "public/index.html": b"<title>Fitness Hub</title>",
                 "public/js/app.js": b"export const ok = 1;\n",
                 "deploy/fitness-hub.service": (HUB / "deploy" / "fitness-hub.service").read_bytes(),
                 "deploy/verify.sh": (HUB / "deploy" / "verify.sh").read_bytes(),
                 "deploy/update.sh": (HUB / "deploy" / "update.sh").read_bytes(),
                 "deploy/check_imports.py": (HUB / "deploy" / "check_imports.py").read_bytes(),
                 # Stand-in tests that leave marks in the tree they run in: the installed code must not have them.
                 "tests/test_server.py": (b"from pathlib import Path\n"
                                          b"Path('TESTS_RAN_HERE').write_text('x')\n"
                                          b"Path('public/index.html').write_text('changed by the tests')\n"
                                          b"print('Ran 1 test in 0.0s')\nprint('OK')\n")}
        bundle = self.root / "bundle.zip"
        mb.write_bundle(bundle, files, mb.compute_build_id(files))
        data_before = (hub / "data" / "data.json").read_bytes()
        env = clean_env(FITNESS_HUB_TESTING="1", FITNESS_HUB_NO_SYSTEMD="1", FITNESS_HUB_DIR=to_bash_path(hub),
                        FITNESS_HUB_BACKUP_ROOT=to_bash_path(backups), HOME=str(self.root))

        def loose():
            r = subprocess.run(["find", str(hub), str(backups), "!", "-type", "l", "-perm", "/077"],
                               capture_output=True, text=True, timeout=30)
            return [line for line in r.stdout.splitlines() if line]

        if POSIX_PERMS:
            self.assertTrue(loose(), "the stub starts out loose, like an old install")
        r = self.bash(HUB / "deploy" / "update.sh", to_bash_path(bundle), env=env, timeout=300)
        out = r.stdout.decode() + r.stderr.decode()
        self.assertEqual(r.returncode, 0, out)
        self.assertIn("Server tests passed: Ran 1 test", out)
        self.assertIn("Unpacked a pristine copy to install", out)
        self.assertIn("update: done.", out)
        self.assertEqual((hub / "BUILD_ID").read_text().strip(), mb.compute_build_id(files))
        self.assertEqual((hub / "data" / "data.json").read_bytes(), data_before, "data untouched")
        self.assertFalse((hub / "TESTS_RAN_HERE").exists(), "the installed code is not the tree the tests ran in")
        self.assertEqual((hub / "public" / "index.html").read_bytes(), files["public/index.html"])
        stamps = [p.name for p in backups.iterdir() if p.is_dir()]
        self.assertEqual(len(stamps), 1, stamps)
        self.assertEqual((backups / stamps[0] / "swap.journal").read_text().splitlines()[-1], "complete")
        if POSIX_PERMS:
            self.assertEqual(loose(), [], "after an update everything is private (0600/0700)")
        r = self.bash(HUB / "deploy" / "update.sh", "--rollback", env=env, timeout=300)
        out = r.stdout.decode() + r.stderr.decode()
        self.assertEqual(r.returncode, 0, out)
        self.assertIn(f"rollback: done. Running the code saved at {stamps[0]}.", out)
        self.assertFalse((hub / "BUILD_ID").exists(), "the old code is back")
        self.assertEqual((hub / "data" / "data.json").read_bytes(), data_before, "data untouched")
        if POSIX_PERMS:
            self.assertEqual(loose(), [], "after a rollback everything is private too")
        # An unpacked folder works too, and the tests run in a copy of it, never in the folder itself.
        with zipfile.ZipFile(bundle) as z:
            z.extractall(self.root / "unpacked")
        unpacked = self.root / "unpacked" / "fitness-hub"
        r = self.bash(HUB / "deploy" / "update.sh", to_bash_path(unpacked), env=env, timeout=300)
        out = r.stdout.decode() + r.stderr.decode()
        self.assertEqual(r.returncode, 0, out)
        self.assertFalse((unpacked / "TESTS_RAN_HERE").exists(), "the given folder is left as it was")
        self.assertFalse((hub / "TESTS_RAN_HERE").exists())
        self.assertEqual((hub / "public" / "index.html").read_bytes(), files["public/index.html"])
        self.assertEqual((hub / "data" / "data.json").read_bytes(), data_before, "data untouched")
        if POSIX_PERMS:
            self.assertEqual(loose(), [], "an update from a folder leaves everything private too")

    def test_update_enables_the_service_and_fails_closed(self):
        """update.sh's systemd steps, with a stand-in systemctl and a unit name of the test's own (so the
        real service can never be named): step 4 enables the unit before it starts it, and when the
        previous code also fails its verification after a rollback, the unit is disabled and stopped."""
        mb = load_module("make_bundle_fc", HUB / "deploy" / "make_bundle.py")
        bindir = self.root / "bin"
        bindir.mkdir()
        fake = write_fake_systemctl(bindir)
        unit = f"fitness-hub-test-{os.getpid()}.service"
        unit_text = b"[Service]\nExecStart=/bin/true\n"
        hub = self.root / "fitness-hub"
        old_server = b"# the old code\nimport sys\nsys.exit(0)\n"

        def old_tree():
            if hub.exists():
                shutil.rmtree(hub)
            (hub / "deploy").mkdir(parents=True)
            (hub / "data").mkdir()
            (hub / "data" / "data.json").write_text('{"schema_version": 1}')
            (hub / "server.py").write_bytes(old_server)
            (hub / "deploy" / "verify.sh").write_text('exit "${OLD_VERIFY_RC:-0}"\n', newline="\n")
            for name in (unit, "fitness-hub.service"):
                (hub / "deploy" / name).write_bytes(unit_text)

        files = {"server.py": b"import sys\nprint('check: all good')\nsys.exit(0)\n",
                 "public/index.html": b"<title>Fitness Hub</title>", "public/js/app.js": b"export const ok = 1;\n",
                 "deploy/fitness-hub.service": unit_text, f"deploy/{unit}": unit_text,
                 "deploy/verify.sh": b'exit "${NEW_VERIFY_RC:-0}"\n',
                 "deploy/update.sh": (HUB / "deploy" / "update.sh").read_bytes(),
                 "deploy/check_imports.py": (HUB / "deploy" / "check_imports.py").read_bytes(),
                 "tests/test_server.py": b"print('Ran 1 test in 0.0s')\nprint('OK')\n"}
        bundle = self.root / "bundle.zip"
        mb.write_bundle(bundle, files, mb.compute_build_id(files))
        harness = self.root / "harness.sh"
        harness.write_text(
            'source "$UPDATE_SH"\n'  # main doesn't run when sourced
            'SYSTEMD=1\n'
            'PY="$HARNESS_PY"\n'
            'UNIT="$HARNESS_UNIT"\n'
            'systemctl() { "$FAKE_SYSTEMCTL" "$@"; }\n'  # the stand-in, whatever is on PATH
            'trap cleanup EXIT\n'
            "trap 'on_error $LINENO' ERR\n"
            'trap on_signal INT TERM HUP\n'
            'do_update "$HARNESS_BUNDLE"\n', encoding="utf-8", newline="\n")
        log = self.root / "systemctl.log"
        env = clean_env(PATH=str(bindir) + os.pathsep + os.environ.get("PATH", ""), HOME=to_bash_path(self.root),
                        FITNESS_HUB_TESTING="1", FITNESS_HUB_DIR=to_bash_path(hub),
                        FITNESS_HUB_BACKUP_ROOT=to_bash_path(self.root / "backups"),
                        UPDATE_SH=to_bash_path(HUB / "deploy" / "update.sh"), HARNESS_PY=to_bash_path(Path(sys.executable)),
                        HARNESS_UNIT=unit, HARNESS_BUNDLE=to_bash_path(bundle), FAKE_SYSTEMCTL=to_bash_path(fake),
                        FAKE_SYSTEMCTL_LOG=to_bash_path(log))

        def run(**extra):
            old_tree()
            if log.exists():
                log.unlink()
            r = subprocess.run([BASH, to_bash_path(harness)], env=dict(env, **extra), capture_output=True,
                               timeout=300, stdin=subprocess.DEVNULL)
            calls = log.read_text().splitlines() if log.exists() else []
            return r.returncode, r.stdout.decode() + r.stderr.decode(), calls

        enable, start = f"systemctl --user enable --quiet {unit}", f"systemctl --user start {unit}"
        off = f"systemctl --user disable --now --quiet {unit}"
        code, out, calls = run()  # a good update
        self.assertEqual(code, 0, out)
        self.assertIn("[ OK ] Service enabled (starts at boot) and started", out)
        self.assertIn(enable, calls)
        self.assertLess(calls.index(enable), calls.index(start), "enabled before it starts")
        self.assertNotIn(off, calls)
        self.assertTrue(all(unit in call or call == "systemctl --user daemon-reload" for call in calls), calls)
        code, out, calls = run(NEW_VERIFY_RC="1")  # the new code fails verification; the old code passes
        self.assertEqual(code, 1, out)
        self.assertIn("update.sh: failed and rolled back; data/ was not touched", out)
        self.assertNotIn(off, calls)
        self.assertEqual(calls[-1], start, "the previous code runs again, enabled")
        last_stop = len(calls) - 1 - calls[::-1].index(f"systemctl --user stop {unit}")
        self.assertIn(enable, calls[last_stop:], "the rollback enables the unit too")
        self.assertEqual((hub / "server.py").read_bytes(), old_server, "the previous code is back")
        code, out, calls = run(NEW_VERIFY_RC="1", OLD_VERIFY_RC="1")  # and both fail: fail closed
        self.assertEqual(code, 1, out)
        self.assertIn("the previous code (put back) failed to start or to pass its verification", out)
        self.assertIn("so the hub was stopped and disabled (fail closed)", out)
        self.assertEqual(calls[-1], off, calls)
        self.assertEqual((hub / "server.py").read_bytes(), old_server)
        self.assertEqual((hub / "data" / "data.json").read_text(), '{"schema_version": 1}', "data untouched")

    def test_backup_needs_data_json_and_never_leaves_a_failing_timer(self):
        bindir = self.root / "fake-systemctl-bin"
        bindir.mkdir()
        write_fake_systemctl(bindir)
        hub = self.private_hub_dir()
        dest = self.root / "dest"
        dest.mkdir()
        state = self.root / "state"
        units = self.root / ".config" / "systemd" / "user"
        log = self.root / "systemctl.log"
        env = clean_env(PATH=str(bindir) + os.pathsep + os.environ.get("PATH", ""), HOME=to_bash_path(self.root),
                        FITNESS_HUB_TESTING="1", FITNESS_HUB_DIR=to_bash_path(hub),
                        FITNESS_HUB_STATE_DIR=to_bash_path(state), FAKE_SYSTEMCTL_LOG=to_bash_path(log))
        found = subprocess.run([BASH, "-c", "command -v systemctl"], env=env, capture_output=True, timeout=30)
        self.assertTrue(found.stdout.decode().strip().endswith("/fake-systemctl-bin/systemctl"),
                        ("never the real systemctl", found))
        script, target = HUB / "deploy" / "backup.sh", bash_abs(dest)
        for args in ((target,), ("--install-timer", target)):  # no data.json yet: refused, nothing written
            r = self.bash(script, *args, env=env)
            self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
            self.assertIn(b"data.json yet", r.stderr, args)
        self.assertEqual(list(dest.iterdir()), [], "no archive and no marker")
        self.assertFalse(units.exists() and any(units.iterdir()), "no timer")
        (hub / "data" / "data.json").write_text(json.dumps(server.default_data()))
        state.mkdir(exist_ok=True)  # the refused one-off run above recorded its failure there
        status = "ok 2026-11-20T03:30:00+00:00 fitness-hub-data-20261120-033000.tar.gz\n"
        (state / "backup-status").write_text(status)
        r = self.bash(script, "--install-timer", target, env=dict(env, FAKE_SYSTEMCTL_FAIL_START="1"))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn(b"no timer was installed", r.stderr)
        self.assertEqual(sorted(p.name for p in units.iterdir()), [], "both unit files were taken out again")
        self.assertEqual((state / "backup-status").read_text(), status, "the status is as it was")
        calls = log.read_text().splitlines()
        self.assertFalse(any("enable" in call for call in calls), calls)
        log.unlink()
        r = self.bash(script, "--install-timer", target, env=env)  # a first run that works
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        calls = log.read_text().splitlines()
        first_run = calls.index("systemctl --user start fitness-hub-backup.service")
        self.assertLess(first_run, calls.index("systemctl --user enable --now fitness-hub-backup.timer"),
                        "the timer is enabled only after its first run worked")
        self.assertEqual(sorted(p.name for p in units.iterdir()),
                         ["fitness-hub-backup.service", "fitness-hub-backup.timer"])
        r = self.bash(script, "--install-timer", target, env=env)
        self.assertEqual(r.returncode, 1)
        self.assertIn(b"already installed", r.stderr, "never replaced silently: --remove-timer first")


@unittest.skipUnless(os.name == "nt", "connect_from_pc.bat is for Windows")
class WindowsTunnelScriptTests(unittest.TestCase):
    """connect_from_pc.bat with a PATH of System32 only (the real OpenSSH lives in System32\\OpenSSH,
    so it can't run), plus a fake ssh.bat where a test needs one. Nothing contacts another host."""

    BAT = HUB / "deploy" / "connect_from_pc.bat"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)
        self.system32 = str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32")

    def tearDown(self):
        self.tmp.cleanup()

    def run_bat(self, *args, path=None, testing=True, timeout=90, **extra):
        env = clean_env(PATH=path or self.system32, **extra)
        if testing:
            env["FITNESS_HUB_TESTING"] = "1"
        r = subprocess.run(["cmd.exe", "/d", "/c", str(self.BAT), *args], env=env, capture_output=True,
                           timeout=timeout, stdin=subprocess.DEVNULL)
        return r.returncode, (r.stdout + r.stderr).decode("utf-8", "replace")

    def fake_ssh(self, port: int) -> tuple[str, Path]:
        bindir = self.root / "bin"
        bindir.mkdir(exist_ok=True)
        argfile = self.root / "ssh-args.txt"
        tunnel = write_fake_tunnel(self.root)
        (bindir / "ssh.bat").write_text(
            f'@echo off\r\necho %*> "{argfile}"\r\n"{sys.executable}" "{tunnel}" {port} 1.0\r\n', encoding="ascii")
        return f"{bindir};{self.system32}", argfile

    def test_guards(self):
        code, out = self.run_bat("alex@homeserver", "1000")
        self.assertEqual(code, 1, out)
        self.assertIn("ssh was not found", out)
        path, argfile = self.fake_ssh(free_port())
        for server in ("-oProxyCommand=evil", "alex@home server", "user/host"):
            code, out = self.run_bat(server, "1000", path=path)
            self.assertEqual(code, 1, (server, out))
            self.assertIn("doesn't look like user@host", out, server)
        code, out = self.run_bat("alex@homeserver", "12a", path=path)
        self.assertEqual(code, 1, out)
        self.assertIn("must be a number", out)
        port = free_port()
        holder = socket.socket()
        holder.bind(("127.0.0.1", port))
        holder.listen(1)
        try:
            code, out = self.run_bat("alex@homeserver", "1000", path=path, FITNESS_HUB_LOCAL_PORT=str(port))
        finally:
            holder.close()
        self.assertEqual(code, 1, out)
        self.assertIn("already in use", out)
        code, out = self.run_bat("alex@homeserver", "1000", path=path, testing=False, FITNESS_HUB_LOCAL_PORT="1")
        self.assertIn("for the tests only", out)
        self.assertFalse(argfile.exists(), "ssh never ran for a refused request")

    def test_browser_opens_only_after_the_tunnel_answers(self):
        port = free_port()
        path, argfile = self.fake_ssh(port)
        started = time.monotonic()
        code, out = self.run_bat("--", "alex@homeserver", "1000", path=path, FITNESS_HUB_LOCAL_PORT=str(port),
                                 FITNESS_HUB_OPEN_CMD="echo OPENED")
        self.assertIn(f"OPENED http://127.0.0.1:{port}/", out)
        self.assertGreater(time.monotonic() - started, 1.0)
        args = argfile.read_text(encoding="ascii")
        self.assertIn(f"-L 127.0.0.1:{port}:/run/user/1000/fitness-hub/hub.sock", args)
        self.assertIn('-- "alex@homeserver"', args, "the login comes after --")


if __name__ == "__main__":
    unittest.main(verbosity=2)
