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
# ## It mirrors CI's `v2` job, step for step
#
# **D368.** This used to run `pnpm v2:typecheck` / `v2:typecheck:tests` / `v2:test`, which are turbo
# tasks. CI runs `pnpm -r`, and the difference is not cosmetic:
#
#   * **turbo caches by input hash.** A package whose inputs it considers unchanged replays a stored
#     green without running anything — so the gate could report a package passing while CI ran it
#     for real. That is D356's hole again, one level in: not a cached run with the services down,
#     but a cached run of a suite that would now fail.
#   * **CI ran three steps this did not**: the packages' `build`, the legacy token-parity test, and
#     the web production build. A gate missing a step CI has is a gate that cannot see a failure CI
#     will.
#
# A gate whose job is "would CI accept this" has to run what CI runs. So the steps below are that
# job verbatim, with `services-up.js` in front. It is slower than turbo, and that is the trade: a
# gate that is fast and sometimes wrong is worth less than one that is slow and right.
#
# **D410 — the shell expanded CI's filter glob, and pnpm exited 0 anyway.** The fourth trap, and the
# worst of them, because it made this gate's whole middle silent for several days. CI writes the
# filter quoted:
#
#     pnpm -r --filter './packages/*' --filter './apps/*' run typecheck:tests
#
# and the steps here are strings run as `$step`, unquoted, so the shell did both halves of its job:
# word splitting (wanted) and **pathname expansion** (not). `./packages/*` became the six real
# directories, so the command pnpm actually received was
#
#     pnpm -r --filter ./packages/db ./packages/rules-engine … run typecheck:tests
#
# where only the first path is a filter and the rest are positional — making `./packages/db` the
# script name. pnpm answered `None of the selected packages has a "./packages/db" script` and
# **exited 0**, so all four `pnpm -r` steps — build, typecheck, typecheck:tests and test — passed by
# doing nothing. Quoting inside the string cannot fix it: inside `$step` the quotes are characters,
# not quoting. `set -f` can, by switching pathname expansion off for the loop and leaving word
# splitting on, which hands pnpm the glob to match itself, exactly as CI does.
#
# It is the same shape as D365 one level out: not a step that cannot fail, but a step that never
# ran. `check-gate.sh` proved the exit code was real and could not have caught this — a step that
# does nothing really does succeed. So the fix carries its own check: the loop below fails the gate
# on any step whose output says pnpm selected nothing, because "nothing to do" is the one answer a
# mirror of CI must never accept quietly.
set -o pipefail
# See D410 above: the step strings carry CI's filter globs, and only pnpm may expand them.
set -f
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
#
# **One step per line**, not one per word. It was split on whitespace until D410, which was fine
# while every injected step was a single word (`false`, `true`) and useless the moment one needed
# arguments: `pnpm -r --filter … run build` became six one-word steps, the first of which was
# `pnpm` on its own. The check that proves a step can run nothing needs a real pnpm invocation, so
# the separator is now the newline.
if [ -n "${GATE_STEPS:-}" ]; then
  old_ifs=$IFS
  IFS=$'\n'
  # shellcheck disable=SC2206
  set -- $GATE_STEPS
  IFS=$old_ifs
else
  # Deliberately CI's `v2` job, step for step, with `services-up.js` in front of it. See the
  # "mirrors CI" note in this file's header for why it is spelled out rather than using the
  # `v2:*` scripts.
  set -- \
    "node scripts/services-up.js" \
    "node scripts/guards.js" \
    "pnpm -r --filter ./packages/* run build" \
    "pnpm -r --filter ./packages/* --filter ./apps/* run typecheck" \
    "pnpm -r --filter ./packages/* --filter ./apps/* run typecheck:tests" \
    "pnpm -r --filter ./packages/* --filter ./apps/* run test" \
    "node --test test/account-tokens-parity.test.js" \
    "pnpm --filter @grimore/web build"
fi

for step in "$@"; do
  echo "=== $step ===" >> "$log"
  before=$(( $(wc -l < "$log") + 1 ))
  # Run, then capture. Not `if ! $step`, for the reason in this file's header.
  $step >> "$log" 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "GATE FAILED at: $step (rc=$rc)"
    tail -40 "$log"
    exit "$rc"
  fi
  # D410: a step that ran nothing, which pnpm reports and then exits 0 on. Read only the lines this
  # step appended, so an earlier step's output cannot answer for this one.
  #
  # Two messages, because pnpm has two ways of selecting nothing and both exit 0: no package matched
  # the filter ("No projects matched the filters"), or packages matched and none has the script
  # ("None of the selected packages has a … script"). The real bug was the second, and it only read
  # that way because the mangled command line turned a package path into the script name — so a
  # gate that watched for one phrasing would have missed the other spelling of the same hole.
  if sed -n "${before},\$p" "$log" \
    | grep -qE 'None of the selected packages|No projects matched the filters'; then
    echo "GATE FAILED at: $step (pnpm selected nothing — see D410)"
    sed -n "${before},\$p" "$log"
    exit 1
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
