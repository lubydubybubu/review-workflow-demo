"""Slice 1: strict shape/type/date validation of the AI OUTPUT envelope (no source binding yet)."""
import copy
import unittest

from evalkit import contract


def claim(value, start=0, end=4, quote="abcd"):
    return {"status": "value", "value": value, "reason": None,
            "evidence": [{"start": start, "end": end, "quote": quote}]}


def unknown(reason="not stated"):
    return {"status": "unknown", "value": None, "reason": reason, "evidence": []}


def valid_envelope():
    return {
        "contract": "review-ops.extraction-output/v1",
        "kind": "extraction_proposal",
        "case_id": "case-1",
        "doc_id": "doc-1",
        "source_sha256": "0" * 64,
        "requires_human_approval": True,
        "fields": {
            "brand_name": claim("Lumora"),
            "product_name": unknown(),
            "source_type": claim("loan"),
            "deadlines": {
                "write_by": unknown(),
                "publish": claim("2026-11-20"),
                "embargo": {"status": "abstain", "value": None, "reason": "conflicting", "evidence": []},
                "return_by": unknown(),
            },
        },
        "notes": None,
    }


class OutputShapeTests(unittest.TestCase):
    def errors(self, env):
        return contract.validate_output(env)

    def test_valid_envelope_has_no_errors(self):
        self.assertEqual(self.errors(valid_envelope()), [])

    def test_missing_top_level_key_reports_path(self):
        env = valid_envelope()
        del env["doc_id"]
        self.assertIn("doc_id: missing", self.errors(env))

    def test_unknown_key_rejected_everywhere(self):
        env = valid_envelope()
        env["approved"] = True
        env["fields"]["deadlines"]["ship_by"] = unknown()
        env["fields"]["brand_name"]["confidence"] = 0.9
        errs = self.errors(env)
        self.assertIn("approved: unknown key", errs)
        self.assertIn("fields.deadlines.ship_by: unknown key", errs)
        self.assertIn("fields.brand_name.confidence: unknown key", errs)

    def test_missing_field_claim_reports_path(self):
        env = valid_envelope()
        del env["fields"]["deadlines"]["return_by"]
        self.assertIn("fields.deadlines.return_by: missing", self.errors(env))

    def test_human_approval_flag_must_be_literal_true(self):
        for bad in (False, 1, "true", None):
            env = valid_envelope()
            env["requires_human_approval"] = bad
            self.assertIn("requires_human_approval: must be boolean true", self.errors(env), bad)

    def test_kind_must_be_proposal(self):
        env = valid_envelope()
        env["kind"] = "approval"
        self.assertIn("kind: must be 'extraction_proposal'", self.errors(env))

    def test_wrong_contract_version(self):
        env = valid_envelope()
        env["contract"] = "review-ops.extraction-output/v2"
        self.assertIn("contract: unsupported version", self.errors(env))

    def test_offsets_reject_bool_float_and_negative(self):
        for bad in (True, 1.0, -1, "0"):
            env = valid_envelope()
            env["fields"]["brand_name"]["evidence"][0]["start"] = bad
            self.assertIn("fields.brand_name.evidence[0].start: expected non-negative integer",
                          self.errors(env), bad)

    def test_end_must_exceed_start(self):
        env = valid_envelope()
        env["fields"]["brand_name"]["evidence"][0]["end"] = 0
        self.assertIn("fields.brand_name.evidence[0]: end must be greater than start", self.errors(env))

    def test_invalid_dates_rejected(self):
        for bad in ("2026-02-30", "2026-1-05", "26-11-20", "2026/11/20", "3001-01-01", "2026-11-20T00:00:00Z", 20261120):
            env = valid_envelope()
            env["fields"]["deadlines"]["publish"]["value"] = bad
            self.assertIn("fields.deadlines.publish.value: expected YYYY-MM-DD date in 2000..2999",
                          self.errors(env), bad)

    def test_source_type_value_enum(self):
        env = valid_envelope()
        env["fields"]["source_type"]["value"] = "unknown"
        self.assertIn("fields.source_type.value: expected one of gift, loan, purchase", self.errors(env))

    def test_status_value_requires_value_and_evidence(self):
        env = valid_envelope()
        env["fields"]["brand_name"]["value"] = None
        env["fields"]["brand_name"]["evidence"] = []
        errs = self.errors(env)
        self.assertIn("fields.brand_name.value: required when status is 'value'", errs)
        self.assertIn("fields.brand_name.evidence: at least one span required when status is 'value'", errs)

    def test_unknown_and_abstain_require_null_value_and_reason(self):
        env = valid_envelope()
        env["fields"]["product_name"]["value"] = "Arc 2"
        env["fields"]["deadlines"]["embargo"]["reason"] = ""
        errs = self.errors(env)
        self.assertIn("fields.product_name.value: must be null when status is 'unknown'", errs)
        self.assertIn("fields.deadlines.embargo.reason: non-empty string required when status is 'abstain'", errs)

    def test_bad_status(self):
        env = valid_envelope()
        env["fields"]["brand_name"]["status"] = "guess"
        self.assertIn("fields.brand_name.status: expected one of abstain, unknown, value", self.errors(env))

    def test_size_bounds_and_control_characters(self):
        env = valid_envelope()
        env["fields"]["brand_name"]["value"] = "x" * 121
        env["notes"] = "y" * 501
        env["fields"]["product_name"]["reason"] = "line‮break"
        errs = self.errors(env)
        self.assertIn("fields.brand_name.value: too long (max 120)", errs)
        self.assertIn("notes: too long (max 500)", errs)
        self.assertIn("fields.product_name.reason: control characters are not allowed", errs)

    def test_too_many_evidence_spans(self):
        env = valid_envelope()
        env["fields"]["brand_name"]["evidence"] = [copy.deepcopy(env["fields"]["brand_name"]["evidence"][0])] * 6
        self.assertIn("fields.brand_name.evidence: too many spans (max 5)", self.errors(env))

    def test_ids_and_hash_format(self):
        env = valid_envelope()
        env["case_id"] = "Case 1"
        env["source_sha256"] = "ABC"
        errs = self.errors(env)
        self.assertIn("case_id: expected id matching [a-z0-9][a-z0-9-]{0,63}", errs)
        self.assertIn("source_sha256: expected 64 lowercase hex characters", errs)

    def test_non_object_root(self):
        self.assertEqual(self.errors([]), ["(root): expected object"])


if __name__ == "__main__":
    unittest.main()
