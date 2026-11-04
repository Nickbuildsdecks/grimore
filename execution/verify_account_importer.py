#!/usr/bin/env python3
"""
Grimore Universal Account Migration Integration Test

Logs in through `execution/grimore_session.py` rather than rolling its own auth. What it had before
was:

    try:
        res = opener.open(login_request)
    except urllib.error.HTTPError:
        res = opener.open(register_request)

and `/api/auth/register` does not log you in — it answers "You can now log in" and sets no session.
So on any database without that account the suite carried straight on **anonymously**, and
`/api/decks/import-account` was being measured against a logged-out caller. The helper raises if
either step fails, which is the difference between a check that reports a problem and one that
reports a different thing. See D355.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grimore_session import logged_in_opener, post_json

def test_account_importer():
    print("=== Testing Universal Account Migration Endpoint ===")

    opener = logged_in_opener()

    raw_text = """// Universal Test Deck 1
1 Sol Ring
1 Command Tower
1 Kaalia of the Vast *CMDR*

// Universal Test Deck 2
1 Yuriko, the Tiger's Shadow *CMDR*
1 Ponder
1 Brainstorm
"""
    status, data = post_json(opener, "/api/decks/import-account", {
        "platform": "text",
        "decksText": raw_text,
    }, timeout=30)
    print(f"Import Result: HTTP {status} {data}")
    assert status == 200, f"expected HTTP 200, got {status}: {data}"
    assert data.get("success") is True, f"import did not report success: {data}"
    assert data.get("count") == 2, f"Expected 2 imported decks, got {data.get('count')}"
    print("Universal Account Migration Integration Test Passed!")

if __name__ == "__main__":
    test_account_importer()
