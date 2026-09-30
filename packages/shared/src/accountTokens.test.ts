import { describe, it, expect } from 'vitest';
import {
  issueToken,
  hashToken,
  tokenHashEquals,
  checkToken,
  TOKEN_TTL_MS,
  TOKEN_REJECTION_MESSAGE,
} from './accountTokens.js';

describe('account tokens', () => {
  it('mints 256 bits of entropy, url-safe', () => {
    const { token } = issueToken('passwordReset');
    // base64url of 32 bytes is 43 characters with no padding, and nothing needing escaping in a URL.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 500 }, () => issueToken('passwordReset').token));
    expect(seen.size).toBe(500);
  });

  it('carries no prefix identifying what kind of secret it is', () => {
    // The legacy token was `tok_<hex>`, which tells anyone who finds one what they are holding.
    const { token } = issueToken('passwordReset');
    expect(token.startsWith('tok_')).toBe(false);
  });

  it('returns a hash that is not the token, and is what gets stored', () => {
    const { token, tokenHash } = issueToken('passwordReset');
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashToken(token));
    // The plaintext must not be recoverable from what is stored.
    expect(tokenHash).not.toContain(token);
  });

  it('hashes deterministically, so redemption is one indexed lookup', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('applies the per-kind lifetime', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(issueToken('passwordReset', now).expiresAt.getTime() - now.getTime()).toBe(TOKEN_TTL_MS.passwordReset);
    expect(issueToken('emailVerification', now).expiresAt.getTime() - now.getTime()).toBe(
      TOKEN_TTL_MS.emailVerification,
    );
    // A reset window measured in hours defeats the point of hashing it at rest.
    expect(TOKEN_TTL_MS.passwordReset).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  it('compares hashes without short-circuiting, and without throwing on a length mismatch', () => {
    const h = hashToken('x');
    expect(tokenHashEquals(h, h)).toBe(true);
    expect(tokenHashEquals(h, hashToken('y'))).toBe(false);
    // timingSafeEqual throws on unequal lengths; the wrapper must not propagate that to a route.
    expect(() => tokenHashEquals(h, 'short')).not.toThrow();
    expect(tokenHashEquals(h, 'short')).toBe(false);
    expect(tokenHashEquals(h, '')).toBe(false);
  });

  describe('redeemability', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const live = { expiresAt: new Date(now.getTime() + 60_000), consumedAt: null };

    it('accepts a live, unconsumed token', () => {
      expect(checkToken(live, now)).toBeNull();
    });

    it('refuses one that does not exist', () => {
      expect(checkToken(null, now)).toBe('unknown');
      expect(checkToken(undefined, now)).toBe('unknown');
    });

    it('refuses one already redeemed, even while unexpired', () => {
      expect(checkToken({ ...live, consumedAt: new Date(now.getTime() - 1000) }, now)).toBe('consumed');
    });

    it('refuses one past its expiry', () => {
      expect(checkToken({ expiresAt: new Date(now.getTime() - 1), consumedAt: null }, now)).toBe('expired');
    });

    it('refuses one expiring exactly now', () => {
      // The boundary has to fall one way. Refusing is the side that cannot be exploited.
      expect(checkToken({ expiresAt: new Date(now.getTime()), consumedAt: null }, now)).toBe('expired');
    });

    it('checks consumption before expiry, so a replayed old token reads as consumed', () => {
      // Ordering matters for the audit trail: "someone tried to reuse this" is the more useful fact.
      const both = { expiresAt: new Date(now.getTime() - 60_000), consumedAt: new Date(now.getTime() - 90_000) };
      expect(checkToken(both, now)).toBe('consumed');
    });
  });

  it('has one rejection message, so the reason never leaks', () => {
    // Telling a holder whether a candidate was ever real, or whether the account still exists, is the
    // enumeration oracle this constant exists to prevent.
    expect(TOKEN_REJECTION_MESSAGE).not.toMatch(/expired.*used|unknown|does not exist|no such/i);
    expect(TOKEN_REJECTION_MESSAGE).toMatch(/invalid or has expired/i);
  });
});
