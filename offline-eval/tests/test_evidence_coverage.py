"""PM002-V01: a matching value is correct only if its evidence covers each listed gold span, either
in full or at the bytes of the gold value's verbatim occurrence inside that gold span.

A fragment that merely overlaps the gold sentence ("Please" of "Please publish on 2032-03-06.")
does not support the value. Coverage is a finite byte check against hand-authored gold spans,
not semantic entailment.
"""
import copy
import hashlib
import unittest

from evalkit import evaluate
from tests.test_binding import loader, valid_truth
from tests.test_replay_set import env_for, replay

HEADER = "From: synthetic@yeoul.example\nSubject: 여울빛 종이새 9 대여\n\n".encode()
BODY = ("브랜드: 여울빛. 제품: 여울빛 종이새 9.\n"
        "대여 조건: loan.\n"
        "초안 제출일: 2032-02-29.\n"
        "Please publish on 2032-03-06.\n"
        "반납일: 2032-03-19.\n").encode()
DATA = HEADER + BODY
CONTEXT = {"start": len(HEADER), "end": len(DATA)}


def sp(text, start=None):
    s = DATA.index(text.encode(), len(HEADER) if start is None else start)
    return {"start": s, "end": s + len(text.encode()), "quote": text}


def known(value, *texts):
    return {"status": "known", "value": value, "reason": None, "evidence": [sp(t) for t in texts]}


GOLD = {
    "brand_name": known("여울빛", "브랜드: 여울빛."),
    "product_name": known("여울빛 종이새 9", "제품: 여울빛 종이새 9."),
    "source_type": known("loan", "대여 조건: loan."),
    "deadlines.write_by": known("2032-02-29", "초안 제출일: 2032-02-29."),
    "deadlines.publish": known("2032-03-06", "Please publish on 2032-03-06."),
    "deadlines.return_by": known("2032-03-19", "반납일: 2032-03-19."),
}


def pv(value, spans):
    return {"status": "value", "value": value, "reason": None, "evidence": spans}


def classify(field, spans, gold=None):
    g = gold or GOLD[field]
    return evaluate.classify(g, pv(g["value"], spans), DATA, CONTEXT)


