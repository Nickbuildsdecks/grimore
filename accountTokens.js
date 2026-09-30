/**
 * Single-use account tokens, for the legacy server.
 *
 * This is deliberately a second implementation of `packages/shared/src/accountTokens.ts`, and that
 * needs justifying because duplicated security logic is how the divergence this whole migration keeps
 * uncovering got started.
 *
 * The reason is the module system. `server.js` is CommonJS in a plain npm project installed from
 * `package-lock.json`; `@grimore/shared` is ESM in the pnpm workspace and is not resolvable from here.
 * Bridging that with a bundler, a dual build, or `require()` of ESM would all be larger and more
 * fragile than forty lines of crypto.
 *
 * What makes it safe is not care, it is a test: `test/account-tokens-parity.test.js` runs both
 * implementations against the same inputs and fails if they disagree about a hash or about whether a
 * token is redeemable. Two implementations with a parity test is a known-good arrangement; two
 * implementations and good intentions is not.
 *
 * The rules themselves are documented in the TypeScript original. In short: 32 random bytes as
 * base64url, stored as an unsalted SHA-256 (the input is full-entropy, so there is nothing to
 * brute-force and nothing a rainbow table can precompute, and a deterministic hash is what allows an
 * indexed lookup), 30 minutes for a reset, single use, one rejection message for every reason.
 */
const { randomBytes, createHash, timingSafeEqual } = require('crypto');

const TOKEN_TTL_MS = {
  passwordReset: 30 * 60 * 1000,
  emailVerification: 24 * 60 * 60 * 1000,
};

function issueToken(kind, now = new Date()) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS[kind]),
  };
}

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function tokenHashEquals(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 'unknown' | 'expired' | 'consumed' | null. Consumption is checked before expiry, as in the original. */
function checkToken(stored, now = new Date()) {
  if (!stored) return 'unknown';
  if (stored.consumedAt) return 'consumed';
  if (new Date(stored.expiresAt).getTime() <= now.getTime()) return 'expired';
  return null;
}

const TOKEN_REJECTION_MESSAGE = 'That link is invalid or has expired. Please request a new one.';

module.exports = {
  TOKEN_TTL_MS,
  issueToken,
  hashToken,
  tokenHashEquals,
  checkToken,
  TOKEN_REJECTION_MESSAGE,
};
