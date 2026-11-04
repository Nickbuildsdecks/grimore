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
# ## The second question, which this file could not answer before D410
#
# "Does the gate fail?" and "does the gate run anything?" are different questions, and for several
# days the answer to the second was no: the shell expanded CI's `./packages/*` filter before pnpm
# saw it, so all four `pnpm -r` steps selected nothing, said so, and **exited 0**. Every check above
# passed throughout, because a step that does nothing really does succeed.
#
# So the third case below asks the second question: a step whose output contains pnpm's
# selected-nothing line must fail the gate. `pnpm -r --filter ./nothing-here/* run build` is that
# step, phrased as the real failure was.
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

# D410: a step that selects no packages exits 0, so only reading its output catches it. Both of
# pnpm's ways of saying it are asked for: the real bug printed the second.
for nothing in \
  "pnpm -r --filter ./nothing-here/* run build" \
  "pnpm -r --filter ./packages/db run no-such-script"; do
  out=$(GATE_STEPS="$nothing" GATE_LOG="$(mktemp -t gate-check-XXXXXX.log)" bash "$here/gate.sh" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL  the gate exited 0 on a step that ran nothing: $nothing"
    bad=1
  elif ! printf '%s' "$out" | grep -q 'pnpm selected nothing'; then
    echo "FAIL  the gate failed but did not say the step ran nothing: $nothing"
    bad=1
  else
    echo "ok    the gate fails a step that ran nothing (rc=$rc): $nothing"
  fi
done

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