class FullGoldCoverageTests(unittest.TestCase):
    def test_v01_leading_fragment_of_gold_sentence_is_unsupported(self):
        self.assertEqual(classify("deadlines.publish", [sp("Please")]), "unsupported_evidence")

    def test_partial_fragments_are_unsupported_for_every_known_field(self):
        # each fragment lies inside the gold span but covers neither the whole span nor the value
        partial = {
            "brand_name": ["브랜드", "브랜드: 여울"],
            "product_name": ["제품:", "종이새 9"],
            "source_type": ["대여 조건", "조건: lo"],
            "deadlines.write_by": ["초안 제출일:", "2032-02"],
            "deadlines.publish": ["publish on", "03-06."],
            "deadlines.return_by": ["반납일", "2032-03-1"],
        }
        for field, frags in partial.items():
            g = GOLD[field]["evidence"][0]
            for frag in frags:
                s = sp(frag, g["start"])
                self.assertTrue(g["start"] <= s["start"] and s["end"] <= g["end"], (field, frag))
                with self.subTest(field=field, fragment=frag):
                    self.assertEqual(classify(field, [s]), "unsupported_evidence")

    def test_full_gold_span_is_correct_for_every_known_field(self):
        for field, g in GOLD.items():
            with self.subTest(field=field):
                self.assertEqual(classify(field, copy.deepcopy(g["evidence"])), "correct")

    def test_value_bytes_inside_gold_span_are_correct_for_every_known_field(self):
        for field, g in GOLD.items():
            s = sp(g["value"], g["evidence"][0]["start"])
            self.assertLessEqual(s["end"], g["evidence"][0]["end"])
            with self.subTest(field=field):
                self.assertEqual(classify(field, [s]), "correct")

    def test_value_text_outside_the_gold_span_is_unsupported(self):
        # "여울빛" also occurs in the product sentence and in the header; neither is brand gold
        in_product = sp("여울빛", GOLD["product_name"]["evidence"][0]["start"])
        in_header = sp("여울빛", 0)
        self.assertLess(in_header["start"], CONTEXT["start"])
        self.assertEqual(classify("brand_name", [in_product]), "unsupported_evidence")
        self.assertEqual(classify("brand_name", [in_header]), "unsupported_evidence")

    def test_one_codepoint_short_at_either_end_is_unsupported(self):
        v = sp("여울빛")  # brand value inside "브랜드: 여울빛." -- three 3-byte chars
        self.assertEqual(v["end"] - v["start"], 9)
        head_cut = {"start": v["start"] + 3, "end": v["end"], "quote": "울빛"}
        tail_cut = {"start": v["start"], "end": v["end"] - 3, "quote": "여울"}
        self.assertEqual(DATA[head_cut["start"]:head_cut["end"]].decode(), head_cut["quote"])
        self.assertEqual(DATA[tail_cut["start"]:tail_cut["end"]].decode(), tail_cut["quote"])
        self.assertEqual(classify("brand_name", [head_cut]), "unsupported_evidence")
        self.assertEqual(classify("brand_name", [tail_cut]), "unsupported_evidence")
        self.assertEqual(classify("brand_name", [v]), "correct")
        g = GOLD["product_name"]["evidence"][0]  # "제품: 여울빛 종이새 9." minus its last two bytes
        short = {"start": g["start"], "end": g["end"] - 2, "quote": "제품: 여울빛 종이새 "}
        self.assertEqual(DATA[short["start"]:short["end"]].decode(), short["quote"])
        self.assertEqual(classify("product_name", [short]), "unsupported_evidence")

    def test_adjacent_spans_whose_union_covers_gold_are_correct(self):
        g = GOLD["brand_name"]["evidence"][0]  # "브랜드: 여울빛."
        cut = g["start"] + len("브랜드: ".encode())
        left = {"start": g["start"], "end": cut, "quote": "브랜드: "}
        right = {"start": cut, "end": g["end"], "quote": "여울빛."}
        self.assertEqual(classify("brand_name", [left, right]), "correct")
        self.assertEqual(classify("brand_name", [right, left]), "correct")
        # a one-codepoint gap between the pieces is not coverage
        gap = {"start": cut + 3, "end": g["end"], "quote": "울빛."}
        self.assertEqual(classify("brand_name", [left, gap]), "unsupported_evidence")
        # the value bytes may also be covered by adjacent pieces
        yeo = {"start": cut, "end": cut + 6, "quote": "여울"}
        bit = {"start": cut + 6, "end": cut + 9, "quote": "빛"}
        self.assertEqual(classify("brand_name", [bit, yeo]), "correct")

    def test_span_extending_past_gold_inside_context_still_covers(self):
        # policy: overreach is not penalized; only missing gold bytes and off-gold spans are
        g = GOLD["deadlines.publish"]["evidence"][0]
        wide = {"start": g["start"], "end": g["end"] + 1, "quote": "Please publish on 2032-03-06.\n"}
        self.assertEqual(classify("deadlines.publish", [wide]), "correct")

    def test_full_cover_plus_unrelated_extra_span_is_still_unsupported(self):
        spans = [sp("Please publish on 2032-03-06."), sp("반납일: 2032-03-19.")]
        self.assertEqual(classify("deadlines.publish", spans), "unsupported_evidence")

    def test_every_listed_gold_span_must_be_covered(self):
        two = known("2032-03-06", "Please publish on 2032-03-06.", "초안 제출일: 2032-02-29.")
        self.assertEqual(classify(None, [sp("Please publish on 2032-03-06.")], two), "unsupported_evidence")
        self.assertEqual(classify(None, [sp("초안 제출일: 2032-02-29."), sp("Please publish on 2032-03-06.")], two),
                         "correct")
        # second gold span lacks the value text, so it must be covered in full
        self.assertEqual(classify(None, [sp("초안 제출일: 2032-02-29."), sp("2032-03-06")], two), "correct")
        self.assertEqual(classify(None, [sp("초안 제출일:"), sp("2032-03-06")], two), "unsupported_evidence")

    def test_full_cover_outside_context_is_unsupported(self):
        # context containment is still required even when gold bytes are covered
        g = GOLD["brand_name"]["evidence"][0]
        reaching_header = {"start": CONTEXT["start"] - 1, "end": g["end"], "quote": "\n브랜드: 여울빛."}
        self.assertEqual(classify("brand_name", [reaching_header]), "unsupported_evidence")

    def test_value_mismatch_classes_are_unchanged(self):
        full = [sp("Please publish on 2032-03-06.")]
        self.assertEqual(evaluate.classify(GOLD["deadlines.publish"], pv("2032-03-19", full), DATA, CONTEXT),
                         "wrong_value")
        self.assertEqual(evaluate.classify(GOLD["deadlines.publish"], pv("2032-04-30", full), DATA, CONTEXT),
                         "hallucinated_value")


class EvaluateCoverageTests(unittest.TestCase):
    def test_partial_publish_quote_counts_as_unsupported_in_report(self):
        e = env_for("case-1")
        start = e["fields"]["deadlines"]["publish"]["evidence"][0]["start"]
        e["fields"]["deadlines"]["publish"]["evidence"] = [{"start": start, "end": start + 7, "quote": "Publish"}]
        r = evaluate.evaluate(valid_truth(), replay(e), loader)
        self.assertEqual(r["counts"]["correct"], 2)
        self.assertEqual(r["counts"]["unsupported_evidence"], 1)
        row = next(x for x in r["rows"] if x["field"] == "deadlines.publish")
        self.assertEqual(row["class"], "unsupported_evidence")

    def test_fixture_data_is_self_consistent(self):
        self.assertEqual(hashlib.sha256(DATA).hexdigest(), hashlib.sha256(HEADER + BODY).hexdigest())
        for g in GOLD.values():
            for s in g["evidence"]:
                self.assertEqual(DATA[s["start"]:s["end"]].decode(), s["quote"])
                self.assertTrue(CONTEXT["start"] <= s["start"] and s["end"] <= CONTEXT["end"])


if __name__ == "__main__":
    unittest.main()
