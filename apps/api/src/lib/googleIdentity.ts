/**
 * Google sign-in: turning a client-supplied credential into a verified identity.
 *
 * Split from the route deliberately. The route's job is account resolution — match, link, create —
 * and that is all database work testable against live Postgres. Verification is a call out to
 * Google, and no test can mint a token Google will sign for a real client id, so it lives behind
 * this interface and tests supply their own. The live endpoints are still exercised: the real
 * verifier's rejection paths are tested against Google itself, because a wrong answer there is the
 * difference between a sign-in and an account takeover.
 *
 * Two proofs are accepted, matching legacy:
 *
 *  1. An ID token (`credential`) from GIS One Tap / renderButton. Verified locally against Google's
 *     JWKS by `google-auth-library`, with the audience pinned to our client id.
 *  2. An OAuth access token from the GIS popup token client. There is no signature to check, so it
 *     is introspected at `tokeninfo` and the audience is checked there — without that check, an
 *     access token minted for *any other* Google app could be replayed here to impersonate its
 *     owner.
 *
 * ## What is tightened relative to legacy
 *
 * Legacy rejected an identity only when `email_verified` was explicitly `false`:
 *
 *     if (payload.email_verified === false || payload.email_verified === 'false') { ...reject }
 *
 * so an **absent** `email_verified` passed. That matters more than it looks: the route falls back
 * to matching an existing player by email address, meaning an unverified Google address that
 * happens to equal a registered user's email would hand over that account. `tokeninfo` does not
 * always return the field, and the access-token path built its payload from two sources that could
 * both omit it. Here verification is affirmative — the field must be present and true.
 */
import { OAuth2Client } from 'google-auth-library';

export interface GoogleIdentity {
  /** Google's stable subject id for the account (`sub`). */
  googleId: string;
  email: string;
  /** Always true on a returned identity; a false or absent claim fails verification. */
  emailVerified: true;
  name?: string;
  picture?: string;
}

export interface GoogleVerifier {
  /** An ID token from One Tap / renderButton, or null if it does not verify. */
  verifyIdToken(credential: string): Promise<GoogleIdentity | null>;
  /** An OAuth access token from the popup token client, or null if it does not verify. */
  verifyAccessToken(accessToken: string): Promise<GoogleIdentity | null>;
}

const TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Google returns `email_verified` as a boolean on ID tokens and the string "true" on tokeninfo. */
const isVerified = (value: unknown): boolean => value === true || value === 'true';

/** `exp` is seconds since the epoch, as a number on ID tokens and a string on tokeninfo. */
function isExpired(exp: unknown): boolean {
  if (exp === undefined || exp === null || exp === '') return false;
  const seconds = typeof exp === 'number' ? exp : Number.parseInt(String(exp), 10);
  if (!Number.isFinite(seconds)) return true;
  return seconds * 1000 <= Date.now();
}

function identityFrom(
  claims: { sub?: unknown; email?: unknown; email_verified?: unknown; name?: unknown; picture?: unknown },
): GoogleIdentity | null {
  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  const googleId = typeof claims.sub === 'string' ? claims.sub : '';
  if (!email || !googleId) return null;
  // Affirmative check — see the header comment. An absent claim is not a verified address.
  if (!isVerified(claims.email_verified)) return null;
  return {
    googleId,
    email,
    emailVerified: true,
    name: typeof claims.name === 'string' ? claims.name : undefined,
    picture: typeof claims.picture === 'string' ? claims.picture : undefined,
  };
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The real verifier. With no `clientId` every call returns null: a token's audience is the only
 * thing tying it to this application, and an unpinned audience accepts tokens minted for anyone.
 * Legacy treated a missing client id as "skip the audience check" (`!googleClientId || ...`), which
 * turns a misconfigured deploy into an open door.
 */
export function createGoogleVerifier(clientId: string | undefined): GoogleVerifier {
  const client = clientId ? new OAuth2Client(clientId) : null;

  return {
    async verifyIdToken(credential) {
      if (!client || !clientId || !credential) return null;
      try {
        // Verifies the signature against Google's JWKS and pins `aud` to our client id. Throws on
        // a bad signature, a wrong audience, a wrong issuer or an expired token.
        const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
        const payload = ticket.getPayload();
        return payload ? identityFrom(payload) : null;
      } catch {
        return null;
      }
    },

    async verifyAccessToken(accessToken) {
      if (!clientId || !accessToken) return null;
      const info = await getJson(`${TOKENINFO}?access_token=${encodeURIComponent(accessToken)}`);
      if (!info) return null;
      // `aud` is the resource the token is for, `azp` the client that requested it; GIS populates
      // one or the other depending on flow. Either must be us.
      if (info.aud !== clientId && info.azp !== clientId) return null;
      if (isExpired(info.exp)) return null;

      // tokeninfo often omits the profile fields, so read them with the same token. Both sources
      // must agree there is a verified address.
      const profile = (await getJson(USERINFO, { Authorization: `Bearer ${accessToken}` })) ?? {};
      return identityFrom({
        sub: info.sub ?? profile.sub,
        email: info.email ?? profile.email,
        email_verified: isVerified(info.email_verified) ? info.email_verified : profile.email_verified,
        name: profile.name,
        picture: profile.picture,
      });
    },
  };
}
