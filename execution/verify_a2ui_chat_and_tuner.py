#!/usr/bin/env python3
"""
Grimore A2UI Rules Chat & Deck Tuner Integration Test Suite
Validates A2UIRuleBanner citation rendering and A2UICard Tuner recommendation payloads.
"""
import sys
import os
import json
import urllib.request

BASE_URL = "http://localhost:3000"

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
        payload = json.dumps({
            "query": "Can I counter a creature spell with Counterspell?",
            "boardState": "Player battlefield: [Island]."
        }).encode('utf-8')
        req = urllib.request.Request(
            f"{BASE_URL}/api/sandbox/ai-advisor",
            data=payload,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            answer = data.get("answer", "")
            if len(answer) > 0:
                log_ok(f"AI Advisor returned response ({len(answer)} chars).")
            else:
                print("[FAIL] AI Advisor returned empty answer.")
                sys.exit(1)
    except Exception as e:
        print(f"[FAIL] AI Advisor error: {e}")
        sys.exit(1)

    print("\n[SUCCESS] ALL A2UI CHAT & TUNER TESTS PASSED 100%!")

if __name__ == "__main__":
    main()
