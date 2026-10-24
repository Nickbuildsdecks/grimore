import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /*
      Sixty seconds instead of the five-second default, for the whole package.

      `playout.test.ts` plays whole games — a dozen of them per test, several hundred actions each
      — and the slowest of those tests sits between four and nine seconds on an idle machine. Four
      of them had been given an explicit 60s timeout as they were written; the rest were under five
      seconds when they were written and crept up as cards were added to the decks.

      That produced a flake worth recording, because it looked exactly like a nondeterministic
      engine: "casts modal spells, and does not always take the same mode" failed, passed and
      failed again on three consecutive runs of identical code. The engine turned out to be
      perfectly deterministic — the same twelve games, the same seventeen modal casts, the same six
      mode combinations, byte-identical across processes — and the test was simply 4.5s of work
      against a 5s limit, so it failed whenever the machine was busy with another package's suite.
      A per-test timeout fixes one test; a package-wide one fixes the class.
    */
    testTimeout: 60_000,
    hookTimeout: 60_000,
    /*
      Two workers, not one per core.

      This suite is dominated by one file — `playout.test.ts` plays whole games and takes most of
      the minute — so capping the pool costs nothing: measured on four cores, 56.8s with the
      default and 53.5s with two workers, which is to say the difference is noise and the extra
      threads were never doing much. (`user` time is 1m03 against 55s of wall time: barely
      parallel, because one file cannot be split.) What it buys is a run that does not starve its
      own main thread.

      What prompted it — and did not fix it, which is the part worth writing down. A
      `turbo run test --force` across all ten packages on this four-core box fails about one run in
      two with `[vitest-worker]: Timeout calling "onTaskUpdate"`: every test passes and the process
      exits 1 anyway, because a worker cannot reach the reporter inside its RPC timeout while the
      machine is saturated. Four mitigations were measured and none of them fixed it: this cap, the
      `dot` reporter (a tenth of the reporter traffic), `turbo --concurrency=3`, and `singleFork`
      (one process for the whole package, which costs nothing — 54.6s against 53.5s — and still
      flaked). Under `--force` the api and realtime suites began failing the same way, which rules
      out anything specific to this package.

      The likeliest remaining cause is this suite's own shape rather than the box: a `playout` test
      is ten seconds of *synchronous* game-playing in one test body, and a worker that never yields
      cannot answer the reporter inside its timeout. What would follow from that is a yield between
      games — `await` something that defers, once per seed — which is a real change to thirty tests
      for a runner's benefit and has not been made. It is written here so the next person starts
      from the measurement rather than from the four things that did not work.

      **That is what it turned out to be, and it is fixed.** The suite reached a point where it
      failed on *every* run rather than one in two — enough tests had been added that the longest
      body was eleven seconds — which finally made the hypothesis testable. One `await` that defers
      to the event loop, once per game, inside the single heaviest test cleared it: three green runs
      where three had just failed. The yield is now in the five tests long enough to matter
      (`breathe` in `playout.test.ts`), and `turbo run test --force` — the command that used to fail
      half the time — has run green four times in a row since.

      So the cause was this suite's shape, not the box: a worker that never yields cannot answer
      the reporter inside its RPC timeout, and the fix costs a few microseconds a game. The four
      mitigations above are left written down because they are the four things not to try again.

      The cap stays because it is marginally *faster* and leaves the main thread a core, not
      because it was shown to fix anything.
    */
    maxWorkers: 2,
  },
});
