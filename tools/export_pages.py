#!/usr/bin/env python3
"""Export ONLY the static simulator (web-demo/) as a GitHub Pages payload, by a fixed allowlist.

    python3 -B tools/export_pages.py --dest <new dir> [--source <package root>] [--allowlist <file>]

The payload is the allowlisted web-demo files at the destination root plus an empty `.nojekyll` — nothing
from app/, server code, fixtures, docs, tools, reports, credentials, VCS metadata or dependencies.
Refuses (exit 2, nothing written) when:
  - the destination already exists (it must be absent; it is never merged or overwritten)
  - an allowlist entry is not directly under web-demo/, has a non-static suffix, is absolute, escapes the
    source, matches an always-excluded pattern, is missing, is a symlink or is not a regular file
After copying, the destination file set is compared with the expected set and every file byte for byte.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path, PurePosixPath

PACKAGE = Path(__file__).resolve().parent.parent
ALLOWLIST = PACKAGE / "tools" / "PAGES_FILES.txt"
PREFIX = "web-demo"
STATIC_SUFFIXES = {".html", ".css", ".js", ".svg"}
NOJEKYLL = ".nojekyll"

_spec = importlib.util.spec_from_file_location("export_package_for_pages", Path(__file__).with_name("export_package.py"))
_pkg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_pkg)
Refused = _pkg.Refused


def check_pages_entry(source: Path, rel: str) -> tuple[str, Path]:
    pure = PurePosixPath(rel)
    if pure.is_absolute() or ".." in pure.parts or rel != str(pure):
        raise Refused(f"unsafe allowlist path: {rel}")
    if len(pure.parts) != 2 or pure.parts[0] != PREFIX:
        raise Refused(f"pages allowlist entry is not a file directly under {PREFIX}/: {rel}")
    if pure.suffix not in STATIC_SUFFIXES or pure.name.startswith("."):
        raise Refused(f"pages allowlist entry is not a static web file: {rel}")
    return pure.name, _pkg.check_entry(source, rel)  # also applies the package-wide EXCLUDED/symlink/missing checks


def export_pages(source: Path, allowlist: Path, dest: Path) -> dict:
    if dest.exists() or dest.is_symlink():
        raise Refused(f"destination already exists: {dest}")
    entries = sorted(_pkg.read_allowlist(allowlist))
    if not entries:
        raise Refused("pages allowlist is empty")
    files = [check_pages_entry(source, rel) for rel in entries]  # validate everything before writing anything
    if "index.html" not in {name for name, _ in files}:
        raise Refused("pages allowlist has no web-demo/index.html")
    dest.mkdir(parents=True)
    out = []
    for name, src in files:
        data = src.read_bytes()
        with open(dest / name, "xb") as fh:
            fh.write(data)
        out.append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    with open(dest / NOJEKYLL, "xb"):
        pass
    out.append({"path": NOJEKYLL, "bytes": 0, "sha256": hashlib.sha256(b"").hexdigest()})
    expected = sorted(item["path"] for item in out)
    got = sorted(str(p.relative_to(dest)) for p in dest.rglob("*"))
    if got != expected:
        raise Refused(f"payload file set mismatch: {got} != {expected}")
    for (name, src) in files:
        if (dest / name).read_bytes() != src.read_bytes():
            raise Refused(f"byte mismatch after copy: {name}")
    return {"files": len(out), "manifest": out,
            "manifest_sha256": hashlib.sha256(json.dumps(out, sort_keys=True).encode()).hexdigest()}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dest", required=True, type=Path)
    ap.add_argument("--source", type=Path, default=PACKAGE)
    ap.add_argument("--allowlist", type=Path)
    a = ap.parse_args(argv)
    source = a.source.resolve()
    allowlist = a.allowlist or source / "tools" / "PAGES_FILES.txt"
    try:
        result = export_pages(source, allowlist, a.dest.absolute())
    except Refused as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
