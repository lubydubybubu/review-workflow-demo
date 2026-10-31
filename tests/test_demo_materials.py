"""Deterministic offline checks for the demo materials (no DB, browser, network or app).

    python3 -B -m unittest discover -s tests -t .      (from the package root)
"""

import hashlib
import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
SOURCES = PACKAGE / "offline-eval" / "corpus" / "sources"
FIXTURES = PACKAGE / "demo" / "fixtures" / "candidates.json"

spec = importlib.util.spec_from_file_location("run_demo", PACKAGE / "demo" / "run_demo.py")
run_demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run_demo)


def all_steps():
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    return data, data["steps"] + data["after_approval"]


def fake_tools(tmp: str) -> dict:
    tools = run_demo.resolve_tools(environ={})
    tools["tmp_root"] = Path(tmp)
    return tools


class FixtureBinding(unittest.TestCase):
    def test_classification_is_not_model_output(self):
        data, _ = all_steps()
        self.assertEqual(data["classification"], "synthetic-replay-not-model-output")

    def test_sources_exist_and_hashes_match(self):
        _, steps = all_steps()
        for s in steps:
            src = SOURCES / s["source_file"]
            self.assertEqual(hashlib.sha256(src.read_bytes()).hexdigest(), s["source_sha256"], s["name"])

    def test_every_stated_date_is_quoted_from_the_source(self):
        _, steps = all_steps()
        for s in steps:
            if "payload" not in s:
                continue
            text = (SOURCES / s["source_file"]).read_text(encoding="utf-8")
            for key, value in s["payload"]["extracted"]["deadlines"].items():
                quote = s["date_quotes"][key]
                if value is None:
                    self.assertIsNone(quote, f"{s['name']}.{key}")
                else:
                    self.assertIn(value, quote, f"{s['name']}.{key}")
                    self.assertIn(quote, text, f"{s['name']}.{key} quote not in source")

    def test_evidence_lines_are_verbatim(self):
        _, steps = all_steps()
        for s in steps:
            if "payload" in s:
                text = (SOURCES / s["source_file"]).read_text(encoding="utf-8")
                for line in s["payload"]["evidence"]:
                    self.assertIn(line, text, s["name"])

    def test_received_at_matches_source_date_header(self):
        _, steps = all_steps()
        for s in steps:
            if "payload" in s:
                header = re.search(r"^Date: (\S+)$", (SOURCES / s["source_file"]).read_text(), re.M).group(1)
                self.assertEqual(s["payload"]["received_at"], header, s["name"])

    def test_unknown_case_guesses_nothing(self):
        _, steps = all_steps()
        pell = next(s for s in steps if s["name"] == "pellwick-missing")["payload"]["extracted"]
        self.assertIsNone(pell["product_name"])
        self.assertEqual(pell["source_type"], "unknown")
        self.assertEqual(set(pell["deadlines"].values()), {None})

    def test_no_approval_keys_in_payloads(self):
        _, steps = all_steps()
        for s in steps:
            if "payload" in s:
                self.assertFalse({"approved", "status", "review_id"} & set(s["payload"]), s["name"])

    def test_resend_reuses_message_id_with_new_subject(self):
        steps = run_demo.load_steps("steps")
        first, resent = steps[0]["payload"], steps[2]["payload"]
        self.assertEqual(first["message_id"], resent["message_id"])
        self.assertNotEqual(first["subject"], resent["subject"])
        self.assertEqual(steps[2]["expect_result"], "exists")

    def test_followup_is_same_thread(self):
        steps = run_demo.load_steps("steps") + run_demo.load_steps("after_approval")
        fu = steps[-1]["payload"]
        self.assertEqual(fu["thread_id"], steps[0]["payload"]["thread_id"])
        self.assertNotEqual(fu["message_id"], steps[0]["payload"]["message_id"])


