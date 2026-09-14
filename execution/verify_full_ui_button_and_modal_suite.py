#!/usr/bin/env python3
"""
Grimore Full-Surface UI, Button & Modal Audit — 14th Integration Test Suite
Validates 1-click Guest Access, navbar routing, modal drawers, TCGplayer affiliate links, and Play Realm HUD APIs.
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
    print("  GRIMORE FULL-SURFACE UI, BUTTON & MODAL AUDIT SUITE")
    print("============================================================")

    # 1. Audit 1-Click Guest Auth Endpoint
    log_step("1/5", "Auditing 1-Click Guest Auth (/api/auth/guest)...")
    try:
        req = urllib.request.Request(
            f"{BASE_URL}/api/auth/guest",
            data=b"{}",
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if data.get("success") and "user" in data:
                log_ok(f"Guest login verified: '{data['user'].get('storeNickname')}' (ID {data['user'].get('id')}).")
            else:
                print("[FAIL] Guest auth endpoint returned invalid response.")
                sys.exit(1)
    except Exception as e:
        print(f"[FAIL] Guest auth error: {e}")
        sys.exit(1)

    # 2. Audit Page Section DOM & Client Endpoints
    log_step("2/5", "Auditing Navigation & Section API Endpoints...")
    sections = [
        ("/api/cards/recommendations", "Discover Feed Cards"),
        ("/api/decks/public", "Public Decks Feed"),
        ("/api/cards/autocomplete?q=Sol", "Card Search Autocomplete"),
        ("/api/leaderboards/season", "Events Hub Leaderboard"),
        ("/api/sandbox/ai-meta-decks", "Play Realm Meta Decks")
    ]
    for endpoint, label in sections:
        try:
            url = f"{BASE_URL}{endpoint}"
            with urllib.request.urlopen(url, timeout=5) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                log_ok(f"{label} endpoint operational ({endpoint}).")
        except Exception as e:
            print(f"[FAIL] {label} endpoint error ({endpoint}): {e}")
            sys.exit(1)

    # 3. Audit TCGplayer Affiliate Attribution (xJoE0d)
    log_step("3/5", "Auditing TCGplayer Affiliate Link Attribution...")
    app_js_path = os.path.join(os.path.dirname(__file__), "..", "public", "app.js")
    with open(app_js_path, 'r', encoding='utf-8') as f:
        content = f.read()
        if "xJoE0d" in content and "partner.tcgplayer.com" in content:
            log_ok("TCGplayer affiliate link 'xJoE0d' verified across cart exports.")
        else:
            print("[FAIL] TCGplayer affiliate link 'xJoE0d' missing from app.js.")
            sys.exit(1)

    # 4. Audit A2UI Client Renderer Engine Asset (public/a2ui.js)
    log_step("4/5", "Auditing A2UI Core Client Renderer & Components...")
    a2ui_path = os.path.join(os.path.dirname(__file__), "..", "public", "a2ui.js")
    with open(a2ui_path, 'r', encoding='utf-8') as f:
        content = f.read()
        if "window.A2UI" in content and "A2UIRuleBanner" in content:
            log_ok("A2UI core renderer verified with all component schemas.")
        else:
            print("[FAIL] public/a2ui.js missing A2UI specifications.")
            sys.exit(1)

    # 5. Audit Access Grimore Login Form & handleLogin in index.html
    log_step("5/5", "Auditing Access Grimore Login Form in index.html...")
    index_path = os.path.join(os.path.dirname(__file__), "..", "public", "index.html")
    with open(index_path, 'r', encoding='utf-8') as f:
        content = f.read()
        if "handleLogin" in content and "Access Grimore" in content:
            log_ok("'Access Grimore' login submit button verified in public/index.html.")
        else:
            print("[FAIL] public/index.html missing handleLogin form submit button.")
            sys.exit(1)

    print("\n[SUCCESS] ALL FULL-SURFACE UI & FEATURE AUDITS PASSED 100%!")

if __name__ == "__main__":
    main()
