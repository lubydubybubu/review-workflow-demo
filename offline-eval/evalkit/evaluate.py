"""Offline scorer: explicit gold truth vs hand-authored replay proposals. No extraction happens here.

Gold-evidence authority is finite: a matching value is "supported" only if every predicted span lies
inside the document context range AND overlaps (in bytes) a gold span that the truth file lists for
the same field, AND the predicted spans together cover each listed gold span -- all of its bytes, or
all bytes of a verbatim occurrence of the gold value inside that gold span. A fragment of the gold
sentence that covers neither (e.g. "Please" of "Please publish on ...") is not support. Other spans
may be legitimate prose, but this evaluator cannot know that and counts them as
unsupported_evidence rather than guessing. This is a byte check, not semantic entailment.
"""
from evalkit import contract

CLASSES = (
    "correct",               # truth known, same value, every predicted span supports it
    "valid_unknown",         # truth unknown, prediction says unknown
    "abstained",             # prediction declined to decide (truth known or unknown)
    "false_unknown",         # truth known, prediction says unknown (missed fact)
    "wrong_value",           # value differs from truth but the string appears in the source context
    "hallucinated_value",    # value differs from truth and does not appear in the source context
    "unsupported_evidence",  # value equals truth but a span is outside context / not on a gold span,
                             # or some listed gold span is covered neither fully nor at its value bytes
    "missing_prediction",    # no prediction exists for this case
)


def overlaps(a, b):
    return a["start"] < b["end"] and b["start"] < a["end"]


def covers(spans, gold, value, data):
    """True if the byte union of `spans` covers each gold span: either all of its bytes, or all bytes
    of a verbatim occurrence of `value` inside that gold span (the gold author's value anchor)."""
    have = set()
    for s in spans:
        have.update(range(s["start"], s["end"]))
    needle = value.encode("utf-8")
    for g in gold:
        if have.issuperset(range(g["start"], g["end"])):
            continue
        i = data.find(needle, g["start"], g["end"])
        while i != -1 and not have.issuperset(range(i, i + len(needle))):
            i = data.find(needle, i + 1, g["end"])
        if i == -1:
            return False
    return True


def classify(truth, pred, data, context):
    if pred is None:
        return "missing_prediction"
    status = pred["status"]
    if status == "abstain":
        return "abstained"
    if status == "unknown":
        return "valid_unknown" if truth["status"] == "unknown" else "false_unknown"
    if truth["status"] == "known" and pred["value"] == truth["value"]:
        for s in pred["evidence"]:
            inside = context["start"] <= s["start"] and s["end"] <= context["end"]
            if not inside or not any(overlaps(s, g) for g in truth["evidence"]):
                return "unsupported_evidence"
        if not covers(pred["evidence"], truth["evidence"], truth["value"], data):
            return "unsupported_evidence"
        return "correct"
    ctx_text = data[context["start"]:context["end"]].decode("utf-8", "replace")
    return "wrong_value" if pred["value"] in ctx_text else "hallucinated_value"


REPLAY_CONTRACT = "review-ops.replay-set/v1"
REPORT_CONTRACT = "review-ops.replay-report/v1"
REPLAY_KEYS = ("contract", "classification", "replay_id", "predictions")


class EvaluationError(Exception):
    """Whole-run failure. No partial report is produced."""

    def __init__(self, errors):
        super().__init__("%d validation error(s)" % len(errors))
        self.errors = errors


def evaluate(truth, replay_set, load):
    """Validate truth + replay set completely, then score. Raises EvaluationError on any problem."""
    errs = ["truth." + e for e in contract.validate_truth(truth, load)]
    if errs:
        raise EvaluationError(errs)
    docs = {d["doc_id"]: d for d in truth["documents"]}
    data = {d["doc_id"]: load(d["path"]) for d in truth["documents"]}
    cases = {c["case_id"]: c for c in truth["cases"]}

    if contract.check_keys(replay_set, REPLAY_KEYS, "", errs):
        if replay_set.get("contract") != REPLAY_CONTRACT:
            errs.append("contract: unsupported version")
        if replay_set.get("classification") != contract.SYNTHETIC:
            errs.append("classification: must be '%s'" % contract.SYNTHETIC)
        contract.check_id(replay_set.get("replay_id"), "replay_id", errs)
        preds = replay_set.get("predictions")
        if not isinstance(preds, list) or not 1 <= len(preds) <= contract.MAX_CASES:
            errs.append("predictions: expected array of 1..%d" % contract.MAX_CASES)
            preds = []
    else:
        preds = []
    by_case = {}
    for i, env in enumerate(preds):
        p = "predictions[%d]" % i
        shape = contract.validate_output(env)
        errs += [p + "." + e if not e.startswith("(") else p + e[len("(root)"):] for e in shape]
        if shape:
            continue
        cid = env["case_id"]
        if cid in by_case:
            errs.append("%s.case_id: duplicate '%s'" % (p, cid))
            continue
        by_case[cid] = env
        if cid not in cases:
            errs.append("%s.case_id: '%s' is not in truth (extra case)" % (p, cid))
            continue
        did = cases[cid]["doc_id"]
        errs += [p + "." + e if not e.startswith("(") else p + " " + e
                 for e in contract.bind_output(env, docs[did], data[did])]
    if errs:
        raise EvaluationError(errs)

    counts = dict.fromkeys(CLASSES, 0)
    rows = []
    for case in truth["cases"]:
        cid, did = case["case_id"], case["doc_id"]
        env = by_case.get(cid)
        pred_claims = dict(contract.claims(env)) if env else {}
        for field, gold in contract.claims(case):
            pred = pred_claims.get(field)
            cls = classify(gold, pred, data[did], docs[did]["context"])
            counts[cls] += 1
            rows.append({"case_id": cid, "field": field, "truth_status": gold["status"],
                         "truth_value": gold["value"],
                         "prediction_status": pred["status"] if pred else None,
                         "prediction_value": pred["value"] if pred else None, "class": cls})
    n = len(truth["cases"])
    return {
        "report_contract": REPORT_CONTRACT,
        "replay_id": replay_set["replay_id"],
        "classification": contract.SYNTHETIC,
        "documents": [{"doc_id": d["doc_id"], "sha256": d["sha256"]} for d in truth["documents"]],
        "denominator": {"cases": n, "fields_per_case": len(contract.FIELD_PATHS),
                        "field_slots": n * len(contract.FIELD_PATHS)},
        "counts": counts,
        "missing_cases": [c["case_id"] for c in truth["cases"] if c["case_id"] not in by_case],
        "rows": rows,
        "approval": {"proposals_evaluated": len(by_case), "approvals_performed": 0,
                     "human_approval_required": True},
        "metrics": {"accuracy": None, "model_quality": None, "cost": None, "latency": None,
                    "status": "UNMEASURED",
                    "note": "hand-authored synthetic replay; counts are fixture checks, not model error rates"},
    }
