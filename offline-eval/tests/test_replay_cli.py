"""Slice 5: offline replay CLI over the real corpus (fixed argv subprocess, no network)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(*args):
    p = subprocess.run([sys.executable, os.path.join(ROOT, "replay.py")] + list(args), cwd=ROOT,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
                       env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
    return p.returncode, p.stdout.decode(), p.stderr.decode()


class ReplayCliTests(unittest.TestCase):
    def test_default_replay_matches_expected_and_is_deterministic(self):
        code, out, err = run()
        self.assertEqual(code, 0, err)
        code2, out2, _ = run()
        self.assertEqual(out, out2)
        r = json.loads(out)
        self.assertEqual(r["status"], "all_expectations_met")
        self.assertEqual(r["input_envelopes"], {"built": 5, "valid": 5})
        by_id = {x["replay_id"]: x for x in r["results"]}
        self.assertEqual(by_id["positive"]["counts"]["correct"], 17)
        self.assertEqual(by_id["positive"]["counts"]["valid_unknown"], 18)
        bad = by_id["deliberately-bad"]["counts"]
        self.assertEqual(bad, {"correct": 4, "valid_unknown": 10, "abstained": 3, "false_unknown": 1,
                               "wrong_value": 2, "hallucinated_value": 5, "unsupported_evidence": 3,
                               "missing_prediction": 7})
        self.assertEqual(by_id["malformed"]["outcome"], "rejected")
        for x in r["results"]:
            if "metrics" in x:
                self.assertEqual(x["metrics"]["status"], "UNMEASURED")
                self.assertIsNone(x["metrics"]["accuracy"])

    def test_single_malformed_file_exits_nonzero_with_paths(self):
        code, out, err = run("--predictions", "corpus/replays/malformed.json")
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("predictions[0].approved: unknown key", err)
        self.assertIn("predictions[0].requires_human_approval: must be boolean true", err)
        self.assertIn("predictions[1].case_id: 'c9-not-in-truth' is not in truth (extra case)", err)

    def test_single_bad_file_reports_but_exits_zero(self):
        code, out, err = run("--predictions", "corpus/replays/bad.json")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["missing_cases"], ["c3-corvane-loan"])

    def test_expectation_mismatch_exits_one(self):
        with open(os.path.join(ROOT, "corpus", "expected.json")) as f:
            exp = json.load(f)
        exp["replays"][0]["counts"]["correct"] += 1
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "expected.json")
            with open(p, "w") as f:
                json.dump(exp, f)
            code, out, err = run("--expected", p)
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out)["status"], "expectation_mismatch")

    def test_missing_file_is_an_error(self):
        code, out, err = run("--predictions", "corpus/replays/nope.json")
        self.assertEqual(code, 2)
        self.assertIn("cannot read", err)


if __name__ == "__main__":
    unittest.main()
