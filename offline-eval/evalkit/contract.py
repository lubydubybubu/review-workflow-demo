"""Strict, deterministic validation of the P-M002 AI OUTPUT envelope (custom contract, stdlib only).

This is a documented custom contract, not JSON Schema. Every check returns diagnostics of the
form "<field.path>: <message>"; an empty list means valid. Nothing is coerced, trimmed or defaulted.
"""
import datetime
import hashlib
import re

OUTPUT_CONTRACT = "review-ops.extraction-output/v1"
PROPOSAL_KIND = "extraction_proposal"

SCALAR_FIELDS = ("brand_name", "product_name", "source_type")
DEADLINE_FIELDS = ("write_by", "publish", "embargo", "return_by")
# Scored field paths, in fixed report order.
FIELD_PATHS = SCALAR_FIELDS + tuple("deadlines." + d for d in DEADLINE_FIELDS)

SOURCE_TYPES = ("gift", "loan", "purchase")
STATUSES = ("abstain", "unknown", "value")
MAX_SPANS = 5
MAX_QUOTE = 300
MAX_REASON = 300
MAX_NOTES = 500
VALUE_MAX = {"brand_name": 120, "product_name": 200}

ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
SHA_RE = re.compile(r"[0-9a-f]{64}\Z")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}\Z")
# C0/C1 controls, DEL, bidi overrides/isolates, BOM (mirrors schema.ts). LINE also forbids tab/newline.
CONTROL_RE = re.compile("[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]")
LINE_CONTROL_RE = re.compile("[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]")

ENVELOPE_KEYS = ("contract", "kind", "case_id", "doc_id", "source_sha256",
                 "requires_human_approval", "fields", "notes")
CLAIM_KEYS = ("status", "value", "reason", "evidence")
SPAN_KEYS = ("start", "end", "quote")


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def is_iso_date(v):
    if not isinstance(v, str) or not DATE_RE.match(v):
        return False
    try:
        d = datetime.date.fromisoformat(v)
    except ValueError:
        return False
    return 2000 <= d.year <= 2999


def check_keys(obj, keys, path, errs):
    """Object must be a dict with exactly `keys`. Returns False if not a dict."""
    if not isinstance(obj, dict):
        errs.append("%s: expected object" % (path or "(root)"))
        return False
    prefix = path + "." if path else ""
    for k in keys:
        if k not in obj:
            errs.append("%s%s: missing" % (prefix, k))
    for k in sorted(set(obj) - set(keys), key=str):
        errs.append("%s%s: unknown key" % (prefix, k))
    return True


def check_text(v, path, max_len, errs, multiline=False, nullable=False):
    if v is None and nullable:
        return
    if not isinstance(v, str):
        errs.append("%s: expected string%s" % (path, " or null" if nullable else ""))
        return
    if len(v) > max_len:
        errs.append("%s: too long (max %d)" % (path, max_len))
    if (CONTROL_RE if multiline else LINE_CONTROL_RE).search(v):
        errs.append("%s: control characters are not allowed" % path)


def check_id(v, path, errs):
    if not isinstance(v, str) or not ID_RE.match(v):
        errs.append("%s: expected id matching [a-z0-9][a-z0-9-]{0,63}" % path)


def check_sha(v, path, errs):
    if not isinstance(v, str) or not SHA_RE.match(v):
        errs.append("%s: expected 64 lowercase hex characters" % path)


def check_span(span, path, errs):
    if not check_keys(span, SPAN_KEYS, path, errs):
        return
    ok = True
    for k in ("start", "end"):
        if k in span and not (is_int(span[k]) and span[k] >= 0):
            errs.append("%s.%s: expected non-negative integer" % (path, k))
            ok = False
    if ok and "start" in span and "end" in span and span["end"] <= span["start"]:
        errs.append("%s: end must be greater than start" % path)
    if "quote" in span:
        check_text(span["quote"], path + ".quote", MAX_QUOTE, errs)
        if isinstance(span["quote"], str) and not span["quote"]:
            errs.append("%s.quote: must not be empty" % path)


def check_spans(spans, path, errs):
    if not isinstance(spans, list):
        errs.append("%s: expected array" % path)
        return
    if len(spans) > MAX_SPANS:
        errs.append("%s: too many spans (max %d)" % (path, MAX_SPANS))
    for i, s in enumerate(spans):
        check_span(s, "%s[%d]" % (path, i), errs)