class RunnerGuards(unittest.TestCase):
    def test_refuses_existing_output_dir(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(run_demo.main(["--output-dir", d]), 2)

    def test_refuses_output_inside_package(self):
        target = PACKAGE / "should-not-be-created"
        self.assertEqual(run_demo.main(["--output-dir", str(target)]), 2)
        self.assertFalse(target.exists())

    def test_refuses_missing_tool_paths_before_creating_output(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "out"
            original = run_demo.os.environ
            run_demo.os.environ = {}
            try:
                self.assertEqual(run_demo.main(["--output-dir", str(target)]), 2)
            finally:
                run_demo.os.environ = original
            self.assertFalse(target.exists())

    def test_tool_paths_come_from_flags_then_env_only(self):
        tools = run_demo.resolve_tools(environ={"RWD_NODE": "/opt/x/node", "RWD_CHROME": "/opt/c"})
        self.assertEqual(tools["node"], Path("/opt/x/node"))
        self.assertIsNone(tools["pg_bin"])
        self.assertIsNone(tools["font_dir"])
        src = (PACKAGE / "demo" / "run_demo.py").read_text()
        self.assertNotIn(str(Path.home()), src)

    def test_forbidden_port_is_refused_before_anything_starts(self):
        with tempfile.TemporaryDirectory() as d:
            demo = run_demo.Demo(Path(d) / "out", 50001, 50002, fake_tools(d), {50001})
            with self.assertRaises(RuntimeError) as ctx:
                demo.preflight()
            self.assertIn("forbidden", str(ctx.exception))
            self.assertFalse((Path(d) / "out" / "runtime").exists())

    def test_cli_refuses_forbidden_port_before_creating_output(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "out"
            self.assertEqual(run_demo.main(["--output-dir", str(target), "--pg-port", "50003", "--forbid-port", "50003"]), 2)
            self.assertFalse(target.exists())

    def test_missing_tools_refuse_in_preflight(self):
        with tempfile.TemporaryDirectory() as d:
            demo = run_demo.Demo(Path(d) / "out", 1, 2, fake_tools(d))
            with self.assertRaises(RuntimeError) as ctx:
                demo.preflight()
            self.assertIn("missing tool", str(ctx.exception))
            self.assertFalse((Path(d) / "out" / "runtime").exists())

    def test_child_env_is_scrubbed(self):
        with tempfile.TemporaryDirectory() as d:
            demo = run_demo.Demo(Path(d), 1, 2, fake_tools(d))
            env = demo.env()
        self.assertEqual(set(env), {"PATH", "HOME", "TMPDIR", "LANG", "NEXT_TELEMETRY_DISABLED", "DEMO_DEPS",
                                    "DEMO_CHROME", "DEMO_PG_PORT"})


class BrowserSafety(unittest.TestCase):
    def test_launch_keeps_sandbox_on(self):
        src = (PACKAGE / "demo" / "browser_walkthrough.mjs").read_text()
        launch = src[src.index("chromium.launch({"): src.index("});", src.index("chromium.launch({"))]
        self.assertIn("chromiumSandbox: true", launch)
        self.assertIn("executablePath: CHROME", launch)
        self.assertNotIn("no-sandbox", launch)
        self.assertNotIn("disable-web-security", launch)
        self.assertIn("route.abort", src)


class PackageHygiene(unittest.TestCase):
    def test_no_symlinks_or_dependency_dirs(self):
        for p in PACKAGE.rglob("*"):
            self.assertFalse(p.is_symlink(), p)
            self.assertNotIn(p.name, {"node_modules", ".next", ".git", ".env"}, p)

    def test_no_font_or_vendor_binaries(self):
        for p in PACKAGE.rglob("*"):
            self.assertNotIn(p.suffix, {".woff", ".woff2", ".ttf", ".otf", ".exe", ".so", ".node"}, p)

    def test_public_prose_has_no_host_paths_or_long_ids(self):
        # generic checks only; the full private-identifier sweep is run outside the package before export
        home = str(Path.home())
        long_id = re.compile(r"(?<![0-9A-Za-z])\d{15,}(?![0-9A-Za-z])")
        docs = list(PACKAGE.glob("*.md")) + list((PACKAGE / "docs").glob("*.md"))
        self.assertGreaterEqual(len(docs), 6)
        for doc in docs:
            text = doc.read_text(encoding="utf-8")
            self.assertNotIn(home, text, doc.name)
            self.assertEqual(long_id.findall(text), [], doc.name)

    def test_docs_reference_existing_relative_files(self):
        docs = list(PACKAGE.glob("*.md")) + list((PACKAGE / "docs").glob("*.md"))
        for doc in docs:
            for target in re.findall(r"\]\(([^)#:]+)\)", doc.read_text(encoding="utf-8")):
                self.assertTrue((doc.parent / target).exists(), f"{doc.name} -> {target}")

    def test_every_required_screenshot_is_shipped_and_documented(self):
        storyboard = (PACKAGE / "docs" / "STORYBOARD.ko.md").read_text(encoding="utf-8")
        for files in run_demo.REQUIRED_SCREENSHOTS.values():
            for f in files:
                p = PACKAGE / "docs" / "screenshots" / f
                self.assertTrue(p.is_file(), f)
                self.assertEqual(p.read_bytes()[:8], b"\x89PNG\r\n\x1a\n", f)
                self.assertIn(f"screenshots/{f}", storyboard)


if __name__ == "__main__":
    unittest.main()
