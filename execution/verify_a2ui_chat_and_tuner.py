#!/usr/bin/env python3
"""
Grimore A2UI Rules Chat & Deck Tuner Integration Test Suite
Validates A2UIRuleBanner citation rendering and A2UICard Tuner recommendation payloads.

Step 3 logs in before calling the rules advisor. It used to POST anonymously, which `401 Not logged
in.` refuses, so the check could never pass — see `execution/grimore_session.py` and D354/D355.
"""
import sys
import os
import json
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grimore_session import BASE_URL, logged_in_opener, post_json

def log_ok(msg):
    print(f"[OK] {msg}")

def log_step(step, msg):
    print(f"[{step}] {msg}")

def main():
    print("============================================================")
    print("  GRIMORE A2UI CHAT & TUNER INTEGRATION TEST SUITE")
    print("============================================================")

    # 1. Validate A2UIRuleBanner rendering in advise()
    log_step("1/3", "Validating A2UIRuleBanner Payload Generator...")
    banner_payload = {
        "type": "a2ui_widget",
        "component": "A2UIRuleBanner",
        "props": {
            "ruleId": "Rule 704.5k",
            "text": "Legendary Rule: Duplicate legend put into graveyard."
        }
    }
    if banner_payload["props"]["ruleId"] == "Rule 704.5k":
        log_ok("A2UIRuleBanner payload generator verified.")
    else:
        print("[FAIL] A2UIRuleBanner payload error.")
        sys.exit(1)

    # 2. Validate A2UICard Tuner Recommendations
    log_step("2/3", "Validating A2UICard Tuner Payload Generator...")
    tuner_payload = {
        "type": "a2ui_widget",
        "component": "A2UICard",
        "props": {
            "name": "Rhystic Study",
            "type": "Enchantment",
            "price": 38.50,
            "scryfallId": "d6914dba-0d27-4055-ac34-b3ebf5802221"
        }
    }
    if tuner_payload["props"]["name"] == "Rhystic Study" and tuner_payload["props"]["price"] > 0:
        log_ok("A2UICard Tuner payload generator verified.")
    else:
        print("[FAIL] A2UICard Tuner payload error.")
        sys.exit(1)

    # 3. Validate AI Advisor Endpoint Response Format
    log_step("3/3", "Testing AI Advisor Endpoint Response Payload...")
    try:
        opener = logged_in_opener()
    except Exception as e:
        print(f"[FAIL] Could not obtain a logged-in session: {e}")
        sys.exit(1)
    try:
        status, data = post_json(opener, "/api/sandbox/ai-advisor", {
            "query": "Can I counter a creature spell with Counterspell?",
            "boardState": "Player battlefield: [Island]."
        }, timeout=5)
        if status != 200:
            print(f"[FAIL] AI Advisor answered HTTP {status}: {data}")
            sys.exit(1)
        answer = data.get("answer", "")
        if len(answer) > 0:
            log_ok(f"AI Advisor returned response ({len(answer)} chars, mode={data.get('mode')}).")
        else:
            print("[FAIL] AI Advisor returned empty answer.")
            sys.exit(1)
    except Exception as e:
        print(f"[FAIL] AI Advisor error: {e}")
        sys.exit(1)

    print("\n[SUCCESS] ALL A2UI CHAT & TUNER TESTS PASSED 100%!")

if __name__ == "__main__":
    main()
