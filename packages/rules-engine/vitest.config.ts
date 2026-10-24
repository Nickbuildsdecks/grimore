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
  },
});
