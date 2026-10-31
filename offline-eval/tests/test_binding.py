"""Slice 2: exact source binding (hash, doc id, byte-offset quotes), input envelope, truth file checks."""
import copy
import hashlib
import unittest

from evalkit import contract
from tests.test_contract_output import valid_envelope

HEADER = b"From: a@b.example\nSubject: Re: Lumora\n\n"
BODY = b"Lumora will lend the Arc 2 lamp. Publish on 2026-11-20.\n"
DATA = HEADER + BODY
SHA = hashlib.sha256(DATA).hexdigest()


def span(text):
    start = DATA.index(text.encode())
    return {"start": start, "end": start + len(text.encode()), "quote": text}


def doc():
    return {"doc_id": "doc-1", "path": "sources/doc-1.txt", "sha256": SHA,
            "context": {"start": len(HEADER), "end": len(DATA)}, "context_note": "body only"}


def bound_envelope():
    env = valid_envelope()
    env["source_sha256"] = SHA
    env["fields"]["brand_name"]["evidence"] = [span("Lumora will lend")]
    env["fields"]["source_type"]["evidence"] = [span("lend")]
    env["fields"]["deadlines"]["publish"]["evidence"] = [span("Publish on 2026-11-20.")]
    return env


class BindingTests(unittest.TestCase):
    def test_bound_envelope_ok(self):
        self.assertEqual(contract.bind_output(bound_envelope(), doc(), DATA), [])

    def test_hash_mismatch(self):
        env = bound_envelope()
        env["source_sha256"] = "f" * 64
        self.assertIn("source_sha256: does not match source document", contract.bind_output(env, doc(), DATA))

    def test_doc_bytes_must_match_pinned_hash(self):
        self.assertIn("(document doc-1): source bytes do not match pinned sha256",
                      contract.bind_output(bound_envelope(), doc(), DATA + b"x"))

    def test_doc_id_mismatch(self):
        env = bound_envelope()
        env["doc_id"] = "doc-2"
        self.assertIn("doc_id: does not match case document 'doc-1'", contract.bind_output(env, doc(), DATA))

    def test_quote_must_equal_bytes_at_offsets(self):
        env = bound_envelope()
        s = env["fields"]["deadlines"]["publish"]["evidence"][0]
        s["quote"] = "Publish on 2026-11-21."
        self.assertIn("fields.deadlines.publish.evidence[0].quote: does not match source bytes at [%d,%d)"
                      % (s["start"], s["end"]), contract.bind_output(env, doc(), DATA))

    def test_range_past_end_of_source(self):
        env = bound_envelope()
        env["fields"]["brand_name"]["evidence"][0] = {"start": len(DATA) - 1, "end": len(DATA) + 5, "quote": "x"}
        self.assertIn("fields.brand_name.evidence[0]: range outside source (%d bytes)" % len(DATA),
                      contract.bind_output(env, doc(), DATA))

    def test_offsets_are_utf8_bytes(self):
        data = "Brand: Café Ø\n".encode()
        d = {"doc_id": "doc-1", "path": "x.txt", "sha256": hashlib.sha256(data).hexdigest(),
             "context": {"start": 0, "end": len(data)}, "context_note": "all"}
        env = valid_envelope()
        env["source_sha256"] = d["sha256"]
        for f in ("brand_name", "source_type"):
            env["fields"][f]["evidence"] = [{"start": 7, "end": 12, "quote": "Café"}]
        env["fields"]["deadlines"]["publish"]["evidence"] = [{"start": 7, "end": 15, "quote": "Café Ø"}]
        self.assertEqual(contract.bind_output(env, d, data), [])
        env["fields"]["brand_name"]["evidence"] = [{"start": 7, "end": 11, "quote": "Café"}]
        self.assertTrue(contract.bind_output(env, d, data))