def check_value(field, v, path, errs):
    if field == "source_type":
        if v not in SOURCE_TYPES:
            errs.append("%s: expected one of %s" % (path, ", ".join(SOURCE_TYPES)))
    elif field.startswith("deadlines."):
        if not is_iso_date(v):
            errs.append("%s: expected YYYY-MM-DD date in 2000..2999" % path)
    else:
        check_text(v, path, VALUE_MAX[field], errs)


def check_claim(field, c, path, errs):
    if not check_keys(c, CLAIM_KEYS, path, errs):
        return
    status = c.get("status")
    if status not in STATUSES:
        errs.append("%s.status: expected one of %s" % (path, ", ".join(STATUSES)))
    if "evidence" in c:
        check_spans(c["evidence"], path + ".evidence", errs)
    if status == "value":
        if c.get("value") is None:
            errs.append("%s.value: required when status is 'value'" % path)
        else:
            check_value(field, c["value"], path + ".value", errs)
        if isinstance(c.get("evidence"), list) and not c["evidence"]:
            errs.append("%s.evidence: at least one span required when status is 'value'" % path)
        if "reason" in c:
            check_text(c["reason"], path + ".reason", MAX_REASON, errs, nullable=True)
    elif status in ("unknown", "abstain"):
        if "value" in c and c["value"] is not None:
            errs.append("%s.value: must be null when status is '%s'" % (path, status))
        r = c.get("reason")
        if not isinstance(r, str) or not r:
            errs.append("%s.reason: non-empty string required when status is '%s'" % (path, status))
        else:
            check_text(r, path + ".reason", MAX_REASON, errs)


def validate_output(obj):
    """Shape/type/date/size validation of one OUTPUT envelope. Returns a list of diagnostics."""
    errs = []
    if not check_keys(obj, ENVELOPE_KEYS, "", errs):
        return errs
    if "contract" in obj and obj["contract"] != OUTPUT_CONTRACT:
        errs.append("contract: unsupported version")
    if "kind" in obj and obj["kind"] != PROPOSAL_KIND:
        errs.append("kind: must be '%s'" % PROPOSAL_KIND)
    if "requires_human_approval" in obj and obj["requires_human_approval"] is not True:
        errs.append("requires_human_approval: must be boolean true")
    if "case_id" in obj:
        check_id(obj["case_id"], "case_id", errs)
    if "doc_id" in obj:
        check_id(obj["doc_id"], "doc_id", errs)
    if "source_sha256" in obj:
        check_sha(obj["source_sha256"], "source_sha256", errs)
    if "notes" in obj:
        check_text(obj["notes"], "notes", MAX_NOTES, errs, multiline=True, nullable=True)
    fields = obj.get("fields")
    if "fields" in obj and check_keys(fields, SCALAR_FIELDS + ("deadlines",), "fields", errs):
        for f in SCALAR_FIELDS:
            if f in fields:
                check_claim(f, fields[f], "fields." + f, errs)
        if "deadlines" in fields and check_keys(fields["deadlines"], DEADLINE_FIELDS, "fields.deadlines", errs):
            for d in DEADLINE_FIELDS:
                if d in fields["deadlines"]:
                    check_claim("deadlines." + d, fields["deadlines"][d], "fields.deadlines." + d, errs)
    return errs


def claims(obj):
    """(field_path, claim) pairs of a VALID envelope, in FIELD_PATHS order."""
    f = obj["fields"]
    return [(p, f[p] if "." not in p else f["deadlines"][p.split(".", 1)[1]]) for p in FIELD_PATHS]


# ---- source binding -------------------------------------------------------------------------
# Offset convention: UTF-8 byte offsets into the raw source file, half-open [start, end).
# A span is bound iff end <= len(bytes) and bytes[start:end] decodes (strict UTF-8) to `quote`.

def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def span_bytes_errors(span, path, data):
    if span["end"] > len(data):
        return ["%s: range outside source (%d bytes)" % (path, len(data))]
    try:
        text = data[span["start"]:span["end"]].decode("utf-8")
    except UnicodeDecodeError:
        text = None
    if text != span["quote"]:
        return ["%s.quote: does not match source bytes at [%d,%d)" % (path, span["start"], span["end"])]
    return []


def in_context(span, context):
    return context["start"] <= span["start"] and span["end"] <= context["end"]


