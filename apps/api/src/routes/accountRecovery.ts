/**
 * Password recovery and email verification.
 *
 * Legacy had these routes and they have never worked: `password_resets` is created by neither dialect
 * of `db.js` and by no migration, so `forgot-password` raised into its own catch and nobody could
 * recover an account. Migration 0014 creates the tables; this is the flow on top of them.
 *
 * The properties that matter, each one a legacy finding (claude/account-system-design.md):
 *
 *  - The response never reveals whether an account exists, and the two paths do comparable work, so
 *    the timing does not reveal it either.
 *  - The token is stored as a SHA-256, never as issued, so reading the table yields nothing redeemable.
 *  - The row keys on `player_id`, never the username, which this app lets people change.
 *  - Redeeming consumes the token AND every other outstanding one for the account, then ends every
 *    session, because the reason someone resets a password is that another person is in their account.
 *  - Mail failure fails the request. "We sent you a link" must not be returned when nothing was sent.
 */
import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import {
  ForgotPasswordInput,
  ResetPasswordInput,
  VerifyEmailInput,
  FORGOT_PASSWORD_MESSAGE,
  issueToken,
  hashToken,
  checkToken,
  TOKEN_REJECTION_MESSAGE,
  passwordPolicyError,
} from '@grimore/shared';
import { withTransaction, type PoolClient } from '@grimore/db';
import type { AppContext } from '../app.js';
import { ApiError, wrap } from '../lib/errors.js';
import { requireAuth, sessionPlayerId } from '../lib/auth.js';
import { invalidateSessions, stampSessionEpoch } from '../lib/sessionEpoch.js';
import { auditAccountEvent, recentEventCount } from '../lib/accountEvents.js';
import type { Transport } from '@grimore/mailer';

/** Per-account ceiling, on top of the per-IP limiter. See F8. */
const RESET_REQUESTS_PER_ACCOUNT = 5;
const RESET_WINDOW_MS = 60 * 60 * 1000;

/**
 * A bcrypt hash of a throwaway value, compared against when no account matched.
 *
 * The unknown-account path must cost what the known one costs. Returning early is a timing oracle:
 * "instant" means no such account, "60ms" means there is one and we just hashed something for it.
 */
const DUMMY_HASH = bcrypt.hashSync('grimore-recovery-dummy', 10);

