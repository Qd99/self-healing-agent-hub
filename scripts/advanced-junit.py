"""Bounded metadata-only JUnit/pytest XML parser."""
import sys
import hashlib
import json
import re
import xml.etree.ElementTree as ET

def parse(raw):
    if len(raw) > 262144 or re.search(rb"<!\s*(?:DOCTYPE|ENTITY)", raw, re.I) or b"\x00" in raw:
        raise ValueError("unsafe XML")
    root = ET.fromstring(raw)
    if root.tag not in ("testsuites", "testsuite"):
        raise ValueError("invalid JUnit root")
    rows, attempts = [], {}
    for case in root.iter("testcase"):
        cls, name = case.get("classname", ""), case.get("name", "")
        if len(rows) >= 2000 or not name or len(cls) > 1000 or len(name) > 1000:
            raise ValueError("invalid case")
        key = hashlib.sha256(json.dumps([cls, name], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        attempts[key] = attempts.get(key, 0) + 1
        fail, error, skip = case.find("failure"), case.find("error"), case.find("skipped")
        flaky = any(x.tag in ("flakyFailure", "flakyError", "rerunFailure", "rerunError") for x in case)
        assertion = fail is not None and bool(re.search(r"(?:^|[.$])(?:AssertionError|AssertionFailedError|ComparisonFailure)$", fail.get("type", "")))
        result = "unknown" if flaky else "error" if error is not None else "skip" if skip is not None else "fail" if fail is not None else "pass"
        duration = None
        try:
            n = float(case.get("time", "nan"))
            if 0 <= n <= 86400:
                duration = round(n * 1000)
        except ValueError:
            pass
        rows.append(dict(id=key, attempt=attempts[key], result=result, assertion=assertion and result == "fail", durationMs=duration))
    if not rows:
        raise ValueError("empty report")
    for suite in root.iter("testsuite"):
        declared = suite.get("tests")
        if declared is not None and int(declared) != len(list(suite.iter("testcase"))):
            raise ValueError("incomplete report")
    return rows

if __name__ == "__main__":
    try:
        print(json.dumps(parse(sys.stdin.buffer.read(262145)), separators=(",", ":")))
    except Exception:
        sys.stderr.write("JUnit report malformed or incomplete\n")
        sys.exit(2)