def bind_output(env, doc, data):
    """Binding checks for a shape-valid OUTPUT envelope against its case document and file bytes."""
    errs = []
    if sha256_hex(data) != doc["sha256"]:
        errs.append("(document %s): source bytes do not match pinned sha256" % doc["doc_id"])
    if env["doc_id"] != doc["doc_id"]:
        errs.append("doc_id: does not match case document '%s'" % doc["doc_id"])
    if env["source_sha256"] != doc["sha256"]:
        errs.append("source_sha256: does not match source document")
    for field, c in claims(env):
        for i, s in enumerate(c["evidence"]):
            errs += span_bytes_errors(s, "fields.%s.evidence[%d]" % (field, i), data)
    return errs


# ---- AI INPUT envelope ----------------------------------------------------------------------

INPUT_CONTRACT = "review-ops.extraction-input/v1"
OFFSET_UNIT = "utf8_byte_half_open"
MAX_SOURCE_BYTES = 8000
INPUT_KEYS = ("contract", "case_id", "doc_id", "source_sha256", "source_text", "context",
              "offset_unit", "source_text_is_untrusted_data", "output_contract")


def build_input(case_id, doc, data):
    """The envelope a future extractor would receive. Source prose is data, never instructions."""
    return {
        "contract": INPUT_CONTRACT,
        "case_id": case_id,
        "doc_id": doc["doc_id"],
        "source_sha256": sha256_hex(data),
        "source_text": data.decode("utf-8"),
        "context": {"start": doc["context"]["start"], "end": doc["context"]["end"]},
        "offset_unit": OFFSET_UNIT,
        "source_text_is_untrusted_data": True,
        "output_contract": OUTPUT_CONTRACT,
    }


def check_range(rng, path, errs):
    if not check_keys(rng, ("start", "end"), path, errs):
        return False
    for k in ("start", "end"):
        if k not in rng or not (is_int(rng[k]) and rng[k] >= 0):
            errs.append("%s.%s: expected non-negative integer" % (path, k))
            return False
    if rng["end"] <= rng["start"]:
        errs.append("%s: end must be greater than start" % path)
        return False
    return True


def validate_input(env):
    errs = []
    if not check_keys(env, INPUT_KEYS, "", errs):
        return errs
    if env.get("contract") != INPUT_CONTRACT:
        errs.append("contract: unsupported version")
    if env.get("output_contract") != OUTPUT_CONTRACT:
        errs.append("output_contract: unsupported version")
    if env.get("offset_unit") != OFFSET_UNIT:
        errs.append("offset_unit: must be '%s'" % OFFSET_UNIT)
    if env.get("source_text_is_untrusted_data") is not True:
        errs.append("source_text_is_untrusted_data: must be boolean true")
    check_id(env.get("case_id"), "case_id", errs)
    check_id(env.get("doc_id"), "doc_id", errs)
    check_sha(env.get("source_sha256"), "source_sha256", errs)
    text = env.get("source_text")
    if not isinstance(text, str):
        errs.append("source_text: expected string")
        return errs
    data = text.encode("utf-8")
    if len(data) > MAX_SOURCE_BYTES:
        errs.append("source_text: too long (max %d bytes)" % MAX_SOURCE_BYTES)
    if sha256_hex(data) != env.get("source_sha256"):
        errs.append("source_sha256: does not match source_text")
    if "context" in env and check_range(env["context"], "context", errs) and env["context"]["end"] > len(data):
        errs.append("context: range outside source_text")
    return errs


# ---- truth (gold) file ----------------------------------------------------------------------

TRUTH_CONTRACT = "review-ops.extraction-truth/v1"
SYNTHETIC = "synthetic-hand-authored-not-model-output"
MAX_DOCS = 20
MAX_CASES = 50
DOC_KEYS = ("doc_id", "path", "sha256", "context", "context_note")
CASE_KEYS = ("case_id", "doc_id", "fields")


def safe_relpath(p):
    return (isinstance(p, str) and p and not p.startswith("/") and "\\" not in p
            and ".." not in p.split("/") and not LINE_CONTROL_RE.search(p))


