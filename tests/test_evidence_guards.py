"""Regression checks: the runner must fail closed on incomplete or contradicted evidence (no DB, browser or app).

Covers every required screenshot, every explicit browser assertion and every declared fixture source hash,
not a single example.
"""

import copy
import importlib.util
import json
import socket
import tempfile
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
FIXTURES = PACKAGE / "demo" / "fixtures" / "candidates.json"

spec = importlib.util.spec_from_file_location("run_demo_guards", PACKAGE / "demo" / "run_demo.py")
run_demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run_demo)

PHASE_SHOTS = {
    "approve": ["01-mail-inbox-pending.png", "02-approval-form.png", "03-after-approval.png"],
    "after": ["04-mail-followup-duplicate.png", "05-review-detail.png", "06-calendar-2026-11.png", "07-dashboard.png"],
}
ALL_SHOTS = PHASE_SHOTS["approve"] + PHASE_SHOTS["after"]
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32  # placeholder bytes for the finalizer only; never presented as UI evidence

# Shape of a successful browser result (explicit assertions carry `passed`; informational ones do not).
BROWSER = {
    "approve": {"phase": "approve", "ok": True, "blocked_requests": [], "steps": [
        {"name": "login"},
        {"name": "mail-inbox-pending", "assertions": [
            {"assertion": "visible: Lumora candidate card", "passed": True},
            {"lumora_status": "pending", "passed": True},
            {"lumora_deadlines_text": "x"},
            {"injected_instruction_rendered_as_text": True},
            {"pellwick_deadlines_text": "없음", "pellwick_product_text": "못 찾음", "passed": True}]},
        {"name": "approval-form-prefilled", "assertions": [{"values": {}, "passed": True}]},
        {"name": "after-human-click", "assertions": [{"assertion": "visible: registration toast", "passed": True}]}]},
    "after": {"phase": "after", "ok": True, "blocked_requests": [], "steps": [
        {"name": "login"},
        {"name": "mail-inbox-duplicate", "assertions": [{"assertion": "visible: duplicate badge", "passed": True},
                                                        {"assertion": "visible: link", "passed": True}]},
        {"name": "review-detail", "assertions": [{"assertion": "visible: review", "passed": True}]},
        {"name": "calendar-month", "assertions": [{"assertion": "visible: calendar", "passed": True},
                                                  {"calendar_entries_with_product": 2}]},
        {"name": "dashboard", "assertions": [{"dashboard_mentions_product": False}]}]},
}


def finalizer(d: Path, shots: list[str]):
    demo = run_demo.Demo.__new__(run_demo.Demo)
    demo.out, demo.shots = d, d / "screenshots"
    demo.shots.mkdir()
    for f in shots:
        (demo.shots / f).write_bytes(PNG)
    demo.ev = {"checks": [{"name": "c", "passed": True}], "first_failure": None,
               "cleanup": {"package_unchanged": True, "app_port_free": True, "pg_port_free": True, "next_group_left": []}}
    return demo


def consumer(d: Path, phase: str, res: dict, shots: list[str]):
    for f in shots:
        (d / f).write_bytes(PNG)
    (d / f"browser-{phase}.json").write_text(json.dumps(res, ensure_ascii=False))
    demo = run_demo.Demo.__new__(run_demo.Demo)
    demo.shots = demo.secrets = demo.home = demo.tmp = d
    demo.pg_port, demo.base = 1, "http://127.0.0.1:1"
    demo.tools = run_demo.resolve_tools(environ={})
    demo.ev = {"checks": [], "first_failure": None}
    demo.run = lambda *a, **k: None  # the browser subprocess is not launched in this consumer test
    return demo


def explicit(res: dict):
    return [(i, j) for i, st in enumerate(res["steps"]) for j, a in enumerate(st.get("assertions", [])) if "passed" in a]


