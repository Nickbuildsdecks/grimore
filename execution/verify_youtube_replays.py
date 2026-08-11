#!/usr/bin/env python3
"""
Verify YouTube Commander Match Replay Endpoints
Tests /api/sandbox/replays and /api/sandbox/replays/:replayId
"""
import urllib.request
import json
import sys

BASE_URL = "http://localhost:3000"

def test_replays_api():
    print("[1/3] Testing GET /api/sandbox/replays...")
    req = urllib.request.Request(f"{BASE_URL}/api/sandbox/replays")
    with urllib.request.urlopen(req) as resp:
        assert resp.status == 200, f"Expected 200, got {resp.status}"
        data = json.loads(resp.read().decode('utf-8'))
        assert data.get('success') is True, "Expected success: true"
        replays = data.get('replays', [])
        assert len(replays) >= 2, f"Expected at least 2 replays, got {len(replays)}"
        print(f"[OK] Found {len(replays)} pre-configured YouTube Commander match replays.")
        return replays

def test_single_replay(replay_id):
    print(f"[2/3] Testing GET /api/sandbox/replays/{replay_id}...")
    req = urllib.request.Request(f"{BASE_URL}/api/sandbox/replays/{replay_id}")
    with urllib.request.urlopen(req) as resp:
        assert resp.status == 200, f"Expected 200, got {resp.status}"
        data = json.loads(resp.read().decode('utf-8'))
        assert data.get('success') is True, "Expected success: true"
        replay = data.get('replay', {})
        assert replay.get('id') == replay_id, "Replay ID mismatch"
        steps = replay.get('steps', [])
        assert len(steps) > 0, "Expected non-empty steps list"
        print(f"[OK] Replay '{replay.get('title')}' loaded successfully with {len(steps)} steps.")

def main():
    try:
        replays = test_replays_api()
        for r in replays:
            test_single_replay(r['id'])
        print("[3/3] All YouTube Commander Replay Engine endpoints passed 100%!")
    except Exception as e:
        print(f"FAILED Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
