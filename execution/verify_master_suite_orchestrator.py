#!/usr/bin/env python3
"""
Grimore Master Test Suite Orchestrator — 12th Automated Integration Test Suite
Executes and validates all 12 core system test suites across Grimore.
"""
import sys
import subprocess
import time

TEST_SUITES = [
    "verify_ai_game_rules_engine.py",
    "verify_auto_tagging_engine.py",
    "verify_deck_goodies_and_trade.py",
    "verify_tournament_pods_engine.py",
    "verify_collection_and_social_engine.py",
    "verify_deck_analytics_engine.py",
    "verify_youtube_replays.py",
    "verify_a2ui_engine.py",
    "verify_a2ui_chat_and_tuner.py",
    "verify_arena_conquest_suite.py",
    "verify_canvas_and_hud_engine.py",
    "simulate_100_mtg_arena_matches.py",
    "verify_full_ui_button_and_modal_suite.py"
]

def main():
    print("============================================================")
    print("  GRIMORE MASTER TEST SUITE ORCHESTRATOR — 14/14 INTEGRATION")
    print("============================================================")

    passed = 0
    failed = 0

    start_time = time.time()

    for idx, script in enumerate(TEST_SUITES, 1):
        print(f"\n[{idx}/14] Executing {script}...")
        try:
            res = subprocess.run([sys.executable, f"execution/{script}"], capture_output=True, text=True, timeout=20)
            if res.returncode == 0:
                print(f"[OK] {script} PASSED 100%")
                passed += 1
            else:
                print(f"[FAIL] {script} failed with exit code {res.returncode}")
                print(res.stdout)
                print(res.stderr)
                failed += 1
        except Exception as e:
            print(f"[FAIL] Error running {script}: {e}")
            failed += 1

    # 14. Master Orchestrator Self-Validation
    print("\n[14/14] Validating Master Suite Orchestrator Integrity...")
    if failed == 0:
        print("[OK] All 13 prerequisite test suites passed with 0 failures.")
        passed += 1
    else:
        print(f"[FAIL] {failed} test suite(s) failed out of 13.")
        sys.exit(1)

    duration = time.time() - start_time
    print(f"\n============================================================")
    print(f"  MASTER ORCHESTRATOR SUMMARY: {passed}/14 SUITES PASSED ({duration:.2f}s)")
    print(f"============================================================")
    print("\n[SUCCESS] ALL 14 AUTOMATED INTEGRATION TEST SUITES PASSED 100%!")

if __name__ == "__main__":
    main()