class InputEnvelopeTests(unittest.TestCase):
    def test_build_and_validate_input(self):
        env = contract.build_input("case-1", doc(), DATA)
        self.assertEqual(env["contract"], "review-ops.extraction-input/v1")
        self.assertIs(env["source_text_is_untrusted_data"], True)
        self.assertEqual(env["offset_unit"], "utf8_byte_half_open")
        self.assertEqual(contract.validate_input(env), [])

    def test_input_hash_and_context_checked(self):
        env = contract.build_input("case-1", doc(), DATA)
        env["source_text"] += "tampered"
        env["context"]["end"] = 10 ** 6
        errs = contract.validate_input(env)
        self.assertIn("source_sha256: does not match source_text", errs)
        self.assertIn("context: range outside source_text", errs)

    def test_input_strict_keys_and_size(self):
        env = contract.build_input("case-1", doc(), DATA)
        env["auto_approve"] = True
        env["source_text"] = "x" * 8001
        env["source_text_is_untrusted_data"] = 1
        errs = contract.validate_input(env)
        self.assertIn("auto_approve: unknown key", errs)
        self.assertIn("source_text: too long (max 8000 bytes)", errs)
        self.assertIn("source_text_is_untrusted_data: must be boolean true", errs)


def truth_claim(value, text):
    return {"status": "known", "value": value, "reason": None, "evidence": [span(text)]}


def truth_unknown(reason="not stated"):
    return {"status": "unknown", "value": None, "reason": reason, "evidence": []}


def valid_truth():
    return {
        "contract": "review-ops.extraction-truth/v1",
        "classification": "synthetic-hand-authored-not-model-output",
        "documents": [doc()],
        "cases": [{
            "case_id": "case-1", "doc_id": "doc-1",
            "fields": {
                "brand_name": truth_claim("Lumora", "Lumora will lend"),
                "product_name": truth_unknown(),
                "source_type": truth_claim("loan", "lend"),
                "deadlines": {"write_by": truth_unknown(), "publish": truth_claim("2026-11-20", "Publish on 2026-11-20."),
                              "embargo": truth_unknown(), "return_by": truth_unknown()},
            },
        }],
    }


def loader(path):
    if path == "sources/doc-1.txt":
        return DATA
    raise FileNotFoundError(path)


class TruthTests(unittest.TestCase):
    def test_valid_truth(self):
        self.assertEqual(contract.validate_truth(valid_truth(), loader), [])

    def test_truth_duplicate_case_and_unknown_doc(self):
        t = valid_truth()
        t["cases"].append(copy.deepcopy(t["cases"][0]))
        t["cases"][1]["doc_id"] = "doc-9"
        errs = contract.validate_truth(t, loader)
        self.assertIn("cases[1].case_id: duplicate 'case-1'", errs)
        self.assertIn("cases[1].doc_id: unknown document 'doc-9'", errs)

    def test_truth_known_needs_evidence_inside_context(self):
        t = valid_truth()
        t["cases"][0]["fields"]["brand_name"]["evidence"] = [{"start": 0, "end": 4, "quote": "From"}]
        t["cases"][0]["fields"]["product_name"] = {"status": "known", "value": "Arc 2", "reason": None, "evidence": []}
        errs = contract.validate_truth(t, loader)
        self.assertIn("cases[0].fields.brand_name.evidence[0]: outside document context range", errs)
        self.assertIn("cases[0].fields.product_name.evidence: at least one span required when status is 'known'", errs)

    def test_truth_rejects_guessed_dates_and_unsafe_paths(self):
        t = valid_truth()
        t["cases"][0]["fields"]["deadlines"]["embargo"] = {"status": "unknown", "value": "2026-11-18",
                                                            "reason": "x", "evidence": []}
        t["documents"][0]["path"] = "../secret.txt"
        errs = contract.validate_truth(t, loader)
        self.assertIn("cases[0].fields.deadlines.embargo.value: must be null when status is 'unknown'", errs)
        self.assertIn("documents[0].path: must be a relative path inside the corpus", errs)

    def test_truth_hash_mismatch_and_missing_file(self):
        t = valid_truth()
        t["documents"][0]["sha256"] = "a" * 64
        self.assertIn("documents[0].sha256: does not match file bytes", contract.validate_truth(t, loader))
        t["documents"][0]["path"] = "sources/missing.txt"
        self.assertIn("documents[0].path: cannot read file", contract.validate_truth(t, loader))


if __name__ == "__main__":
    unittest.main()
