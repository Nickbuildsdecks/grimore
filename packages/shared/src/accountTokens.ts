/**
 * One discipline for every single-use account token: password reset and email verification today,
 * anything else of the same shape later.
 *
 * This lives in `@grimore/shared` rather than in either app because the legacy server and `apps/api`
 * both issue and redeem these against the same tables. Two implementations would drift, and the way
 * they would drift is one of them storing the token in a form the other cannot verify — which is the
 * class of bug the whole strangler migration keeps turning up.
 *
 * The rules, and why each one:
 *
 * **256 bits of CSPRNG output.** `randomBytes(32)`, base64url so it survives a URL without escaping.
 * No `tok_`-style prefix: it identifies the kind of secret to anyone who finds one, and buys nothing.
 *
 * **Stored as an unsalted SHA-256, never as issued.** The legacy table held the plaintext, so any read
 * of it was a live credential for every pending reset. SHA-256 and not bcrypt is a deliberate choice,
 * not a shortcut: bcrypt exists to make low-entropy human secrets expensive to guess, and a 256-bit
 * random value has nothing to guess. What bcrypt would cost is the indexed lookup — its salt is per-row,
 * so redeeming a token would mean scanning every live row and comparing each. Unsalted is safe here
 * precisely because the input is not guessable, which is the condition that makes a rainbow table
 * impossible.
 *
 * **Compared with a timing-safe equality.** A hash comparison on a value derived from attacker input
 * should not short-circuit, even though finding the 256-bit preimage by timing is not a practical
 * attack. It costs one function call.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** How long a freshly minted token of each kind stays valid. */
export const TOKEN_TTL_MS = {
  /** Short on purpose: long enough to find the mail, short enough that a leaked inbox ages out. */
  passwordReset: 30 * 60 * 1000,
  /** Longer, because the cost of expiry is a re-send rather than a locked-out account. */
  emailVerification: 24 * 60 * 60 * 1000,
} as const;

export type TokenKind = keyof typeof TOKEN_TTL_MS;

export interface IssuedToken {
  /** Goes in the email, and nowhere else — never a log, never a response body, never the database. */
  token: string;
  /** Goes in the database. */
  tokenHash: string;
  expiresAt: Date;
}

/** Mint a token of the given kind. The caller stores `tokenHash` and `expiresAt` and sends `token`. */
export function issueToken(kind: TokenKind, now: Date = new Date()): IssuedToken {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS[kind]),
  };
}

/** The stored form. Deterministic, so a redemption is one indexed lookup. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex hashes. Length mismatch is reported without comparing. */
export function tokenHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Why a token was refused. The caller must not tell the user which — see `TOKEN_REJECTION_MESSAGE`. */
export type TokenRejection = 'unknown' | 'expired' | 'consumed';

export interface StoredToken {
  expiresAt: Date;
  consumedAt: Date | null;
}

/**
 * Is this stored token redeemable right now?
 *
 * Split out from the database call so the decision itself is testable without one, and so both apps
 * cannot disagree about whether an expiry boundary is inclusive.
 */
export function checkToken(stored: StoredToken | null | undefined, now: Date = new Date()): TokenRejection | null {
  if (!stored) return 'unknown';
  if (stored.consumedAt) return 'consumed';
  // `<=` so a token expiring exactly now is refused. The boundary has to fall one way; refusing is the
  // side that cannot be exploited.
  if (stored.expiresAt.getTime() <= now.getTime()) return 'expired';
  return null;
}

/**
 * The single message every rejection returns.
 *
 * Distinguishing "no such token" from "expired" from "already used" tells an attacker holding a
 * candidate whether it was ever real, and tells anyone who finds an old email whether the account
 * still exists. One message for all three.
 */
export const TOKEN_REJECTION_MESSAGE = 'That link is invalid or has expired. Please request a new one.';
