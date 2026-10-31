"""The demo's runtime copy must never write into the pre-installed dependency dir it is given.

Vite and Vitest create caches at the node_modules root by default (.vite/vitest results, .vite-temp bundled
config, .vitest-cache module cache). These tests use a disposable dependency dir (no node, DB or browser) and
write exactly those paths through the runtime copy, the way the tools do.

    python3 -B -m unittest discover -s tests -t .      (from the package root)
"""

import hashlib
import importlib.util
import os
import shutil
import tempfile
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent

spec = importlib.util.spec_from_file_location("run_demo_isolation", PACKAGE / "demo" / "run_demo.py")
run_demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run_demo)

# root-level paths the tools write by default, relative to node_modules
TOOL_CACHE_WRITES = (
    ".vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json",
    ".vite-temp/vitest.config.ts.timestamp-1-abc.mjs",
    ".vitest-cache/49d592759ce1560add52bedf3f00674fa62a439f",
    ".cache/some-tool/entry",
)


def tree(root: Path) -> dict:
    out = {}
    for d, dirs, files in os.walk(root):
        for name in dirs + files:
            p = Path(d) / name
            rel = str(p.relative_to(root))
            if p.is_symlink():
                out[rel] = "link:" + os.readlink(p)
            elif p.is_dir():
                out[rel] = "dir"
            else:
                out[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    return dict(sorted(out.items()))


def make_deps(root: Path) -> Path:
    deps = root / "deps" / "node_modules"
    for rel, text in (("pkg/index.js", "module.exports = 1;\n"), ("@scope/lib/index.js", "export {};\n"),
                      (".bin/tool", "#!/bin/sh\n"), (".package-lock.json", "{}\n"),
                      (".vitest-cache/old-entry", "stale shared cache\n"),
                      (".vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json", "{}\n")):
        p = deps / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    (deps / ".vite-temp").mkdir()
    return deps


class RuntimeDependencyIsolation(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.deps = make_deps(self.tmp)
        self.before = tree(self.deps)
        tools = run_demo.resolve_tools(environ={})
        tools.update(node_modules=self.deps, tmp_root=self.tmp)
        self.demo = run_demo.Demo(self.tmp / "out", 1, 2, tools)
        self.demo.runtime_copy()
        self.nm = self.demo.app / "node_modules"

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_tool_cache_writes_stay_in_the_owned_runtime(self):
        for rel in TOOL_CACHE_WRITES:
            p = self.nm / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("written by the run\n")
            self.assertTrue(os.path.realpath(p).startswith(str(self.demo.rt.resolve()) + os.sep), rel)
        self.assertEqual(tree(self.deps), self.before)

    def test_runtime_node_modules_is_owned_and_still_resolves_packages(self):
        self.assertTrue(self.nm.is_dir())
        self.assertFalse(self.nm.is_symlink())
        self.assertEqual((self.nm / "pkg" / "index.js").read_text(), "module.exports = 1;\n")
        self.assertTrue((self.nm / "@scope" / "lib" / "index.js").is_file())
        self.assertTrue((self.nm / ".bin" / "tool").is_file())
        # shared caches are neither linked (written through) nor read
        for name in (".vite", ".vite-temp", ".vitest-cache", ".package-lock.json"):
            self.assertFalse(os.path.lexists(self.nm / name), name)

    def test_removing_the_runtime_leaves_dependencies_intact(self):
        shutil.rmtree(self.demo.rt)
        self.assertEqual(tree(self.deps), self.before)

    def test_dependency_guard_detects_writes_into_the_dependency_dir(self):
        before = run_demo.dependency_snapshot(self.deps)
        self.assertEqual(run_demo.snapshot_diff(before, run_demo.dependency_snapshot(self.deps)),
                         {"added": [], "deleted": [], "changed": []})
        (self.deps / ".vitest-cache" / "new-entry").write_text("x")
        (self.deps / "pkg" / "index.js").write_text("module.exports = 2; // longer\n")
        (self.deps / ".bin" / "tool").unlink()
        diff = run_demo.snapshot_diff(before, run_demo.dependency_snapshot(self.deps))
        self.assertEqual(diff["added"], [".vitest-cache/new-entry"])
        self.assertEqual(diff["changed"], ["pkg/index.js"])
        self.assertEqual(diff["deleted"], [".bin/tool"])


if __name__ == "__main__":
    unittest.main()
