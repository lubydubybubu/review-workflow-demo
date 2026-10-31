"""Pages exporter: payload is only web-demo files + .nojekyll; private/app/server/env/fixture paths never leak.

    python3 -B -m unittest discover -s tests -t .      (from the package root)
"""

import importlib.util
import os
import re
import tempfile
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("export_pages", PACKAGE / "tools" / "export_pages.py")
export_pages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export_pages)
pkg_spec = importlib.util.spec_from_file_location("export_package_for_ci_test", PACKAGE / "tools" / "export_package.py")
export_package = importlib.util.module_from_spec(pkg_spec)
pkg_spec.loader.exec_module(export_package)

WEB_FILES = {"app.js", "icon.svg", "index.html", "state.js", "styles.css"}
# Anything matching this must never appear in a Pages payload.
PRIVATE = re.compile(r"(^|/)(app|server|src|fixtures|reports|docs|tools|tests|demo|producer|offline-eval|node_modules|\.git"
                     r"|\.github)(/|$)|\.env|\.(py|ts|tsx|sql|json|md|mjs|pem|key|log|tar|gz)$")


def tree(root: Path) -> set[str]:
    return {str(p.relative_to(root)) for p in root.rglob("*")}


def synthetic(root: Path) -> Path:
    """A fake package with the web-demo files plus private material that must stay out of the payload."""
    files = {f"web-demo/{n}": f"/* {n} */\n".encode() for n in WEB_FILES}
    files.update({
        "reports/IMPLEMENTATION.md": b"private report",
        "reports/browser-run/evidence.json": b"{}",
        "app/src/server/db/pool.ts": b"server",
        "app/.env": b"DATABASE_URL=postgres://u:p@h/db",
        ".env.local": b"SECRET=1",
        "demo/fixtures/candidates.json": b"{}",
        "web-demo/.env": b"SECRET=2",
        "web-demo/private/notes.md": b"private",
        "web-demo/server.mjs": b"server",
        ".git/config": b"[core]",
        "node_modules/x/index.js": b"vendor",
        "credentials.json": b"{}",
    })
    for rel, data in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    allow = root / "pages.txt"
    allow.write_text("# pages\n" + "".join(f"web-demo/{n}\n" for n in sorted(WEB_FILES)))
    return allow


class RealPagesPayload(unittest.TestCase):
    def test_allowlist_is_exactly_the_web_demo_file_set(self):
        listed = set(export_package.read_allowlist(export_pages.ALLOWLIST))
        actual = {f"web-demo/{p.name}" for p in (PACKAGE / "web-demo").iterdir()}
        self.assertEqual(listed, actual)
        self.assertEqual(listed, {f"web-demo/{n}" for n in WEB_FILES})

    def test_real_export_contains_only_web_demo_and_nojekyll(self):
        with tempfile.TemporaryDirectory() as d:
            dest = Path(d) / "pages"
            res = export_pages.export_pages(PACKAGE, export_pages.ALLOWLIST, dest)
            self.assertEqual(tree(dest), WEB_FILES | {".nojekyll"})
            self.assertEqual(res["files"], len(WEB_FILES) + 1)
            self.assertEqual((dest / ".nojekyll").read_bytes(), b"")
            for n in WEB_FILES:
                self.assertEqual((dest / n).read_bytes(), (PACKAGE / "web-demo" / n).read_bytes(), n)
            for rel in tree(dest):
                self.assertIsNone(PRIVATE.search(rel), rel)


class SyntheticPagesExport(unittest.TestCase):
    def test_private_reports_app_env_and_fixtures_are_excluded(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "src"
            allow = synthetic(src)
            dest = Path(d) / "out"
            export_pages.export_pages(src, allow, dest)
            self.assertEqual(tree(dest), WEB_FILES | {".nojekyll"})
            blob = b"".join((dest / n).read_bytes() for n in tree(dest))
            for secret in (b"private report", b"DATABASE_URL", b"SECRET", b"server", b"vendor", b"[core]"):
                self.assertNotIn(secret, blob)

    def test_refuses_existing_destination_without_touching_it(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "src"
            allow = synthetic(src)
            dest = Path(d) / "out"
            dest.mkdir()
            (dest / "keep.txt").write_text("old")
            with self.assertRaises(export_pages.Refused):
                export_pages.export_pages(src, allow, dest)
            self.assertEqual(tree(dest), {"keep.txt"})

    def test_refuses_any_entry_outside_web_demo_or_non_static(self):
        bad_entries = ("reports/IMPLEMENTATION.md", "app/src/server/db/pool.ts", "app/.env", ".env.local",
                       "demo/fixtures/candidates.json", "web-demo/.env", "web-demo/private/notes.md",
                       "web-demo/server.mjs", ".git/config", "node_modules/x/index.js", "credentials.json",
                       "../src/web-demo/index.html", "/etc/passwd", "web-demo/../reports/IMPLEMENTATION.md",
                       "web-demo/missing.js")
        for bad in bad_entries:
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as d:
                src = Path(d) / "src"
                allow = synthetic(src)
                allow.write_text(allow.read_text() + bad + "\n")
                with self.assertRaises(export_pages.Refused):
                    export_pages.export_pages(src, allow, Path(d) / "out")
                self.assertFalse((Path(d) / "out").exists())

    def test_refuses_symlinked_web_file(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "src"
            allow = synthetic(src)
            (src / "web-demo" / "app.js").unlink()
            (src / "web-demo" / "app.js").symlink_to(src / "reports" / "IMPLEMENTATION.md")
            with self.assertRaises(export_pages.Refused):
                export_pages.export_pages(src, allow, Path(d) / "out")
            self.assertFalse((Path(d) / "out").exists())

    def test_refuses_allowlist_without_index(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "src"
            allow = synthetic(src)
            allow.write_text("web-demo/app.js\n")
            with self.assertRaises(export_pages.Refused):
                export_pages.export_pages(src, allow, Path(d) / "out")

    def test_cli_refusal_exit_code(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(export_pages.main(["--dest", d]), 2)


class CiWorkflowException(unittest.TestCase):
    """The source exporter allows exactly one .github path (the tests-only CI workflow) and nothing else there."""

    def test_only_the_ci_workflow_is_exempt(self):
        self.assertIsNone(export_package.EXCLUDED.search(".github/workflows/ci.yml"))
        for rel in (".github/workflows/deploy.yml", ".github/workflows/ci.yml.bak", ".github/CODEOWNERS",
                    "app/.github/workflows/ci.yml", ".github/ci.yml", ".git/config"):
            self.assertIsNotNone(export_package.EXCLUDED.search(rel), rel)

    def test_workflow_is_tests_only_and_read_only(self):
        wf = (PACKAGE / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertIn("permissions:\n  contents: read", wf)
        self.assertNotIn("secrets.", wf)
        for word in ("pages", "deploy", "gh-pages", "write", "pull_request_target", "npm ", "pip "):
            self.assertNotIn(word, wf.lower().replace("contents: read", ""), word)
        for m in re.finditer(r"uses:\s*(\S+)", wf):
            self.assertRegex(m.group(1), r"^actions/checkout@[0-9a-f]{40}$")
        self.assertEqual(os.listdir(PACKAGE / ".github" / "workflows"), ["ci.yml"])


if __name__ == "__main__":
    unittest.main()
