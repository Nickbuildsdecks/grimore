/**
 * This package says what it did **not** run.
 *
 * This package's migration suites open with
 * `describe.skipIf(!DATABASE_URL)`. Without that variable vitest reports
 * `Tests 1 passed | 5 skipped (6)` and **exits 0** — measured, not supposed. So a gate run
 * that omits it reports success over 1 of 6 tests, and reports it in
 * the same words as a run that covered all of it.
 *
 * That is not hypothetical. A local gate in this project reported green over 8 of 43 realtime
 * tests for an entire session for exactly this reason, and only CI — which does set the
 * variables — was doing the real work (D323). The code was never at fault; the invocation was,
 * and nothing made the invocation's gap visible.
 *
 * So the absence is loud. `ALLOW_SKIP_SERVICE_TESTS=1` is the way out for somebody deliberately
 * running the pure tests without standing up Postgres and Redis — it has to be *asked for*, which
 * is the whole point: a skip you chose is a decision, and a skip you did not notice is a false
 * pass. Same argument as D302, where a browser suite's total became meaningless without its skips
 * printed beside it.
 */
import { describe, it, expect } from 'vitest';

describe('the services this package tests against', () => {
  it('are reachable, or the skip was asked for', () => {
    const optedOut = process.env.ALLOW_SKIP_SERVICE_TESTS === '1';
    const missing = ['DATABASE_URL'].filter((v) => !process.env[v]);
    expect(
      missing.length === 0 || optedOut,
      `${missing.join(' and ')} unset, so most of this package's tests did not run and the suite`
      + ' still exited 0. Set them, or ALLOW_SKIP_SERVICE_TESTS=1 if you meant to run without'
      + ' services.',
    ).toBe(true);
  });
});
