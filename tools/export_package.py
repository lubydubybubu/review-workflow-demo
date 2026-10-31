#!/usr/bin/env python3
"""Export the public package by a fixed allowlist (tools/PUBLIC_FILES.txt) — nothing else is ever copied.

    python3 -B tools/export_package.py --dest <new dir> [--archive <new .tar.gz>] [--source <package root>]
                                       [--allowlist <file>]

Refuses (exit 2, nothing written) when:
  - the destination (or archive) already exists
  - an allowlisted file is missing, is a symlink, sits under a symlinked directory, or is not a regular file
  - an allowlisted path is absolute, escapes the source, or matches an always-excluded pattern
    (dependency/build dirs, VCS metadata, caches, logs, env/secret files)
Files present in the source but not allowlisted are simply not exported. After copying, every exported file is
re-read and compared byte for byte with its source. The optional archive is deterministic (sorted, fixed mtime,
uid/gid 0, regular files only).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import sys
import tarfile
from pathlib import Path, PurePosixPath

PACKAGE = Path(__file__).resolve().parent.parent
ALLOWLIST = PACKAGE / "tools" / "PUBLIC_FILES.txt"
ARCHIVE_PREFIX = "review-workflow-demo"
# `.github` stays excluded except for exactly one root path: the tests-only CI workflow `.github/workflows/ci.yml`.
EXCLUDED = re.compile(
    r"^\.github(?!/workflows/ci\.yml$)(/|$)|/\.github(/|$)"
    r"|(^|/)(node_modules|\.next|\.git|__pycache__|\.pytest_cache|\.venv|logs?|runtime|secrets)(/|$)"
    r"|(^|/)\.env(\..*)?$|\.(log|pyc|pem|key|sqlite|db)$|(^|/)\.DS_Store$"
)
FIXED_MTIME = 1767225600  # 2026-01-01T00:00:00Z, so archive bytes do not depend on the export time


class Refused(Exception):
    pass


def read_allowlist(path: Path) -> list[str]:
    entries = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        entries.append(line)
    if len(entries) != len(set(entries)):
        raise Refused("allowlist has duplicate entries")
    return entries


def check_entry(source: Path, rel: str) -> Path:
    pure = PurePosixPath(rel)
    if pure.is_absolute() or ".." in pure.parts or rel != str(pure):
        raise Refused(f"unsafe allowlist path: {rel}")
    if EXCLUDED.search(rel):
        raise Refused(f"allowlisted path matches an always-excluded pattern: {rel}")
    cur = source
    for part in pure.parts:
        cur = cur / part
        if cur.is_symlink():
            raise Refused(f"symlink in allowlisted path: {rel}")
    if not cur.exists():
        raise Refused(f"allowlisted file is missing: {rel}")
    if not cur.is_file():
        raise Refused(f"allowlisted path is not a regular file: {rel}")
    return cur


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def export(source: Path, allowlist: Path, dest: Path, archive: Path | None = None) -> dict:
    if dest.exists() or dest.is_symlink():
        raise Refused(f"destination already exists: {dest}")
    if archive is not None and (archive.exists() or archive.is_symlink()):
        raise Refused(f"archive already exists: {archive}")
    entries = sorted(read_allowlist(allowlist))
    files = [(rel, check_entry(source, rel)) for rel in entries]  # validate everything before writing anything
    dest.mkdir(parents=True)
    out = []
    for rel, src in files:
        data = src.read_bytes()
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "xb") as fh:
            fh.write(data)
        if target.read_bytes() != data:
            raise Refused(f"byte mismatch after copy: {rel}")
        out.append({"path": rel, "bytes": len(data), "sha256": sha256(data)})
    result = {"files": len(out), "manifest": out,
              "manifest_sha256": sha256(json.dumps(out, sort_keys=True).encode())}
    if archive is not None:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tf:
            for item in out:
                data = (dest / item["path"]).read_bytes()
                info = tarfile.TarInfo(f"{ARCHIVE_PREFIX}/{item['path']}")
                info.size, info.mtime, info.mode = len(data), FIXED_MTIME, 0o644
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                tf.addfile(info, io.BytesIO(data))
        with open(archive, "xb") as fh:
            with gzip.GzipFile(fileobj=fh, mode="wb", mtime=FIXED_MTIME, filename="") as gz:
                gz.write(buf.getvalue())
        result["archive"] = {"bytes": archive.stat().st_size, "sha256": sha256(archive.read_bytes()), "members": len(out)}
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dest", required=True, type=Path)
    ap.add_argument("--archive", type=Path)
    ap.add_argument("--source", type=Path, default=PACKAGE)
    ap.add_argument("--allowlist", type=Path)
    a = ap.parse_args(argv)
    source = a.source.resolve()
    allowlist = a.allowlist or source / "tools" / "PUBLIC_FILES.txt"
    try:
        result = export(source, allowlist, a.dest.absolute(), a.archive.absolute() if a.archive else None)
    except Refused as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    print(json.dumps({k: v for k, v in result.items() if k != "manifest"}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
