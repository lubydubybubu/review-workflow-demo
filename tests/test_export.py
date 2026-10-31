"""Export tool: exact file set, byte equality, determinism and every refusal path (no app, DB or browser).

    python3 -B -m unittest discover -s . -p 'test_*.py' -t .      (from the package root)
"""

import importlib.util
import os
import tarfile
import tempfile
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("export_package", PACKAGE / "tools" / "export_package.py")
export_package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export_package)


def package_files() -> set[str]:
    out = set()
    for d, dirs, files in os.walk(PACKAGE):
        dirs[:] = [x for x in dirs if x != "__pycache__"]
        out |= {str((Path(d) / f).relative_to(PACKAGE)) for f in files}
    return out


def synthetic(root: Path) -> Path:
    """A small fake package with public files plus files that must never be exported."""
    for rel, data in {"README.md": b"hi\n", "app/src/a.ts": b"export const a = 1;\n", "docs/s.png": b"\x89PNG\r\n",
                      "node_modules/x/index.js": b"vendor", ".env": b"SECRET=1", "logs/run.log": b"log",
                      "private-shot.png": b"\x89PNGprivate", "app/.next/cache": b"build"}.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    allow = root / "allow.txt"
    allow.write_text("# public files\nREADME.md\napp/src/a.ts\ndocs/s.png\n")
    return allow


class RealPackageAllowlist(unittest.TestCase):
    def test_allowlist_is_exactly_the_package_file_set(self):
        listed = set(export_package.read_allowlist(export_package.ALLOWLIST))
        self.assertEqual(package_files(), listed)

    def test_no_excluded_or_dependency_paths_listed(self):
        for rel in export_package.read_allowlist(export_package.ALLOWLIST):
            self.assertIsNone(export_package.EXCLUDED.search(rel), rel)

    def test_real_export_is_byte_identical(self):
        with tempfile.TemporaryDirectory() as d:
            dest, arc = Path(d) / "pkg", Path(d) / "pkg.tar.gz"
            res = export_package.export(PACKAGE, export_package.ALLOWLIST, dest, arc)
            listed = sorted(export_package.read_allowlist(export_package.ALLOWLIST))
            self.assertEqual([m["path"] for m in res["manifest"]], listed)
            for rel in listed:
                self.assertEqual((dest / rel).read_bytes(), (PACKAGE / rel).read_bytes(), rel)
            with tarfile.open(arc) as tf:
                members = tf.getmembers()
                self.assertTrue(all(m.isfile() for m in members))
                self.assertEqual(sorted(m.name for m in members), [f"review-workflow-demo/{r}" for r in listed])
                for m in members[:20]:
                    rel = m.name.split("/", 1)[1]
                    self.assertEqual(tf.extractfile(m).read(), (PACKAGE / rel).read_bytes())


class SyntheticExport(unittest.TestCase):
    def test_only_allowlisted_files_are_exported(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "src"
            allow = synthetic(src)
            dest = Path(d) / "out"
            export_package.export(src, allow, dest)
            got = {str(p.relative_to(dest)) for p in dest.rglob("*") if p.is_file()}
            self.assertEqual(got, {"README.md", "app/src/a.ts", "docs/s.png"})
            for rel in got:
                self.assertEqual((dest / rel).read_bytes(), (src / rel).read_bytes())

    def test_archive_is_deterministic(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "src"
            allow = synthetic(src)
            export_package.export(src, allow, Path(d) / "o1", Path(d) / "a1.tar.gz")
            export_package.export(src, allow, Path(d) / "o2", Path(d) / "a2.tar.gz")
            self.assertEqual((Path(d) / "a1.tar.gz").read_bytes(), (Path(d) / "a2.tar.gz").read_bytes())

    def assertRefused(self, src: Path, allow: Path, dest: Path, archive: Path | None = None):
        with self.assertRaises(export_package.Refused):
            export_package.export(src, allow, dest, archive)

    def test_refuses_existing_destination(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "src"
            allow = synthetic(src)
            dest = Path(d) / "out"
            dest.mkdir()
            self.assertRefused(src, allow, dest)
            self.assertEqual(list(dest.iterdir()), [])

    def test_refuses_existing_archive(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "src"
            allow = synthetic(src)
            arc = Path(d) / "a.tar.gz"
            arc.write_bytes(b"old")
            self.assertRefused(src, allow, Path(d) / "out", arc)
            self.assertFalse((Path(d) / "out").exists())
            self.assertEqual(arc.read_bytes(), b"old")

    def test_refuses_missing_file_before_writing(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "src"
            allow = synthetic(src)
            allow.write_text(allow.read_text() + "docs/absent.md\n")
            self.assertRefused(src, allow, Path(d) / "out")
            self.assertFalse((Path(d) / "out").exists())

    def test_refuses_symlinked_file_and_directory(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "src"
            allow = synthetic(src)
            (src / "link.md").symlink_to(src / "README.md")
            allow.write_text(allow.read_text() + "link.md\n")
            self.assertRefused(src, allow, Path(d) / "out")
            allow = synthetic(Path(d) / "src2")
            (Path(d) / "src2" / "lnkdir").symlink_to(Path(d) / "src2" / "app")
            allow.write_text(allow.read_text() + "lnkdir/src/a.ts\n")
            self.assertRefused(Path(d) / "src2", allow, Path(d) / "out2")
            self.assertFalse((Path(d) / "out").exists() or (Path(d) / "out2").exists())

    def test_refuses_excluded_or_unsafe_paths_even_if_listed(self):
        for bad in ("node_modules/x/index.js", ".env", "logs/run.log", "app/.next/cache", "../escape", "/etc/passwd"):
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as d:
                src = Path(d) / "src"
                allow = synthetic(src)
                allow.write_text(allow.read_text() + bad + "\n")
                self.assertRefused(src, allow, Path(d) / "out")
                self.assertFalse((Path(d) / "out").exists())

    def test_cli_refusal_exit_code(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(export_package.main(["--dest", d]), 2)


if __name__ == "__main__":
    unittest.main()
