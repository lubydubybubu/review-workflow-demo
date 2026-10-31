"""Offline replay CLI. Scores hand-authored replay proposals against corpus/truth.json.

  python3 replay.py                                  # all replay sets in corpus/expected.json
  python3 replay.py --predictions corpus/replays/bad.json   # one replay set, report to stdout

Exit codes: 0 ok / all expectations met, 1 expectation mismatch, 2 invalid input (diagnostics on stderr).
No network, no model calls, no timestamps in the output.
"""
import argparse
import json
import os
import sys

from evalkit import contract, evaluate

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_JSON_BYTES = 1_000_000


class InputError(Exception):
    pass


def reject_constant(name):
    raise ValueError("non-finite number %s" % name)


def unique_pairs(pairs):
    obj = {}
    for k, v in pairs:
        if k in obj:
            raise ValueError("duplicate key %r" % k)
        obj[k] = v
    return obj


def read_json(path):
    try:
        with open(path, "rb") as f:
            raw = f.read(MAX_JSON_BYTES + 1)
    except OSError as e:
        raise InputError("cannot read %s: %s" % (path, e.strerror))
    if len(raw) > MAX_JSON_BYTES:
        raise InputError("%s: larger than %d bytes" % (path, MAX_JSON_BYTES))
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_pairs, parse_constant=reject_constant)
    except (UnicodeDecodeError, ValueError) as e:
        raise InputError("%s: invalid JSON (%s)" % (path, e))


def corpus_loader(base):
    base = os.path.realpath(base)

    def load(rel):
        p = os.path.realpath(os.path.join(base, rel))
        if not p.startswith(base + os.sep):
            raise OSError("outside corpus")
        with open(p, "rb") as f:
            return f.read()
    return load


def score(truth, replay_path, load):
    """(report, None) or (None, errors)."""
    try:
        return evaluate.evaluate(truth, read_json(replay_path), load), None
    except evaluate.EvaluationError as e:
        return None, e.errors


def run_all(truth, truth_dir, load, expected_path):
    expected = read_json(expected_path)
    built = valid = 0
    docs = {d["doc_id"]: d for d in truth["documents"]}
    for case in truth["cases"]:
        d = docs[case["doc_id"]]
        built += 1
        valid += not contract.validate_input(contract.build_input(case["case_id"], d, load(d["path"])))
    results, ok = [], valid == built
    for exp in expected["replays"]:
        path = os.path.join(truth_dir, exp["file"])  # replay files are corpus-relative
        report, errors = score(truth, path, load)
        if report is not None:
            match = (exp["outcome"] == "scored" and report["replay_id"] == exp["replay_id"]
                     and report["counts"] == exp["counts"] and report["missing_cases"] == exp["missing_cases"])
            entry = {"replay_id": exp["replay_id"], "file": exp["file"], "outcome": "scored",
                     "expected_outcome": exp["outcome"], "matches_expectation": match}
            entry.update({k: report[k] for k in ("denominator", "counts", "missing_cases", "approval",
                                                  "metrics", "rows")})
        else:
            match = exp["outcome"] == "rejected" and sorted(errors) == sorted(exp["errors"])
            entry = {"replay_id": exp["replay_id"], "file": exp["file"], "outcome": "rejected",
                     "expected_outcome": exp["outcome"], "matches_expectation": match, "errors": errors}
        ok = ok and match
        results.append(entry)
    return {
        "report_contract": "review-ops.replay-run/v1",
        "classification": contract.SYNTHETIC,
        "truth_documents": [{"doc_id": d["doc_id"], "sha256": d["sha256"]} for d in truth["documents"]],
        "input_envelopes": {"built": built, "valid": valid},
        "results": results,
        "metrics_note": "accuracy, model quality, cost and latency are UNMEASURED; no model was run.",
        "status": "all_expectations_met" if ok else "expectation_mismatch",
    }, ok


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--truth", default=os.path.join(HERE, "corpus", "truth.json"))
    ap.add_argument("--predictions", help="score one replay set instead of the expected plan")
    ap.add_argument("--expected", default=os.path.join(HERE, "corpus", "expected.json"))
    args = ap.parse_args(argv)
    try:
        truth = read_json(args.truth)
        load = corpus_loader(os.path.dirname(os.path.abspath(args.truth)))
        errs = contract.validate_truth(truth, load)
        if errs:
            raise evaluate.EvaluationError(["truth." + e for e in errs])
        if args.predictions:
            report, errors = score(truth, args.predictions, load)
            if errors:
                raise evaluate.EvaluationError(errors)
            ok = True
        else:
            report, ok = run_all(truth, os.path.dirname(os.path.abspath(args.truth)), load, args.expected)
    except InputError as e:
        sys.stderr.write("error: %s\n" % e)
        return 2
    except evaluate.EvaluationError as e:
        sys.stderr.write("error: %d validation error(s)\n" % len(e.errors))
        for line in e.errors:
            sys.stderr.write("  %s\n" % line)
        return 2
    sys.stdout.write(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