export function accountRecoveryRouter(ctx: AppContext, mailer: Transport): Router {
  const { pool, env, log } = ctx;
  const r = Router();

  // Tighter than the general auth limiter: each request here can send an email, so the abuse is not
  // just guessing, it is using this server to mail somebody.
  const recoveryLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
  });

  /**
   * The origin links are built against.
   *
   * From configuration, never from the request's Host header. A poisoned Host — trivially supplied by
   * anyone who can reach the server — turns a recovery mail into a link that delivers the token to the
   * attacker, and the victim's own click is what hands it over.
   */
  /**
   * Refuse the whole route when it cannot possibly work, before touching any account.
   *
   * Order matters. Discovering a missing transport at the send means the account has already been
   * resolved, so a known account errors while an unknown one returns the cheerful 200 — an enumeration
   * oracle that stays open for as long as mail is misconfigured. Checked here, every caller gets the same
   * answer. Found by running the built image with no SMTP_URL, which is the state a first cutover is in.
   */
  function requireDeliverable(): void {
    if (!mailer.configured) {
      throw new ApiError(
        503,
        'UNAVAILABLE',
        'Password recovery is not configured on this server. No email can be sent.',
      );
    }
  }

  function baseUrl(): string {
    if (!env.APP_BASE_URL) {
      throw new ApiError(
        503,
        'UNAVAILABLE',
        'APP_BASE_URL is not configured, so a recovery link cannot be built. Refusing to guess it from the request.',
      );
    }
    return env.APP_BASE_URL.replace(/\/+$/, '');
  }

  /** Outside production only, and only when explicitly asked for. See F5. */
  function devLinkFor(link: string): string | undefined {
    // Legacy attached this whenever NODE_ENV was not exactly "production", so an unset NODE_ENV turned
    // forgot-password into an unauthenticated account-takeover API. Inverted: the dev convenience needs
    // its own explicit flag AND a non-production environment, so no single missing variable exposes it.
    if (env.NODE_ENV === 'production') return undefined;
    if (process.env.EXPOSE_DEV_RESET_LINK !== '1') return undefined;
    return link;
  }

  r.post(
    '/forgot-password',
    recoveryLimiter,
    wrap(async (req, res) => {
      requireDeliverable();
      const input = ForgotPasswordInput.parse(req.body);
      const identifier = input.usernameOrEmail;

      // Counted per identifier as supplied, before resolving it, so the throttle cannot itself be used
      // to tell an existing account from a missing one.
      const recent = await recentEventCount(pool, 'password.reset.requested', identifier, RESET_WINDOW_MS);
      if (recent >= RESET_REQUESTS_PER_ACCOUNT) {
        // Same message and status as success. A distinct "too many requests" here would confirm the
        // account exists to anyone who asked six times.
        auditAccountEvent(pool, log, req, 'password.reset.rejected', { identifier });
        res.json({ success: true, message: FORGOT_PASSWORD_MESSAGE });
        return;
      }

      const q = await pool.query<{ id: string; email: string | null; username: string }>(
        `SELECT id, email, username FROM players
          WHERE lower(username) = lower($1) OR lower(email) = lower($1)
          LIMIT 1`,
        [identifier],
      );
      const player = q.rows[0];

      auditAccountEvent(pool, log, req, 'password.reset.requested', {
        playerId: player?.id ?? null,
        identifier,
      });

      if (!player?.email) {
        // No account, or an account with no address to send to. Do the same work the real path does so
        // the response time carries no signal, then return the same message.
        await bcrypt.compare('grimore-recovery-dummy', DUMMY_HASH);
        res.json({ success: true, message: FORGOT_PASSWORD_MESSAGE });
        return;
      }

      const issued = issueToken('passwordReset');
      await pool.query(
        `INSERT INTO password_resets (player_id, token_hash, requested_ip, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [player.id, issued.tokenHash, req.ip ?? null, issued.expiresAt],
      );

      // `/?resetToken=` is the only shape either front end handles: `public/app.js` reads that parameter
      // at `/`, and the React app's BrowserRouter has `basename="/react"`, so a bare `/reset-password`
      // serves the React shell and matches nothing in it. Checked against a running server.
      const link = `${baseUrl()}/?resetToken=${encodeURIComponent(issued.token)}`;
      // Awaited, and not caught: if the mail cannot go, the caller must be told the request failed
      // rather than be left waiting for something that is not coming. The fail-closed transport is what
      // makes an unconfigured deployment surface that instead of pretending.
      await mailer.send({
        to: player.email,
        subject: 'Reset your Grimore password',
        text:
          `Someone asked to reset the password for your Grimore account (${player.username}).\n\n` +
          `Open this link within 30 minutes to choose a new one:\n\n${link}\n\n` +
          `If that was not you, you can ignore this email — nothing has changed, and the link ` +
          `expires on its own.\n`,
      });

      res.json({ success: true, message: FORGOT_PASSWORD_MESSAGE, devResetLink: devLinkFor(link) });
    }),
  );

  r.post(
    '/reset-password',
    recoveryLimiter,
    wrap(async (req, res) => {
      const input = ResetPasswordInput.parse(req.body);
      const tokenHash = hashToken(input.token);

      const result = await withTransaction(pool, async (client: PoolClient) => {
        // Locked for the duration: without FOR UPDATE, two requests carrying the same token can both
        // read it unconsumed and both set a password, which is the difference between single-use and
        // nearly-single-use.
        const q = await client.query<{
          id: string;
          player_id: string;
          expires_at: Date;
          consumed_at: Date | null;
          username: string;
          email: string | null;
        }>(
          `SELECT pr.id, pr.player_id, pr.expires_at, pr.consumed_at, p.username, p.email
             FROM password_resets pr
             JOIN players p ON p.id = pr.player_id
            WHERE pr.token_hash = $1
            FOR UPDATE OF pr`,
          [tokenHash],
        );
        const row = q.rows[0];
        const rejection = checkToken(
          row ? { expiresAt: row.expires_at, consumedAt: row.consumed_at } : null,
        );
        if (rejection) return { ok: false as const, reason: 'token' as const };

        // Now that the account is known, the identity-aware half of the policy can run — a new password
        // must not contain the username or email. It cannot run in the contract, because resolving an
        // account from the token before verifying the token would be the oracle this flow avoids.
        const policyError = passwordPolicyError(input.newPassword, {
          username: row!.username,
          email: row!.email ?? undefined,
        });
        if (policyError) return { ok: false as const, reason: 'policy' as const, message: policyError };

        const hash = await bcrypt.hash(input.newPassword, 10);
        await client.query('UPDATE players SET password_hash = $1 WHERE id = $2', [hash, row!.player_id]);
        await client.query('UPDATE password_resets SET consumed_at = now() WHERE id = $1', [row!.id]);
        // Every other outstanding token for this account dies too, so an older recovery mail still
        // sitting in an inbox — or in an attacker's hands — is worthless.
        await client.query(
          `UPDATE password_resets SET consumed_at = now()
            WHERE player_id = $1 AND consumed_at IS NULL AND id <> $2`,
          [row!.player_id, row!.id],
        );
        return { ok: true as const, playerId: row!.player_id };
      });

      if (!result.ok && result.reason === 'token') {
        auditAccountEvent(pool, log, req, 'password.reset.rejected');
        throw new ApiError(400, 'VALIDATION', TOKEN_REJECTION_MESSAGE);
      }
      if (!result.ok) {
        throw new ApiError(400, 'VALIDATION', result.message);
      }

      // Outside the transaction: the reset is committed, and this must happen even if it were to fail.
      await invalidateSessions(pool, result.playerId);
      auditAccountEvent(pool, log, req, 'password.reset.redeemed', { playerId: result.playerId });
      // Not signed in as a side effect of resetting. Whoever holds the link is not yet known to be the
      // account holder — they proved control of the inbox, which is enough to set a password and then
      // be asked for it.
      res.json({ success: true });
    }),
  );

  r.post(
    '/sign-out-everywhere',
    requireAuth,
    wrap(async (req, res) => {
      const playerId = sessionPlayerId(req);
      const validFrom = await invalidateSessions(pool, playerId);
      auditAccountEvent(pool, log, req, 'sessions.revoked', { playerId });
      // Including this one, deliberately: "everywhere" that excluded the device asking would be a lie,
      // and someone who suspects a compromise may be on the compromised device.
      await new Promise<void>((resolve) => req.session.regenerate(() => resolve()));
      void validFrom;
      res.json({ success: true });
    }),
  );

  r.post(
    '/verify-email/request',
    requireAuth,
    recoveryLimiter,
    wrap(async (req, res) => {
      requireDeliverable();
      const playerId = sessionPlayerId(req);
      const q = await pool.query<{ email: string | null; email_verified_at: Date | null; username: string }>(
        'SELECT email, email_verified_at, username FROM players WHERE id = $1',
        [playerId],
      );
      const player = q.rows[0];
      if (!player?.email) throw new ApiError(400, 'VALIDATION', 'Your account has no email address to verify.');
      if (player.email_verified_at) {
        res.json({ success: true, alreadyVerified: true });
        return;
      }

      const issued = issueToken('emailVerification');
      await pool.query(
        `INSERT INTO email_verifications (player_id, email, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
        // The address is captured now, so a later email change cannot be retroactively verified by a
        // token issued for the previous one.
        [playerId, player.email, issued.tokenHash, issued.expiresAt],
      );
      const link = `${baseUrl()}/?verifyToken=${encodeURIComponent(issued.token)}`;
      await mailer.send({
        to: player.email,
        subject: 'Confirm your Grimore email address',
        text:
          `Confirm this address for your Grimore account (${player.username}) by opening this link ` +
          `within 24 hours:\n\n${link}\n`,
      });
      auditAccountEvent(pool, log, req, 'email.verification.sent', { playerId });
      res.json({ success: true, devVerifyLink: devLinkFor(link) });
    }),
  );

  r.post(
    '/verify-email/confirm',
    recoveryLimiter,
    wrap(async (req: Request, res) => {
      const input = VerifyEmailInput.parse(req.body);
      const tokenHash = hashToken(input.token);

      const result = await withTransaction(pool, async (client: PoolClient) => {
        const q = await client.query<{
          id: string;
          player_id: string;
          email: string;
          expires_at: Date;
          consumed_at: Date | null;
        }>(
          `SELECT id, player_id, email, expires_at, consumed_at FROM email_verifications
            WHERE token_hash = $1 FOR UPDATE`,
          [tokenHash],
        );
        const row = q.rows[0];
        const rejection = checkToken(row ? { expiresAt: row.expires_at, consumedAt: row.consumed_at } : null);
        if (rejection) return { ok: false as const };

        // Only marks the address the token was issued for. If the account's address has changed since,
        // this token proves control of the old one and nothing about the new one.
        const updated = await client.query(
          `UPDATE players SET email_verified_at = now()
            WHERE id = $1 AND lower(email) = lower($2) AND email_verified_at IS NULL`,
          [row!.player_id, row!.email],
        );
        await client.query('UPDATE email_verifications SET consumed_at = now() WHERE id = $1', [row!.id]);
        return { ok: true as const, playerId: row!.player_id, matched: (updated.rowCount ?? 0) > 0 };
      });

      if (!result.ok) {
        throw new ApiError(400, 'VALIDATION', TOKEN_REJECTION_MESSAGE);
      }
      if (!result.matched) {
        // The token was valid but the address it proves is no longer the account's. Consumed above so it
        // cannot be replayed, and refused with the same message so it reveals nothing about why.
        throw new ApiError(400, 'VALIDATION', TOKEN_REJECTION_MESSAGE);
      }
      auditAccountEvent(pool, log, req, 'email.verified', { playerId: result.playerId });
      res.json({ success: true });
    }),
  );

  return r;
}