def check_truth_claim(field, c, path, errs, data, context):
    if not check_keys(c, CLAIM_KEYS, path, errs):
        return
    status = c.get("status")
    if status not in ("known", "unknown"):
        errs.append("%s.status: expected one of known, unknown" % path)
    if status == "known":
        if c.get("value") is None:
            errs.append("%s.value: required when status is 'known'" % path)
        else:
            check_value(field, c["value"], path + ".value", errs)
        if isinstance(c.get("evidence"), list) and not c["evidence"]:
            errs.append("%s.evidence: at least one span required when status is 'known'" % path)
    elif status == "unknown":
        if c.get("value") is not None:
            errs.append("%s.value: must be null when status is 'unknown'" % path)
    r = c.get("reason")
    if status == "unknown" and (not isinstance(r, str) or not r):
        errs.append("%s.reason: non-empty string required when status is 'unknown'" % path)
    elif "reason" in c:
        check_text(r, path + ".reason", MAX_REASON, errs, nullable=True)
    if "evidence" not in c:
        return
    before = len(errs)
    check_spans(c["evidence"], path + ".evidence", errs)
    if len(errs) > before or data is None:
        return
    for i, s in enumerate(c["evidence"]):
        sp = "%s.evidence[%d]" % (path, i)
        e = span_bytes_errors(s, sp, data)
        errs += e
        if not e and not in_context(s, context):
            errs.append("%s: outside document context range" % sp)


def validate_truth(truth, load):
    """Validate the gold file. `load(relpath) -> bytes` reads corpus files."""
    errs = []
    if not check_keys(truth, ("contract", "classification", "documents", "cases"), "", errs):
        return errs
    if truth.get("contract") != TRUTH_CONTRACT:
        errs.append("contract: unsupported version")
    if truth.get("classification") != SYNTHETIC:
        errs.append("classification: must be '%s'" % SYNTHETIC)
    docs = {}
    dlist = truth.get("documents")
    if not isinstance(dlist, list) or not 1 <= len(dlist) <= MAX_DOCS:
        errs.append("documents: expected array of 1..%d" % MAX_DOCS)
        dlist = []
    for i, d in enumerate(dlist):
        p = "documents[%d]" % i
        if not check_keys(d, DOC_KEYS, p, errs):
            continue
        check_id(d.get("doc_id"), p + ".doc_id", errs)
        check_sha(d.get("sha256"), p + ".sha256", errs)
        check_text(d.get("context_note"), p + ".context_note", MAX_REASON, errs)
        if d.get("doc_id") in docs:
            errs.append("%s.doc_id: duplicate '%s'" % (p, d["doc_id"]))
            continue
        data = None
        if not safe_relpath(d.get("path")):
            errs.append("%s.path: must be a relative path inside the corpus" % p)
        else:
            try:
                data = load(d["path"])
            except OSError:
                errs.append("%s.path: cannot read file" % p)
        if data is not None:
            if len(data) > MAX_SOURCE_BYTES:
                errs.append("%s: source too large (max %d bytes)" % (p, MAX_SOURCE_BYTES))
            if sha256_hex(data) != d.get("sha256"):
                errs.append("%s.sha256: does not match file bytes" % p)
                data = None
        ok_ctx = "context" in d and check_range(d["context"], p + ".context", errs)
        if ok_ctx and data is not None and d["context"]["end"] > len(data):
            errs.append("%s.context: range outside source" % p)
            ok_ctx = False
        if isinstance(d.get("doc_id"), str):
            docs[d["doc_id"]] = (data if ok_ctx else None, d.get("context"))
    seen = set()
    clist = truth.get("cases")
    if not isinstance(clist, list) or not 1 <= len(clist) <= MAX_CASES:
        errs.append("cases: expected array of 1..%d" % MAX_CASES)
        clist = []
    for i, c in enumerate(clist):
        p = "cases[%d]" % i
        if not check_keys(c, CASE_KEYS, p, errs):
            continue
        check_id(c.get("case_id"), p + ".case_id", errs)
        if c.get("case_id") in seen:
            errs.append("%s.case_id: duplicate '%s'" % (p, c["case_id"]))
        seen.add(c.get("case_id"))
        data, ctx = None, None
        if c.get("doc_id") not in docs:
            errs.append("%s.doc_id: unknown document '%s'" % (p, c.get("doc_id")))
        else:
            data, ctx = docs[c["doc_id"]]
        f = c.get("fields")
        if "fields" in c and check_keys(f, SCALAR_FIELDS + ("deadlines",), p + ".fields", errs):
            for name in SCALAR_FIELDS:
                if name in f:
                    check_truth_claim(name, f[name], "%s.fields.%s" % (p, name), errs, data, ctx)
            if "deadlines" in f and check_keys(f["deadlines"], DEADLINE_FIELDS, p + ".fields.deadlines", errs):
                for dname in DEADLINE_FIELDS:
                    if dname in f["deadlines"]:
                        check_truth_claim("deadlines." + dname, f["deadlines"][dname],
                                          "%s.fields.deadlines.%s" % (p, dname), errs, data, ctx)
    return errs
