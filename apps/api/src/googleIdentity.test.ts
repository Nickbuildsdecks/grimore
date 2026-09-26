import { describe, it, expect } from 'vitest';
import { createGoogleVerifier } from './lib/googleIdentity.js';

/**
 * The real verifier, against Google's live endpoints — no stub anywhere in this file.
 *
 * A success path cannot be tested: it needs a token Google has signed for a real client id, and
 * there is no way to obtain one here. What *can* be tested is every way a credential is refused,
 * and that is the half that matters — a verifier which wrongly accepts is an account takeover,
 * while one which wrongly rejects is a failed login.
 *
 * These reach `oauth2.googleapis.com` and `www.googleapis.com`, both reachable from CI. If that
 * ever changes the suite fails loudly rather than skipping, because a silently-skipped security
 * test is worse than no test.
 */
describe('createGoogleVerifier against live Google', () => {
  const verifier = createGoogleVerifier('test-client-id.apps.googleusercontent.com');

  it('rejects a malformed ID token', async () => {
    expect(await verifier.verifyIdToken('not-a-jwt')).toBeNull();
  });

  it('rejects a syntactically valid JWT that Google did not sign', async () => {
    // Correct three-part shape, self-signed, claims we would otherwise accept. The signature check
    // against Google's JWKS is the only thing standing between this and a sign-in.
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = [
      b64({ alg: 'RS256', kid: 'nope', typ: 'JWT' }),
      b64({
        iss: 'https://accounts.google.com',
        aud: 'test-client-id.apps.googleusercontent.com',
        sub: '1234567890',
        email: 'victim@example.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      'ZmFrZS1zaWduYXR1cmU',
    ].join('.');
    expect(await verifier.verifyIdToken(forged)).toBeNull();
  });

  it('rejects a malformed access token', async () => {
    expect(await verifier.verifyAccessToken('not-a-token')).toBeNull();
  });

  it('rejects empty input on both paths', async () => {
    expect(await verifier.verifyIdToken('')).toBeNull();
    expect(await verifier.verifyAccessToken('')).toBeNull();
  });

  it('refuses everything when no client id is configured', async () => {
    // Legacy read a missing client id as "skip the audience check", so a deploy that forgot to set
    // it accepted tokens minted for any Google application. Closed shut instead.
    const unconfigured = createGoogleVerifier(undefined);
    expect(await unconfigured.verifyIdToken('anything')).toBeNull();
    expect(await unconfigured.verifyAccessToken('anything')).toBeNull();
  });
});
