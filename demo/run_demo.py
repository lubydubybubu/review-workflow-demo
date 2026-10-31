#!/usr/bin/env python3
"""Reproducible local demo: synthetic mail candidate -> human approval in the real UI -> review / calendar.

    python3 -B demo/run_demo.py --output-dir <new dir outside this package> \
        --node <node binary> --node-modules <installed app node_modules> \
        --pg-bin <PostgreSQL bin dir with initdb/pg_ctl> --chrome <Chrome binary> \
        [--tmp-root <short dir>] [--font-dir <dir with pretendard.css + pretendard/*.woff2>] \
        [--app-port 55885] [--pg-port 55485]

Every tool path can also come from the environment: RWD_NODE, RWD_NODE_MODULES, RWD_PG_BIN, RWD_CHROME,
RWD_TMP_ROOT, RWD_FONT_DIR. Nothing host-specific is built in; a missing tool refuses the run.

What it does (all loopback, all disposable, all under --output-dir plus one short-lived rwd-* directory under
--tmp-root; the package and the dependency dir are never written):
  1. checks the fixture's declared source hashes, then hashes the whole package and records the dependency dir
  2. copies the app into <out>/runtime/app; its node_modules is an owned directory of links to the dependency
     dir's packages, so tool caches written at the node_modules root (.vite, .vite-temp, .vitest-cache) stay owned
  3. initdb + starts an owned PostgreSQL on 127.0.0.1:<pg-port>, migrates with the app's own script
  4. builds and starts the app with `next start` on 127.0.0.1:<app-port> (demo-password sign-in)
  5. POSTs the synthetic candidates with the producer (producer/post_candidates.py)
  6. checks the boundary in the DB: no review/brand exists before a person decides
  7. drives real Chrome (sandbox on): log in, open the inbox, click 리뷰로 등록, submit
  8. POSTs the same-thread follow-up, then screenshots inbox / review / calendar / dashboard
  9. runs the offline replay kit + its tests, and the app's vitest suites (unit + integration on the owned PG)
 10. stops every child it started, removes the cluster and secrets, re-hashes the package and re-checks that
     the dependency dir's entries (paths, link targets, sizes, mtimes) are unchanged
Writes <out>/evidence.json and logs/. Exit 0 only when every check passed.
Never overwrites: --output-dir must not exist yet.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent
APP_SRC = PACKAGE / "app"
PRODUCER = PACKAGE / "producer" / "post_candidates.py"
EVAL_SRC = PACKAGE / "offline-eval"
APP_ROLE = "ops_app_demo"
FIXTURES = HERE / "fixtures" / "candidates.json"
TOOL_ENV = {"node": "RWD_NODE", "node_modules": "RWD_NODE_MODULES", "pg_bin": "RWD_PG_BIN", "chrome": "RWD_CHROME",
            "tmp_root": "RWD_TMP_ROOT", "font_dir": "RWD_FONT_DIR"}
REQUIRED_TOOLS = ("node", "node_modules", "pg_bin", "chrome")
# every PNG the walkthrough must produce, by browser phase; a run missing any of them is FAIL
REQUIRED_SCREENSHOTS = {
    "approve": ("01-mail-inbox-pending.png", "02-approval-form.png", "03-after-approval.png"),
    "after": ("04-mail-followup-duplicate.png", "05-review-detail.png", "06-calendar-2026-11.png", "07-dashboard.png"),
}
# dot entries of the dependency dir that are linked into the runtime node_modules; every other dot entry is a
# tool cache (.vite, .vite-temp, .vitest-cache, .cache, ...) that must be created fresh in the owned directory
LINKED_DOT_ENTRIES = (".bin",)


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest(root: Path, skip: tuple[str, ...] = ()) -> dict[str, str]:
    out = {}
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x != "__pycache__"]
        for name in files:
            p = Path(d) / name
            rel = str(p.relative_to(root))
            if rel.startswith(skip):
                continue
            out[rel] = "symlink" if p.is_symlink() else sha256_file(p)
    return dict(sorted(out.items()))


def manifest_digest(m: dict[str, str]) -> str:
    return hashlib.sha256(json.dumps(m, sort_keys=True).encode()).hexdigest()


def link_dependencies(deps: Path, dest: Path) -> list[str]:
    """Create `dest` as a real, owned node_modules whose package entries are links into the read-only `deps`."""
    dest.mkdir()
    linked = []
    for entry in sorted(os.listdir(deps)):
        if entry.startswith(".") and entry not in LINKED_DOT_ENTRIES:
            continue
        os.symlink(deps / entry, dest / entry)
        linked.append(entry)
    return linked


def dependency_snapshot(deps: Path) -> dict[str, str]:
    """Every entry of the dependency dir (links not followed): link target, or type + size + mtime_ns."""
    out = {}
    for d, dirs, files in os.walk(deps):
        for name in dirs + files:
            p = os.path.join(d, name)
            st = os.lstat(p)
            rel = os.path.relpath(p, deps)
            if os.path.islink(p):
                out[rel] = "link:" + os.readlink(p)
            elif os.path.isdir(p):
                out[rel] = "dir"
            else:
                out[rel] = f"file:{st.st_size}:{st.st_mtime_ns}"
    return dict(sorted(out.items()))


def snapshot_diff(before: dict[str, str], after: dict[str, str]) -> dict[str, list[str]]:
    return {"added": sorted(set(after) - set(before)), "deleted": sorted(set(before) - set(after)),
            "changed": sorted(k for k in set(before) & set(after) if before[k] != after[k])}


def port_busy(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def resolve_tools(args: argparse.Namespace | None = None, environ: dict | None = None) -> dict[str, Path | None]:
    """Explicit flag first, then RWD_* environment variable; no host default."""
    environ = os.environ if environ is None else environ
    tools: dict[str, Path | None] = {}
    for key, var in TOOL_ENV.items():
        value = getattr(args, key, None) if args is not None else None
        value = value or environ.get(var)
        tools[key] = Path(value).resolve() if value else None
    if tools["tmp_root"] is None:
        tools["tmp_root"] = Path(tempfile.gettempdir())
    return tools


def load_steps(section: str) -> list[dict]:
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    by_name = {s["name"]: s for s in data["steps"] + data["after_approval"] if "payload" in s}
    out = []
    for s in data[section]:
        if "payload" in s:
            payload = s["payload"]
        else:
            payload = json.loads(json.dumps(by_name[s["payload_from"]]["payload"]))
            payload.update(s.get("payload_override", {}))
        out.append({**s, "payload": payload})
    return out


def source_mismatches() -> list[str]:
    """Fixture steps whose declared source SHA-256 differs from the synthetic source file (or whose file is missing)."""
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    bad = []
    for s in data["steps"] + data["after_approval"]:
        src = EVAL_SRC / "corpus" / "sources" / s["source_file"]
        if not src.is_file() or sha256_file(src) != s.get("source_sha256"):
            bad.append(s["name"])
    return bad


def failed_assertions(res: dict) -> list[dict]:
    """Explicit browser assertions (those carrying a `passed` key) that did not pass."""
    return [{"step": st.get("name"), **a} for st in res.get("steps", []) for a in st.get("assertions", [])
            if "passed" in a and a["passed"] is not True]


class Demo:
    def __init__(self, out: Path, app_port: int, pg_port: int, tools: dict[str, Path | None] | None = None,
                 forbidden_ports: set[int] | None = None):
        self.out = out
        self.app_port = app_port
        self.pg_port = pg_port
        # ports reserved for other services on the machine: refused even when they look free
        self.forbidden_ports = set(forbidden_ports or ())
        self.tools = tools if tools is not None else resolve_tools(environ={})
        self.logs = out / "logs"
        self.shots = out / "screenshots"
        self.rt = out / "runtime"
        self.secrets = self.rt / "secrets"
        self.app = self.rt / "app"
        self.pgdata = self.rt / "pg" / "data"
        self.home = self.rt / "home"
        # short path: tsx/Chrome put unix sockets in TMPDIR (108-byte limit); removed in cleanup
        self.tmp = Path(tempfile.mkdtemp(prefix="rwd-", dir=self.tools["tmp_root"]))
        self.ev: dict = {
            "kind": "review-workflow-demo-run",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "argv": sys.argv,
            "app_port": app_port,
            "pg_port": pg_port,
            "commands": [],
            "checks": [],
            "first_failure": None,
        }
        self.server: subprocess.Popen | None = None
        self.pg_started = False
        self.base = f"http://127.0.0.1:{app_port}"

    # ---- helpers -------------------------------------------------------------------------------
    @property
    def node_bin(self) -> Path:
        return self.tools["node"]

    @property
    def pg_bin(self) -> Path:
        return self.tools["pg_bin"]

    def env(self, **extra: str) -> dict[str, str]:
        """A scrubbed environment: synthetic demo values only, nothing inherited."""
        e = {
            "PATH": f"{self.node_bin.parent if self.node_bin else '/nonexistent'}:/usr/bin:/bin",
            "HOME": str(self.home),
            "TMPDIR": str(self.tmp),
            "LANG": "C.UTF-8",
            "NEXT_TELEMETRY_DISABLED": "1",
            "DEMO_DEPS": str(self.tools["node_modules"]),
            "DEMO_CHROME": str(self.tools["chrome"]),
            "DEMO_PG_PORT": str(self.pg_port),
        }
        e.update(extra)
        return e

    def run(self, name: str, argv: list[str], *, env: dict, cwd: Path | None = None, stdin: bytes | None = None,
            timeout: int = 600, expect: int | None = 0) -> subprocess.CompletedProcess:
        t0 = time.time()
        log = self.logs / f"{len(self.ev['commands']):02d}-{name}.log"
        p = subprocess.run(argv, cwd=cwd, env=env, input=stdin, capture_output=True, timeout=timeout)
        log.write_bytes(b"$ " + " ".join(argv).encode() + b"\n--- stdout ---\n" + p.stdout + b"\n--- stderr ---\n" + p.stderr)
        rec = {"name": name, "argv": argv, "cwd": str(cwd) if cwd else None, "exit": p.returncode,
               "seconds": round(time.time() - t0, 1), "log": str(log.relative_to(self.out))}
        self.ev["commands"].append(rec)
        print(f"[{name}] exit {p.returncode} ({rec['seconds']}s)", flush=True)
        if expect is not None and p.returncode != expect:
            self.fail(f"command {name} exited {p.returncode}, expected {expect} (see {rec['log']})")
        return p

    def check(self, name: str, passed: bool, **detail) -> None:
        self.ev["checks"].append({"name": name, "passed": bool(passed), **detail})
        print(f"  check {name}: {'PASS' if passed else 'FAIL'}", flush=True)
        if not passed and self.ev["first_failure"] is None:
            self.ev["first_failure"] = name

    def fail(self, message: str) -> None:
        if self.ev["first_failure"] is None:
            self.ev["first_failure"] = message
        raise RuntimeError(message)

    def node(self, *args: str) -> list[str]:
        return [str(self.node_bin), "--max-old-space-size=768", *args]

    def db_state(self, label: str) -> dict:
        p = self.run(f"db-state-{label}", self.node(str(HERE / "db_tool.mjs"), "state"), env=self.db_env())
        state = json.loads(p.stdout.decode().strip().splitlines()[-1])
        self.ev.setdefault("db_states", {})[label] = state
        return state

    def db_env(self) -> dict:
        return self.env(DEMO_ADMIN_URL=self.admin_url, DEMO_DB_NAME=self.db_name, DEMO_APP_ROLE=APP_ROLE,
                        DEMO_APP_PASSWORD_FILE=str(self.secrets / "app-db-password"))

    def write_secret(self, name: str, value: str) -> Path:
        p = self.secrets / name
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(value + "\n")
        return p

    # ---- phases --------------------------------------------------------------------------------
    def preflight(self) -> None:
        for port in (self.app_port, self.pg_port):
            if port in self.forbidden_ports:
                self.fail(f"port {port} is forbidden")
            if port_busy(port):
                self.fail(f"port {port} is busy on 127.0.0.1; refusing to touch it")
        if bad := source_mismatches():
            self.fail(f"fixture source SHA-256 mismatch for {bad}; refusing to launch")
        for key in REQUIRED_TOOLS:
            if self.tools.get(key) is None:
                self.fail(f"missing tool --{key.replace('_', '-')} (or {TOOL_ENV[key]})")
        for p in (self.node_bin, self.tools["node_modules"] / "next", self.tools["node_modules"] / "playwright-core",
                  self.pg_bin / "initdb", self.pg_bin / "pg_ctl", self.tools["chrome"], PRODUCER, APP_SRC, EVAL_SRC):
            if not p.exists():
                self.fail(f"missing prerequisite {p}")
        if self.tools.get("font_dir") is not None and not (self.tools["font_dir"] / "pretendard.css").is_file():
            self.fail("--font-dir given but has no pretendard.css")
        self.ev["package_before"] = manifest(PACKAGE)
        self.ev["package_digest_before"] = {"files": len(self.ev["package_before"]),
                                            "sha256": manifest_digest(self.ev["package_before"])}
        self.ev["app_source_digest"] = manifest_digest(manifest(APP_SRC))
        self.ev["fixture_sha256"] = sha256_file(FIXTURES)
        self.ev["chrome_sha256"] = sha256_file(self.tools["chrome"])
        self.ev["tools"] = {k: str(v) if v else None for k, v in self.tools.items()}
        self.deps_before = dependency_snapshot(self.tools["node_modules"])
        self.ev["dependency_dir_before"] = {"entries": len(self.deps_before),
                                           "sha256": manifest_digest(self.deps_before)}
        for d in (self.logs, self.shots, self.secrets, self.home, self.pgdata.parent):
            d.mkdir(parents=True, exist_ok=True)
        os.chmod(self.secrets, 0o700)

    def runtime_copy(self) -> None:
        shutil.copytree(APP_SRC, self.app, symlinks=False)
        # runtime only, outside the package: a real directory, so nothing written at its root reaches the dependency dir
        linked = link_dependencies(self.tools["node_modules"], self.app / "node_modules")
        self.ev["runtime_node_modules"] = {"linked_entries": len(linked)}
        copy = {k: v for k, v in manifest(self.app).items() if not k.startswith("node_modules/")}
        self.check("runtime-app-copy-identical", copy == manifest(APP_SRC), files=len(copy))
        # the app's integration replay test runs the producer from the sibling directory, as in the package layout
        shutil.copytree(PRODUCER.parent, self.rt / "producer", ignore=shutil.ignore_patterns("__pycache__"))
        fonts = self.tools.get("font_dir")
        if fonts is not None:
            # optional locally supplied OFL font files (not part of the package), served same-origin
            dst = self.app / "public" / "fonts"
            dst.mkdir(parents=True)
            shutil.copy2(fonts / "pretendard.css", dst / "pretendard.css")
            if (fonts / "pretendard").is_dir():
                shutil.copytree(fonts / "pretendard", dst / "pretendard", symlinks=False)
            self.ev["runtime_fonts"] = {"files": len(manifest(dst)), "sha256": manifest_digest(manifest(dst))}

    def start_pg(self) -> None:
        pw = secrets.token_urlsafe(24)
        pwfile = self.write_secret("pg-superuser-password", pw)
        self.write_secret("app-db-password", secrets.token_urlsafe(24))
        self.run("initdb", [str(self.pg_bin / "initdb"), "-D", str(self.pgdata), "-U", "demo_admin", "--auth=scram-sha-256",
                            f"--pwfile={pwfile}", "-E", "UTF8", "--locale=C"], env=self.env())
        opts = f"-c listen_addresses=127.0.0.1 -p {self.pg_port} -c unix_socket_directories="
        self.run("pg-start", [str(self.pg_bin / "pg_ctl"), "-D", str(self.pgdata), "-l", str(self.logs / "postgres.log"),
                              "-o", opts, "-w", "-t", "60", "start"], env=self.env())
        self.pg_started = True
        pid = int((self.pgdata / "postmaster.pid").read_text().splitlines()[0])
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode()
        self.ev["pg"] = {"pid": pid, "cmdline": cmdline, "data_dir": str(self.pgdata), "port": self.pg_port, "listen": "127.0.0.1"}
        self.check("pg-owned", str(self.pgdata) in cmdline and str(self.pg_bin) in cmdline, pid=pid)
        self.db_name = f"ops_e2e_demo_{int(time.time())}"
        self.admin_url = f"postgres://demo_admin:{pw}@127.0.0.1:{self.pg_port}/postgres"
        p = self.run("db-setup", self.node(str(HERE / "db_tool.mjs"), "setup"), env=self.db_env())
        info = json.loads(p.stdout.decode().strip().splitlines()[-1])
        self.ev["pg"]["server"] = info["server"]
        app_pw = (self.secrets / "app-db-password").read_text().strip()
        self.app_db_url = f"postgres://{APP_ROLE}:{app_pw}@127.0.0.1:{self.pg_port}/{self.db_name}"
        mig_env = self.env(MIGRATION_DATABASE_URL=f"postgres://demo_admin:{pw}@127.0.0.1:{self.pg_port}/{self.db_name}")
        tsx = str(self.app / "node_modules" / "tsx" / "dist" / "cli.mjs")
        p1 = self.run("migrate-1", self.node(tsx, "scripts/migrate.ts", "--grant", APP_ROLE), env=mig_env, cwd=self.app)
        p2 = self.run("migrate-2-rerun", self.node(tsx, "scripts/migrate.ts", "--grant", APP_ROLE), env=mig_env, cwd=self.app)
        self.check("migrations-rerun-applies-nothing", b" 0 applied" in p2.stdout,
                   first=p1.stdout.decode().strip().splitlines()[-2:], rerun=p2.stdout.decode().strip().splitlines()[-2:])

    def build_and_start(self) -> None:
        build_env = self.env(NODE_OPTIONS="--max-old-space-size=768")
        next_bin = str(self.app / "node_modules" / "next" / "dist" / "bin" / "next")
        # Turbopack (the default) refuses a node_modules symlink that points outside the project root, so
        # the runtime copy is built with the webpack bundler Next also ships. The app config is unchanged.
        self.run("next-build-webpack", [str(self.node_bin), "--max-old-space-size=768", next_bin, "build", "--webpack"],
                 env=build_env, cwd=self.app, timeout=900)
        pw = secrets.token_urlsafe(18)
        self.write_secret("demo-owner-password", pw)
        hashed = hashlib.scrypt(pw.encode(), salt=(salt := os.urandom(16)), n=2**15, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)
        b64 = lambda b: __import__("base64").urlsafe_b64encode(b).decode().rstrip("=")
        token = secrets.token_urlsafe(32)
        self.write_secret("ingest-token", token)
        run_env = self.env(
            NODE_ENV="production",
            NODE_OPTIONS=f"--max-old-space-size=768 --import {(self.app / 'scripts' / 'peer-address.mjs').as_uri()}",
            DATABASE_URL=self.app_db_url,
            OPS_AUTH_MODE="demo-password",
            OPS_PASSWORD_HASH=f"scrypt:{2**15}:8:1:{b64(salt)}:{b64(hashed)}",
            OPS_PUBLIC_ORIGIN=self.base,
            OPS_INGEST_TOKEN_SHA256=hashlib.sha256(token.encode()).hexdigest(),
            OPS_INGEST_ALLOWED_HOST=f"127.0.0.1:{self.app_port}",
            OPS_INGEST_ALLOWED_CIDRS="127.0.0.1/32",
        )
        self.ev["app_env_keys"] = sorted(run_env)
        log = open(self.logs / "next-start.log", "wb")
        argv = [str(self.node_bin), next_bin, "start", "-H", "127.0.0.1", "-p", str(self.app_port)]
        self.server = subprocess.Popen(argv, cwd=self.app, env=run_env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.ev["commands"].append({"name": "next-start", "argv": argv, "pid": self.server.pid, "log": "logs/next-start.log"})
        for _ in range(120):
            if self.server.poll() is not None:
                self.fail(f"next start exited early with {self.server.returncode}")
            try:
                c = http.client.HTTPConnection("127.0.0.1", self.app_port, timeout=2)
                c.request("GET", "/api/health")
                r = c.getresponse()
                body = r.read().decode()
                if r.status == 200:
                    self.check("app-health", True, status=r.status, body=body[:200])
                    return
            except OSError:
                pass
            time.sleep(1)
        self.fail("app did not become healthy in 120 s")

    def raw_post(self, host: str, token: str, body: bytes) -> int:
        c = http.client.HTTPConnection("127.0.0.1", self.app_port, timeout=10)
        c.request("POST", "/api/ingest/mail-candidates", body=body,
                  headers={"Host": host, "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        r = c.getresponse()
        r.read()
        return r.status

    def produce(self, label: str, steps: list[dict]) -> None:
        env = self.env(OPS_INGEST_URL=self.base, OPS_INGEST_TOKEN_FILE=str(self.secrets / "ingest-token"))
        stdin = json.dumps([s["payload"] for s in steps], ensure_ascii=False).encode()
        p = self.run(f"producer-{label}", [sys.executable, "-B", str(PRODUCER)], env=env, stdin=stdin)
        lines = p.stdout.decode().splitlines()
        self.ev.setdefault("producer_output", {})[label] = lines
        for i, s in enumerate(steps, 1):
            line = next((l for l in lines if l.startswith(f"[{i}/{len(steps)}] {s['payload']['message_id']} ")), "")
            # producer prints `created id=N (status)` for 201 and `already stored id=N` for 200
            want = "created" if s["expect_result"] == "created" else "already stored"
            ok = f" {want} id=" in line and (f"({s['expect_status']})" in line if "expect_status" in s else True)
            self.check(f"producer-{s['scenario']}-{s['name']}", ok, line=line, expect=s["expect_result"])

    def ingest_boundary(self) -> None:
        good = (self.secrets / "ingest-token").read_text().strip()
        body = json.dumps(load_steps("steps")[0]["payload"]).encode()
        wrong = secrets.token_urlsafe(32)
        self.check("ingest-refuses-wrong-token", self.raw_post(f"127.0.0.1:{self.app_port}", wrong, body) == 401)
        self.check("ingest-refuses-wrong-host", self.raw_post(f"localhost:{self.app_port}", good, body) == 401)
        bad = json.loads(body)
        bad["approved"] = True
        self.check("ingest-refuses-unknown-key", self.raw_post(f"127.0.0.1:{self.app_port}", good, json.dumps(bad).encode()) == 400)

    def browser(self, phase: str, *extra: str) -> dict:
        self.run(f"browser-{phase}", self.node(str(HERE / "browser_walkthrough.mjs"), phase, self.base, str(self.shots),
                                               str(self.secrets / "demo-owner-password"), *extra),
                 env=self.env(), timeout=240, expect=None)
        res = json.loads((self.shots / f"browser-{phase}.json").read_text())
        self.ev.setdefault("browser", {})[phase] = res
        failed = failed_assertions(res)
        missing = [f for f in REQUIRED_SCREENSHOTS.get(phase, ()) if not (self.shots / f).is_file()]
        ok = res.get("ok") is True and not res.get("blocked_requests") and not failed and not missing
        self.check(f"browser-{phase}", ok, error=res.get("error"), blocked=res.get("blocked_requests"),
                   failed_assertions=failed, missing_screenshots=missing)
        if not ok:
            self.fail(f"browser phase {phase} failed")
        return res

    def offline_eval(self) -> None:
        copy = self.rt / "offline-eval"
        shutil.copytree(EVAL_SRC, copy, ignore=shutil.ignore_patterns("__pycache__"))
        self.check("offline-eval-copy-identical", manifest(copy) == manifest(EVAL_SRC))
        env = self.env(PYTHONDONTWRITEBYTECODE="1")
        r = self.run("offline-eval-replay", [sys.executable, "-B", "replay.py"], env=env, cwd=copy, expect=None)
        self.check("offline-eval-replay-exit-0", r.returncode == 0, exit=r.returncode)
        t = self.run("offline-eval-unittest", [sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                     env=env, cwd=copy, expect=None)
        tail = t.stderr.decode().strip().splitlines()[-3:]
        self.check("offline-eval-unittest-exit-0", t.returncode == 0, exit=t.returncode, tail=tail)

    def app_tests(self) -> None:
        """The app's own vitest suites, in the runtime copy; integration uses a generated DB on the owned server."""
        vitest = str(self.app / "node_modules" / "vitest" / "vitest.mjs")
        env = self.env(NODE_OPTIONS="--max-old-space-size=768",
                       TEST_DATABASE_URL=self.admin_url, TEST_DB_ALLOWED_PORT=str(self.pg_port))
        for project in ("unit", "integration"):
            t = self.run(f"app-vitest-{project}", self.node(vitest, "run", "--project", project, "--no-color"),
                         env=env, cwd=self.app, timeout=900, expect=None)
            lines = [l.strip() for l in t.stdout.decode(errors="replace").splitlines() if l.strip().startswith(("Test Files", "Tests"))]
            self.check(f"app-vitest-{project}-exit-0", t.returncode == 0, exit=t.returncode, summary=lines[-2:])

    # ---- main flow -----------------------------------------------------------------------------
    def main(self) -> None:
        self.preflight()
        self.runtime_copy()
        self.start_pg()
        s0 = self.db_state("after-migrate")
        self.check("fresh-db-empty", s0["counts"] == {"reviews": 0, "brands": 0, "tasks": 0, "mail_candidates": 0}, counts=s0["counts"])
        self.build_and_start()
        self.ingest_boundary()
        self.produce("initial", load_steps("steps"))
        s1 = self.db_state("after-ingest")
        cands = {c["message_id"]: c for c in s1["candidates"]}
        self.check("boundary-no-review-before-human", s1["counts"]["reviews"] == 0 and s1["counts"]["brands"] == 0, counts=s1["counts"])
        self.check("candidates-pending", [c["status"] for c in s1["candidates"]] == ["pending", "pending"], candidates=s1["candidates"])
        self.check("resend-did-not-change-subject",
                   cands.get("00000a0f0e5b0001", {}).get("subject") == "[Review request] Lumora Arc 2 desk lamp loan review")

        self.browser("approve")
        s2 = self.db_state("after-click")
        lum = cands["00000a0f0e5b0001"]["id"]
        acc = next(c for c in s2["candidates"] if c["id"] == lum)
        self.check("click-created-exactly-one-review", s2["counts"]["reviews"] == 1 and s2["counts"]["brands"] == 1, counts=s2["counts"])
        self.check("candidate-accepted-and-linked", acc["status"] == "accepted" and acc["review_id"] == s2["reviews"][0]["id"], candidate=acc)
        rev = s2["reviews"][0]
        exp = json.loads(FIXTURES.read_text())["human_decision"]["expected_review"]
        self.check("review-matches-human-decision", all(rev[k] == v for k, v in exp.items()), review=rev, expected=exp)
        self.check("pellwick-still-pending", next(c for c in s2["candidates"] if c["message_id"] == "00000a0f0e5b0004")["status"] == "pending")

        self.produce("followup", load_steps("after_approval"))
        s3 = self.db_state("after-followup")
        fu = next(c for c in s3["candidates"] if c["message_id"] == "00000a0f0e5b0002")
        self.check("followup-duplicate-of-existing-review", fu["status"] == "duplicate" and fu["review_id"] == rev["id"], candidate=fu)
        self.check("followup-created-no-review", s3["counts"]["reviews"] == 1 and s3["counts"]["tasks"] == 0, counts=s3["counts"])

        self.browser("after", str(rev["id"]))
        self.offline_eval()
        self.app_tests()

    def cleanup(self) -> None:
        rec: dict = {}
        if self.server and self.server.poll() is None:
            pgid = os.getpgid(self.server.pid)
            os.killpg(pgid, signal.SIGTERM)
            try:
                self.server.wait(20)
            except subprocess.TimeoutExpired:
                os.killpg(pgid, signal.SIGKILL)
                self.server.wait(10)
            rec["next_pid"] = self.server.pid
        if self.server:
            time.sleep(1)
            rec["next_group_left"] = [p for p in os.listdir("/proc") if p.isdigit() and self._pgid(int(p)) == self.server.pid]
            rec["next_exit"] = self.server.returncode
        if self.pg_started:
            pid = self.ev.get("pg", {}).get("pid")
            cmd = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode() if pid and Path(f"/proc/{pid}").exists() else ""
            rec["pg_pid"] = pid
            rec["pg_pid_verified_before_stop"] = bool(pid) and str(self.pgdata) in cmd
            if rec["pg_pid_verified_before_stop"]:
                p = subprocess.run([str(self.pg_bin / "pg_ctl"), "-D", str(self.pgdata), "-m", "fast", "-w", "stop"],
                                   env=self.env(), capture_output=True, timeout=60)
                rec["pg_stop_exit"] = p.returncode
            rec["pg_pid_gone"] = not Path(f"/proc/{pid}").exists() if pid else None
            if rec.get("pg_pid_gone"):
                shutil.rmtree(self.pgdata.parent)
                rec["pg_cluster_removed"] = True
        rec["app_port_free"] = not port_busy(self.app_port)
        rec["pg_port_free"] = not port_busy(self.pg_port)
        if self.secrets.exists():
            shutil.rmtree(self.secrets)
            rec["secrets_removed"] = True
        owned_nm = self.app / "node_modules"
        if owned_nm.is_dir() and not owned_nm.is_symlink():
            # tool caches the run created in the owned node_modules (removed with the runtime copy below)
            rec["runtime_tool_caches"] = {e.name: sum(len(f) for _, _, f in os.walk(e)) for e in sorted(owned_nm.iterdir())
                                          if e.name.startswith(".") and not e.is_symlink()}
        for d, key in ((self.app, "runtime_app_removed"), (self.rt / "offline-eval", "runtime_offline_eval_removed"),
                       (self.rt / "producer", "runtime_producer_removed")):
            if d.exists():
                shutil.rmtree(d)  # runtime copies + .next build output (node_modules is a link only)
                rec[key] = True
        for d in (self.tmp, self.home):
            shutil.rmtree(d, ignore_errors=True)
        after = manifest(PACKAGE)
        rec["package_unchanged"] = after == self.ev.get("package_before")
        rec["package_digest_after"] = {"files": len(after), "sha256": manifest_digest(after)}
        if getattr(self, "deps_before", None) is not None:
            diff = snapshot_diff(self.deps_before, dependency_snapshot(self.tools["node_modules"]))
            rec["dependency_dir_unchanged"] = not any(diff.values())
            self.check("dependency-dir-unchanged", rec["dependency_dir_unchanged"],
                       **{k: {"count": len(v), "first": v[:20]} for k, v in diff.items()})
        self.ev["cleanup"] = rec

    @staticmethod
    def _pgid(pid: int) -> int | None:
        try:
            return os.getpgid(pid)
        except OSError:
            return None

    def finish(self, error: str | None) -> int:
        for f in sorted(self.shots.glob("*.png")):
            self.ev.setdefault("screenshots", []).append({"file": f"screenshots/{f.name}", "sha256": sha256_file(f), "bytes": f.stat().st_size})
        self.ev.pop("package_before", None)
        self.ev["error"] = error
        self.ev["finished_at"] = datetime.now(timezone.utc).isoformat()
        c = self.ev.get("cleanup", {})
        clean = (bool(c.get("package_unchanged")) and c.get("app_port_free") and c.get("pg_port_free")
                 and not c.get("next_group_left") and c.get("dependency_dir_unchanged") is not False)
        passed = sum(1 for k in self.ev["checks"] if k["passed"])
        present = {Path(s["file"]).name for s in self.ev.get("screenshots", [])}
        missing = [f for files in REQUIRED_SCREENSHOTS.values() for f in files if f not in present]
        self.ev["summary"] = {"checks_passed": passed, "checks_total": len(self.ev["checks"]),
                              "screenshots": len(self.ev.get("screenshots", [])), "missing_screenshots": missing,
                              "cleanup_ok": bool(clean)}
        ok = error is None and passed == len(self.ev["checks"]) and clean and not missing
        self.ev["outcome"] = "PASS" if ok else "FAIL"
        (self.out / "evidence.json").write_text(json.dumps(self.ev, indent=2, ensure_ascii=False) + "\n")
        print(f"outcome {self.ev['outcome']}: {passed}/{len(self.ev['checks'])} checks, cleanup_ok={clean}", flush=True)
        return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--output-dir", required=True, type=Path)
    ap.add_argument("--app-port", type=int, default=55885)
    ap.add_argument("--pg-port", type=int, default=55485)
    for key, var in TOOL_ENV.items():
        ap.add_argument(f"--{key.replace('_', '-')}", dest=key, help=f"(or ${var})")
    ap.add_argument("--forbid-port", type=int, action="append", default=[],
                    help="port that must never be used (repeatable; or $RWD_FORBIDDEN_PORTS, comma separated)")
    a = ap.parse_args(argv)
    forbidden = set(a.forbid_port) | {int(p) for p in os.environ.get("RWD_FORBIDDEN_PORTS", "").split(",") if p.strip()}
    if {a.app_port, a.pg_port} & forbidden:
        print("refusing: a requested port is in the forbidden set", file=sys.stderr)
        return 2
    out = a.output_dir.resolve()
    if out.exists():
        print(f"refusing: {out} already exists (never overwritten)", file=sys.stderr)
        return 2
    if out == PACKAGE or PACKAGE in out.parents:
        print("refusing: --output-dir must be outside the package", file=sys.stderr)
        return 2
    tools = resolve_tools(a)
    missing = [k for k in REQUIRED_TOOLS if tools[k] is None]
    if missing:
        print(f"refusing: missing tool paths {missing} (flags or {[TOOL_ENV[k] for k in missing]})", file=sys.stderr)
        return 2
    out.mkdir(parents=True)
    demo = Demo(out, a.app_port, a.pg_port, tools, forbidden)
    error = None
    try:
        demo.main()
    except Exception as e:  # noqa: BLE001 - recorded in evidence, then cleanup always runs
        error = f"{type(e).__name__}: {e}"
        print(f"ERROR {error}", file=sys.stderr, flush=True)
    finally:
        demo.cleanup()
    return demo.finish(error)


if __name__ == "__main__":
    sys.exit(main())
