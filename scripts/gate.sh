#!/bin/bash
#
# The pre-push gate: the five checks that have to pass before anything is pushed.
#
# In the repository rather than a scratch directory, and that move is the point. This script lived
# in a session-local temp folder for weeks, which meant the one thing standing between a red tree
# and `git push` was a file nobody could review, nothing could test, and the next session would not
# have. It is checked in now so it can be read, fixed and relied on — `pnpm v2:gate`.
#
# ## Three traps this script exists to avoid, each of which got through once
#
# **D323 — a pager's exit code.** `pnpm v2:test 2>&1 | tail -12` exits with `tail`'s status, which
# is 0 whatever the tests did, so a red run reached `git push`. Hence `set -o pipefail`, and no pipe
# between a step and its status.
#
# **D356 — a cached green.** `pnpm v2:test` replays a full page of passing tests from turbo's cache
# with Redis and Postgres stopped, because a running service is not one of turbo's cache inputs. So
# `services-up.js` goes first: it asks the one thing the cache cannot know.
#
# **D365 — `$?` in the then-branch of `if !`.** The version of this script that caught the other two
# read:
#
#     if ! $step >> "$log" 2>&1; then
#       rc=$?                       # <-- 0, always
#       echo "GATE FAILED at: $step (rc=$rc)"
#       exit "$rc"                  # <-- exits 0
#     fi
#
# `!` inverts the status, the `if` succeeds, and `$?` inside the branch is the status of the
# *successful test*, not the failed command. So the gate printed GATE FAILED in full and **exited
# zero** — which is the whole subject of `claude/decisions-log.md` wearing a shell script: a check
# that cannot fail reads as good news. Run the step, capture `$?` on the very next line, then test
# it. `check-gate.sh` beside this file proves that it now fails.
#
set -o pipefail
cd "$(dirname "$0")/.." || exit 1

# Overridable so CI, or a second local Postgres, can point this somewhere else.
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/grimore_dev}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export SESSION_SECRET="${SESSION_SECRET:-ci-only-secret}"
export NODE_ENV="${NODE_ENV:-test}"

log="${GATE_LOG:-$(mktemp -t grimore-gate-XXXXXX.log)}"
: > "$log"
echo "gate log: $log"

# `GATE_STEPS` lets `check-gate.sh` run this script against a step that is certain to fail, which is
# the only way to know the exit code is real. Unset in every normal run.
if [ -n "${GATE_STEPS:-}" ]; then
  # shellcheck disable=SC2086
  set -- $GATE_STEPS
else
  set -- \
    "node scripts/services-up.js" \
    "node scripts/guards.js" \
    "pnpm v2:typecheck" \
    "pnpm v2:typecheck:tests" \
    "pnpm v2:test"
fi

for step in "$@"; do
  echo "=== $step ===" >> "$log"
  # Run, then capture. Not `if ! $step`, for the reason in this file's header.
  $step >> "$log" 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "GATE FAILED at: $step (rc=$rc)"
    tail -40 "$log"
    exit "$rc"
  fi
done

echo "GATE OK"
# `|| true`, and an explicit `exit 0`, because this summary is diagnostics and its status is not the
# gate's. `check-gate.sh` caught this on the first run: with `pipefail` set, a log holding no
# matching line made `grep` exit 1 and the whole gate exit 1 **after passing every step** — the same
# family as the bug in this file's header, pointing the other way. A gate that cries wolf is a gate
# somebody stops running, which ends up in the same place as one that cannot fail.
grep -E "Tests  |Test Files|Tasks:" "$log" | tail -20 || true
exit 0
