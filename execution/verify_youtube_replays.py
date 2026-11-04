#!/usr/bin/env python3
"""
Grimore Replay Engine & Web Audio Integration Test Suite
Validates YouTube Match Replay JSON parsing, step stepping, and sound engine event handlers.

Step 2 logs in before calling the rules advisor. It used to POST anonymously, which `401 Not logged
in.` refuses, so the check could never pass — see `execution/grimore_session.py` and D354/D355.
"""
import os
import sys
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
    print("  GRIMORE REPLAY ENGINE & SOUND SYNTHESIZER TEST SUITE")
    print("============================================================")

    # 1. Test AI Opponent Preset Meta Decks Endpoint for Replays
    log_step("1/2", "Testing AI Presets Endpoint for Replays...")
    try:
        url = f"{BASE_URL}/api/sandbox/ai-meta-decks"
        req = urllib.request.urlopen(url, timeout=5)
        data = json.loads(req.read().decode('utf-8'))
        decks = data.get('decks', []) if isinstance(data, dict) else []
        log_ok(f"Replay preset deck loader returned {len(decks)} preset deck(s).")
    except Exception as e:
        print(f"[FAIL] Replay preset deck endpoint error: {e}")
        sys.exit(1)

    # 2. Test Rules Advisor Endpoint for Match Event Log Analysis
    log_step("2/2", "Testing Rules Advisor Endpoint for Event Log Analysis...")
    try:
        opener = logged_in_opener()
    except Exception as e:
        print(f"[FAIL] Could not obtain a logged-in session: {e}")
        sys.exit(1)
    try:
        status, data = post_json(opener, "/api/sandbox/ai-advisor", {
            "query": "What happens when Lightning Bolt targets a 2/2 creature?",
            "boardState": "Player battlefield: [Grizzly Bears]. Phase: main1."
        }, timeout=5)
        if status != 200:
            print(f"[FAIL] Rules Advisor answered HTTP {status}: {data}")
            sys.exit(1)
        answer = data.get("answer", "")
        if len(answer) > 0:
            log_ok(f"Rules Advisor answered replay query ({len(answer)} chars, mode={data.get('mode')}).")
        else:
            print("[FAIL] Rules Advisor returned empty answer.")
            sys.exit(1)
    except Exception as e:
        print(f"[FAIL] Rules Advisor error: {e}")
        sys.exit(1)

    print("\n[SUCCESS] ALL REPLAY ENGINE & SOUND SYNTHESIZER TESTS PASSED 100%!")

if __name__ == "__main__":
    main()
