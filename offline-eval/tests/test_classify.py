"""Slice 3: per-field classification against finite gold evidence."""
import unittest

from evalkit import evaluate
from tests.test_binding import DATA, doc, span, valid_truth


def gold(field):
    f = valid_truth()["cases"][0]["fields"]
    return f[field] if "." not in field else f["deadlines"][field.split(".")[1]]


def pv(value, *texts, spans=None):
    return {"status": "value", "value": value, "reason": None,
            "evidence": spans if spans is not None else [span(t) for t in texts]}


def classify(field, pred):
    return evaluate.classify(gold(field), pred, DATA, doc()["context"])


class ClassifyTests(unittest.TestCase):
    def test_correct_value_with_supporting_gold_span(self):
        self.assertEqual(classify("deadlines.publish", pv("2026-11-20", "Publish on 2026-11-20.")), "correct")
        # a sub-span overlapping the gold span also supports it
        self.assertEqual(classify("deadlines.publish", pv("2026-11-20", "2026-11-20")), "correct")

    def test_missing_prediction(self):
        self.assertEqual(classify("brand_name", None), "missing_prediction")

    def test_valid_unknown_vs_false_unknown(self):
        u = {"status": "unknown", "value": None, "reason": "not stated", "evidence": []}
        self.assertEqual(classify("deadlines.embargo", u), "valid_unknown")
        self.assertEqual(classify("deadlines.publish", u), "false_unknown")

    def test_abstain_is_its_own_class(self):
        a = {"status": "abstain", "value": None, "reason": "unsure", "evidence": []}
        self.assertEqual(classify("deadlines.publish", a), "abstained")
        self.assertEqual(classify("deadlines.embargo", a), "abstained")

    def test_value_not_in_source_is_hallucinated(self):
        self.assertEqual(classify("deadlines.embargo", pv("2026-11-18", "Publish on 2026-11-20.")),
                         "hallucinated_value")
        self.assertEqual(classify("product_name", pv("Arc 3", "Arc 2 lamp")), "hallucinated_value")

    def test_wrong_value_present_in_source(self):
        # truth is unknown, model copies another field's date that does appear in the text
        self.assertEqual(classify("deadlines.embargo", pv("2026-11-20", "Publish on 2026-11-20.")), "wrong_value")
        self.assertEqual(classify("brand_name", pv("Arc 2", "Arc 2 lamp")), "wrong_value")

    def test_valid_quote_cannot_rescue_wrong_value(self):
        # quoting the exact gold span does not make a different date correct
        self.assertEqual(classify("deadlines.publish", pv("2026-11-21", "Publish on 2026-11-20.")),
                         "hallucinated_value")

    def test_right_value_with_quote_for_other_field_is_unsupported(self):
        self.assertEqual(classify("brand_name", pv("Lumora", "Publish on 2026-11-20.")), "unsupported_evidence")

    def test_right_value_with_one_extra_unrelated_span_is_unsupported(self):
        self.assertEqual(classify("deadlines.publish", pv("2026-11-20", "Publish on 2026-11-20.", "Arc 2 lamp")),
                         "unsupported_evidence")

    def test_evidence_outside_context_range_is_unsupported(self):
        header_span = {"start": DATA.index(b"Lumora"), "end": DATA.index(b"Lumora") + 6, "quote": "Lumora"}
        self.assertLess(header_span["start"], doc()["context"]["start"])
        self.assertEqual(classify("brand_name", pv("Lumora", spans=[header_span])), "unsupported_evidence")

    def test_value_only_in_header_counts_as_hallucinated(self):
        # "a@b.example" is outside the body context: not support, and not "present in source context"
        self.assertEqual(classify("brand_name", pv("a@b.example", "Lumora will lend")), "hallucinated_value")

    def test_class_order_is_fixed(self):
        self.assertEqual(evaluate.CLASSES, (
            "correct", "valid_unknown", "abstained", "false_unknown", "wrong_value",
            "hallucinated_value", "unsupported_evidence", "missing_prediction"))


if __name__ == "__main__":
    unittest.main()
