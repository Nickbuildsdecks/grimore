#!/bin/bash
#
# Does the gate actually fail? The check for D365.
#
# `scripts/gate.sh` spent weeks printing "GATE FAILED at: …" and exiting 0, because `$?` read inside
# the then-branch of `if ! cmd` is the status of the test rather than of the command. Nothing noticed
# because the text was right and nobody had ever asked the script for its exit code.
#
# So this asks. It runs the gate with `GATE_STEPS` set to a step that cannot pass, and fails if the
# gate reports success — in its words or in its status. Run it after any change to the gate:
#
#   bash scripts/check-gate.sh
#
set -o pipefail
here="$(dirname "$0")"
bad=0

out=$(GATE_STEPS="false" GATE_LOG="$(mktemp -t gate-check-XXXXXX.log)" bash "$here/gate.sh" 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then
  echo "FAIL  the gate exited 0 on a step that cannot pass"
  bad=1
else
  echo "ok    the gate exits non-zero on a failing step (rc=$rc)"
fi
if ! printf '%s' "$out" | grep -q 'GATE FAILED at: false'; then
  echo "FAIL  the gate did not say which step failed"
  bad=1
else
  echo "ok    and it names the step that failed"
fi
if printf '%s' "$out" | grep -q 'GATE OK'; then
  echo "FAIL  the gate printed GATE OK on a failing step"
  bad=1
fi

out=$(GATE_STEPS="true" GATE_LOG="$(mktemp -t gate-check-XXXXXX.log)" bash "$here/gate.sh" 2>&1)
rc=$?
if [ "$rc" -ne 0 ] || ! printf '%s' "$out" | grep -q 'GATE OK'; then
  echo "FAIL  the gate does not pass a step that cannot fail (rc=$rc)"
  bad=1
else
  echo "ok    and it passes when every step passes"
fi

[ "$bad" -eq 0 ] && echo "gate verified" || echo "gate NOT verified"
exit "$bad"
