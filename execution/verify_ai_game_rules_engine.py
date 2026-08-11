#!/usr/bin/env python3
"""
Verification Script for MTG 1v1 Modern & EDH Rules Engine & AI Arena
Tests AI meta decks endpoint, deck parsing endpoint, and card details lookups.
"""
import urllib.request
import json
import sys

BASE_URL = "http://localhost:3000"

def test_ai_meta_decks():
    print("[1/3] Validating AI Opponent Meta Decks Endpoint...")
    req = urllib.request.Request(f"{BASE_URL}/api/sandbox/ai-meta-decks")
    with urllib.request.urlopen(req) as resp:
        assert resp.status == 200, f"Expected 200, got {resp.status}"
        data = json.loads(resp.read().decode('utf-8'))
        decks = data.get('decks', [])
        assert len(decks) >= 3, f"Expected at least 3 AI meta decks, got {len(decks)}"
        print(f"[OK] {len(decks)} AI preset meta decks loaded successfully.")
        for d in decks:
            print(f"  - {d['name']} ({d['format'].upper()}) [{len(d['cards'])} unique card entries]")

def test_deck_parser():
    print("[2/3] Validating Custom Deck Parser Endpoint...")
    test_deck_text = """
    // Modern Burn Test List
    4 Goblin Guide
    4 Monastery Swiftspear
    4 Lightning Bolt
    4 Lava Spike
    12 Mountain
    """
    post_data = json.dumps({"deckText": test_deck_text, "format": "modern"}).encode('utf-8')
    req = urllib.request.Request(f"{BASE_URL}/api/sandbox/parse-deck", data=post_data, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as resp:
        assert resp.status == 200, f"Expected 200, got {resp.status}"
        data = json.loads(resp.read().decode('utf-8'))
        cards = data.get('cards', [])
        assert len(cards) == 5, f"Expected 5 parsed card entries, got {len(cards)}"
        print(f"[OK] Deck parser parsed {len(cards)} card entries cleanly.")

def test_card_rules_details():
    print("[3/3] Validating Rules Engine Card Details Batch...")
    post_data = json.dumps({"names": ["Goblin Guide", "Lightning Bolt", "Murktide Regent"]}).encode('utf-8')
    req = urllib.request.Request(f"{BASE_URL}/api/cards/details-batch", data=post_data, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as resp:
        assert resp.status == 200, f"Expected 200, got {resp.status}"
        data = json.loads(resp.read().decode('utf-8'))
        assert len(data) == 3, f"Expected 3 details, got {len(data)}"
        print(f"[OK] Scryfall details batch verified for rules engine.")

def main():
    try:
        test_ai_meta_decks()
        test_deck_parser()
        test_card_rules_details()
        print("\n[SUCCESS] ALL AI RULES ENGINE & ARENA INTEGRATION TESTS PASSED 100%!")
    except Exception as e:
        print(f"FAILED Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
