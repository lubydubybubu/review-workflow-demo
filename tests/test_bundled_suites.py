"""Runs the bundled Python suites (producer, offline replay kit) in child processes from inside the package.

Children get a scrubbed environment, no bytecode writes, and a temp dir outside the package.
"""

import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent


def run_suite(cwd: Path, *args: str) -> tuple[int, int, str]:
    with tempfile.TemporaryDirectory() as tmp:
        env = {"PATH": "/usr/bin:/bin", "HOME": tmp, "TMPDIR": tmp, "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"}
        p = subprocess.run([sys.executable, "-B", "-m", "unittest", "discover", *args], cwd=cwd, env=env,
                           capture_output=True, text=True, timeout=600)
    m = re.search(r"^Ran (\d+) tests?", p.stderr, re.M)
    return p.returncode, int(m.group(1)) if m else 0, p.stderr[-2000:]


class BundledSuites(unittest.TestCase):
    def test_producer_suite_passes(self):
        code, ran, tail = run_suite(PACKAGE / "producer", "-s", ".", "-p", "test_*.py")
        print(f"\n[producer] ran {ran} tests, exit {code}", file=sys.stderr)
        self.assertEqual(code, 0, tail)
        self.assertGreater(ran, 0)

    def test_offline_eval_suite_passes(self):
        code, ran, tail = run_suite(PACKAGE / "offline-eval", "-s", "tests", "-t", ".")
        print(f"\n[offline-eval] ran {ran} tests, exit {code}", file=sys.stderr)
        self.assertEqual(code, 0, tail)
        self.assertGreater(ran, 0)

    def test_offline_replay_cli_exits_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {"PATH": "/usr/bin:/bin", "HOME": tmp, "TMPDIR": tmp, "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"}
            p = subprocess.run([sys.executable, "-B", "replay.py"], cwd=PACKAGE / "offline-eval", env=env,
                               capture_output=True, text=True, timeout=300)
        self.assertEqual(p.returncode, 0, p.stdout[-1500:] + p.stderr[-1500:])


if __name__ == "__main__":
    unittest.main()