class FinalizerRequiresEveryScreenshot(unittest.TestCase):
    def test_complete_set_passes(self):
        with tempfile.TemporaryDirectory() as d:
            demo = finalizer(Path(d), ALL_SHOTS)
            self.assertEqual(demo.finish(None), 0)

    def test_each_missing_required_screenshot_fails(self):
        for missing in ALL_SHOTS:
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as d:
                demo = finalizer(Path(d), [f for f in ALL_SHOTS if f != missing])
                self.assertEqual(demo.finish(None), 1)
                ev = json.loads((Path(d) / "evidence.json").read_text())
                self.assertEqual(ev["outcome"], "FAIL")

    def test_modified_package_fails(self):
        with tempfile.TemporaryDirectory() as d:
            demo = finalizer(Path(d), ALL_SHOTS)
            demo.ev["cleanup"]["package_unchanged"] = False
            self.assertEqual(demo.finish(None), 1)


class BrowserConsumerRejectsFailures(unittest.TestCase):
    def test_all_passing_phase_is_accepted(self):
        for phase in PHASE_SHOTS:
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as d:
                demo = consumer(Path(d), phase, BROWSER[phase], PHASE_SHOTS[phase])
                demo.browser(phase)
                self.assertTrue(all(c["passed"] for c in demo.ev["checks"]))

    def test_each_explicit_false_assertion_is_rejected(self):
        for phase in PHASE_SHOTS:
            for i, j in explicit(BROWSER[phase]):
                with self.subTest(phase=phase, step=i, assertion=j), tempfile.TemporaryDirectory() as d:
                    res = copy.deepcopy(BROWSER[phase])
                    res["steps"][i]["assertions"][j]["passed"] = False
                    demo = consumer(Path(d), phase, res, PHASE_SHOTS[phase])
                    with self.assertRaises(RuntimeError):
                        demo.browser(phase)
                    self.assertFalse(demo.ev["checks"][-1]["passed"])

    def test_each_missing_phase_screenshot_is_rejected(self):
        for phase, shots in PHASE_SHOTS.items():
            for missing in shots:
                with self.subTest(phase=phase, missing=missing), tempfile.TemporaryDirectory() as d:
                    demo = consumer(Path(d), phase, BROWSER[phase], [f for f in shots if f != missing])
                    with self.assertRaises(RuntimeError):
                        demo.browser(phase)

    def test_walkthrough_throws_on_explicit_false_before_ok(self):
        # source contract for the browser script itself (it cannot run here without Chrome)
        src = (PACKAGE / "demo" / "browser_walkthrough.mjs").read_text()
        ok_at = src.index("result.ok = true;")
        gate = src.rfind("a.passed !== true", 0, ok_at)
        self.assertGreater(gate, 0, "no explicit-assertion gate before result.ok")
        self.assertIn("throw new Error(`explicit assertion failed", src[gate:ok_at])


class PreflightBindsSourceHashes(unittest.TestCase):
    def free_port(self) -> int:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def preflight_with(self, fixture: dict):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "candidates.json"
            path.write_text(json.dumps(fixture, ensure_ascii=False))
            original, run_demo.FIXTURES = run_demo.FIXTURES, path
            tools = run_demo.resolve_tools(environ={})
            tools["tmp_root"] = Path(d)
            demo = run_demo.Demo(Path(d) / "out", self.free_port(), self.free_port(), tools)
            try:
                with self.assertRaises(RuntimeError) as ctx:
                    demo.preflight()
                self.assertFalse((Path(d) / "out" / "runtime").exists())
            finally:
                run_demo.FIXTURES = original
            self.assertIn("source SHA-256", str(ctx.exception))

    def test_each_declared_hash_mismatch_refuses_before_launch(self):
        data = json.loads(FIXTURES.read_text(encoding="utf-8"))
        for section in ("steps", "after_approval"):
            for k in range(len(data[section])):
                with self.subTest(section=section, step=k):
                    bad = copy.deepcopy(data)
                    bad[section][k]["source_sha256"] = "0" * 64
                    self.preflight_with(bad)

    def test_missing_source_file_refuses_before_launch(self):
        bad = json.loads(FIXTURES.read_text(encoding="utf-8"))
        bad["steps"][0]["source_file"] = "absent.txt"
        self.preflight_with(bad)


if __name__ == "__main__":
    unittest.main()
