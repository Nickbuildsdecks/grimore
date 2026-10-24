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

      What prompted it: a `turbo run test --force` across all ten packages on this four-core box
      failed with `[vitest-worker]: Timeout calling "onTaskUpdate"` — all 487 tests passed and the
      process still exited 1, because a worker could not reach the reporter inside its RPC timeout
      while the machine was saturated. It repeated about one run in two with every package's suite
      rebuilt at once.

      It is a local-load artefact and is not stated here as a CI risk: CI has run this workflow 175
      times on this branch and every one of the last ten is green, this flake among the things that
      never happened there. The cap is kept because it costs nothing, not because it was shown to
      fix anything.
    */
    maxWorkers: 2,
  },
});
