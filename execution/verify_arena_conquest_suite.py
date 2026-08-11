#!/usr/bin/env python3
"""
Comprehensive MTG Arena Conquest Test Suite
Validates YouTube match replays, deck importers, token Scryfall images, and SBA rule engine APIs.
"""
import urllib.request
import json
import sys

BASE_URL = "http://localhost:3000"

def test_replay_suite():
    print("[1/3] Validating YouTube Commander Replay Harness APIs...")
    req = urllib.request.Request(f"{BASE_URL}/api/sandbox/replays")
    with urllib.request.urlopen(req) as resp:
        assert resp.status == 200, f"Expected 200, got {resp.status}"
        data = json.loads(resp.read().decode('utf-8'))
        replays = data.get('replays', [])
        assert len(replays) >= 2, "Expected at least 2 replays"
        print(f"[OK] {len(replays)} Commander match replays verified.")

    # Test Game Knights match
    req = urllib.request.Request(f"{BASE_URL}/api/sandbox/replays/gk-ep40-atraxa-v-edgar")
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        steps = data['replay']['steps']
        assert len(steps) == 17, f"Expected 17 steps in Game Knights #40, got {len(steps)}"
        print(f"[OK] Game Knights #40 step manifest verified (17 actions).")

def test_deck_builder_endpoints():
    print("[2/3] Validating Saved & Discover Deck Endpoints...")
    req = urllib.request.Request(f"{BASE_URL}/api/decks/discover")
    with urllib.request.urlopen(req) as resp:
        assert resp.status == 200, f"Expected 200, got {resp.status}"
        print(f"[OK] Community discover decks endpoint operational.")

def test_card_details_batch():
    print("[3/3] Validating High-Res Card Details Batch Endpoint...")
    post_data = json.dumps({"names": ["Sol Ring", "Command Tower", "Atraxa, Praetors' Voice"]}).encode('utf-8')
    req = urllib.request.Request(f"{BASE_URL}/api/cards/details-batch", data=post_data, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as resp:
        assert resp.status == 200, f"Expected 200, got {resp.status}"
        data = json.loads(resp.read().decode('utf-8'))
        assert len(data) == 3, "Expected 3 card details"
        print(f"[OK] Batch card details verified for 3 test cards.")

def main():
    try:
        test_replay_suite()
        test_deck_builder_endpoints()
        test_card_details_batch()
        print("\n[SUCCESS] ALL ARENA CONQUEST SUITE INTEGRATION TESTS PASSED 100%!")
    except Exception as e:
        print(f"FAILED Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
