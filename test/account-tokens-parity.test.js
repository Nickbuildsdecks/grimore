/**
 * The two token implementations must not drift.
 *
 * `accountTokens.js` (CommonJS, for `server.js`) and `packages/shared/src/accountTokens.ts` (ESM, for
 * `apps/api`) exist separately because the two apps are in different module systems and different
 * installs. They write and redeem tokens against the SAME tables, so a disagreement between them is not
 * a style problem: it is one app minting a token the other cannot verify, or accepting one the other
 * would have refused.
 *
 * Duplicated security logic plus good intentions is how the schema divergence in this repository
 * started. Duplicated logic plus a parity test is a different thing. This is that test.
 *
 * Skipped, not failed, when the TypeScript side has not been built -- the legacy job installs with npm
 * and does not run `tsc`. The v2 job builds packages before its tests, and the parity check runs there.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const cjs = require('../accountTokens.js');
const ESM_DIST = join(__dirname, '..', 'packages', 'shared', 'dist', 'accountTokens.js');
const built = existsSync(ESM_DIST);

test('the two token implementations agree', { skip: built ? false : 'packages/shared is not built' }, async () => {
  const esm = await import(ESM_DIST);

  // Hashing must be identical, or a token minted by one app cannot be found by the other.
  for (const sample of ['', 'a', 'token', 'a'.repeat(1000), 'üñïçø∂é', '\u0000\u0001', 'tok_deadbeef']) {
    assert.equal(cjs.hashToken(sample), esm.hashToken(sample), `hash differs for ${JSON.stringify(sample)}`);
  }

  // And each must be able to verify what the other issued.
  const fromCjs = cjs.issueToken('passwordReset');
  const fromEsm = esm.issueToken('passwordReset');
  assert.equal(esm.hashToken(fromCjs.token), fromCjs.tokenHash, 'ESM cannot verify a CJS-issued token');
  assert.equal(cjs.hashToken(fromEsm.token), fromEsm.tokenHash, 'CJS cannot verify an ESM-issued token');

  // Same shape: 32 bytes as base64url.
  assert.match(fromCjs.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(fromEsm.token, /^[A-Za-z0-9_-]{43}$/);

  // Same lifetimes, so one app cannot consider live what the other has expired.
  assert.deepEqual(cjs.TOKEN_TTL_MS, esm.TOKEN_TTL_MS);

  // Same redeemability decisions, boundaries included.
  const now = new Date('2026-06-01T12:00:00.000Z');
  const cases = [
    null,
    undefined,
    { expiresAt: new Date(now.getTime() + 1000), consumedAt: null },
    { expiresAt: new Date(now.getTime() - 1), consumedAt: null },
    // The exact boundary: both must refuse it, or one app accepts a token the other has retired.
    { expiresAt: new Date(now.getTime()), consumedAt: null },
    { expiresAt: new Date(now.getTime() + 1000), consumedAt: new Date(now.getTime() - 5000) },
    // Expired AND consumed: both must report 'consumed', because "someone tried to reuse this" is the
    // more useful fact for the audit trail.
    { expiresAt: new Date(now.getTime() - 1000), consumedAt: new Date(now.getTime() - 2000) },
  ];
  for (const c of cases) {
    assert.equal(
      cjs.checkToken(c, now),
      esm.checkToken(c, now),
      `redeemability differs for ${JSON.stringify(c)}`,
    );
  }

  // One rejection message, identical in both, so the reason never leaks from either app.
  assert.equal(cjs.TOKEN_REJECTION_MESSAGE, esm.TOKEN_REJECTION_MESSAGE);

  // Comparison must agree, and neither may throw on a length mismatch.
  const h = cjs.hashToken('x');
  for (const [a, b] of [[h, h], [h, cjs.hashToken('y')], [h, 'short'], [h, ''], ['', '']]) {
    assert.equal(cjs.tokenHashEquals(a, b), esm.tokenHashEquals(a, b), `comparison differs for ${a}/${b}`);
  }
});

test('the two password policies agree', { skip: built ? false : 'packages/shared is not built' }, async () => {
  const esmPolicy = await import(join(__dirname, '..', 'packages', 'shared', 'dist', 'passwordPolicy.js'));
  const cjsPolicy = require('../passwordPolicy.js');

  assert.equal(cjsPolicy.PASSWORD_MIN_LENGTH, esmPolicy.PASSWORD_MIN_LENGTH);
  assert.equal(cjsPolicy.PASSWORD_MAX_LENGTH, esmPolicy.PASSWORD_MAX_LENGTH);

  // One app accepting a password the other refuses means a person can set a secret on one side that the
  // other side would have rejected -- and the messages must match too, since a differing message is how
  // someone works out which app answered.
  const samples = [
    undefined, null, '', 'short', '        ', 'password', 'PASSWORD', '12345678', 'qwertyui',
    'abcdefgh', 'hgfedcba', 'aaaaaaaaaaaa', 'grimore', 'guestpass123', 'correct horse battery staple',
    'quiet-library-morning', 'x'.repeat(129), 'x'.repeat(128), 'paß𝐀word',
  ];
  for (const sample of samples) {
    assert.equal(
      cjsPolicy.passwordPolicyError(sample),
      esmPolicy.passwordPolicyError(sample),
      `verdict differs for ${JSON.stringify(sample)}`,
    );
  }

  // And with context, which is where the identity rules live.
  const contexts = [
    { username: 'nickbuildsdecks' },
    { email: 'gothard@example.com' },
    { username: 'ab' },
    { username: 'nickbuildsdecks', email: 'gothard@example.com' },
  ];
  for (const ctx of contexts) {
    for (const sample of ['nickbuildsdecks99', 'gothard-secret', 'quiet-library-morning', 'ab-passphrase-here']) {
      assert.equal(
        cjsPolicy.passwordPolicyError(sample, ctx),
        esmPolicy.passwordPolicyError(sample, ctx),
        `verdict differs for ${sample} with ${JSON.stringify(ctx)}`,
      );
    }
  }
});
