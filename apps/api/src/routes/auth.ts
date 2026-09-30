/**
 * Auth slice — first strangler route group, ported from legacy server.js (register/login/logout/status/me).
 *
 * Compatibility: reads/writes the SAME `players` table and bcrypt hashes the legacy app uses, so an
 * account created on either side works on both. Session is server-side in Redis (cookie holds only the sid).
 *
 * Deliberate differences vs legacy (all audit findings):
 *  - Login never auto-creates accounts.
 *  - Password reset is NOT ported yet (it needs email delivery).
 *  - Google sign-in IS ported; see the block above the route for what it tightens.
 *  - Responses use the typed contracts from @grimore/shared (snake_case player fields).
 */
import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { RegisterInput, LoginInput, GoogleSignInInput, MePlayer, type AuthStatus } from '@grimore/shared';
import { withTransaction } from '@grimore/db';
import type { AppContext } from '../app.js';
import { ApiError, wrap } from '../lib/errors.js';
import { stampSessionEpoch } from '../lib/sessionEpoch.js';
import { createGoogleVerifier, type GoogleIdentity, type GoogleVerifier } from '../lib/googleIdentity.js';

const PLAYER_COLUMNS = `id, username, store_nickname, avatar_url, profile_commander, profile_bio, is_admin,
  role, premium_status, premium_until, created_at, email`;

function newPlayerId(): string {
  // Same shape the legacy app generates, so ids stay uniform across both apps.
  return 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
}

export function authRouter(ctx: AppContext, googleVerifier?: GoogleVerifier): Router {
  const { pool, env } = ctx;
  const r = Router();
  // Injected by tests. No test can mint a token Google will sign for a real client id, so the
  // account-resolution logic below is exercised with a stand-in verifier while the real one's
  // rejection paths are tested directly against Google in googleIdentity.test.ts.
  const verifier = googleVerifier ?? createGoogleVerifier(env.GOOGLE_CLIENT_ID);
  const adminEmails = new Set(env.ADMIN_GOOGLE_EMAILS.map((e) => e.toLowerCase()));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

  async function loadMe(playerId: string) {
    const q = await pool.query(`SELECT ${PLAYER_COLUMNS} FROM players WHERE id = $1`, [playerId]);
    const row = q.rows[0];
    if (!row) return null;
    return MePlayer.parse(row);
  }

  async function status(req: Request): Promise<AuthStatus> {
    const googleClientId = env.GOOGLE_CLIENT_ID ?? '';
    const id = req.session.playerId;
    if (!id) return { loggedIn: false, googleClientId };
    const user = await loadMe(id);
    if (!user) {
      req.session.destroy(() => {});
      return { loggedIn: false, googleClientId };
    }
    return { loggedIn: true, user, googleClientId };
  }

  r.post(
    '/register',
    authLimiter,
    wrap(async (req, res) => {
      const input = RegisterInput.parse(req.body);
      const exists = await pool.query('SELECT 1 FROM players WHERE LOWER(username) = LOWER($1)', [input.username]);
      if (exists.rowCount) throw new ApiError(409, 'USERNAME_TAKEN', 'Username already exists.');
      const hash = await bcrypt.hash(input.password, 10);
      const id = newPlayerId();
      await pool.query(
        `INSERT INTO players (id, username, password_hash, store_nickname, role, email)
         VALUES ($1, $2, $3, $4, 'player', $5)`,
        [id, input.username, hash, input.storeNickname, input.email],
      );
      res.status(201).json({ success: true, message: 'Registration successful! You can now log in.' });
    }),
  );

  r.post(
    '/login',
    authLimiter,
    wrap(async (req, res) => {
      const input = LoginInput.parse(req.body);
      const q = await pool.query(`SELECT ${PLAYER_COLUMNS}, password_hash FROM players WHERE LOWER(username) = LOWER($1)`, [
        input.username,
      ]);
      const row = q.rows[0];
      // Constant-ish time: always run a compare so username enumeration via timing is harder.
      const valid = row ? await bcrypt.compare(input.password, row.password_hash) : await bcrypt.compare(input.password, DUMMY_HASH);
      if (!row || !valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
      await regenerate(req);
      req.session.playerId = row.id;
      // Stamped so the epoch guard can tell this session from one issued before a later credential
      // change. An unstamped session is treated as invalid, so forgetting this here would silently log
      // everyone straight back out.
      stampSessionEpoch(req);
      const user = MePlayer.parse(row);
      res.json({ success: true, user });
    }),
  );

  r.post(
    '/logout',
    wrap(async (req, res) => {
      await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
      res.clearCookie('grimore.sid');
      res.json({ success: true });
    }),
  );

  /**
   * Google sign-in. Resolution order matches legacy: an existing link on `google_id`, then an
   * existing account with the same email, then a new account.
   *
   * Matching on email is what makes verification load-bearing — it lets a Google identity take over
   * a password account that shares the address. Legacy accepted an identity whose `email_verified`
   * claim was merely *absent*; `createGoogleVerifier` now requires it to be present and true, so
   * that path cannot be reached with an unverified address.
   *
   * The admin allow list is exact-match on the full address, never a substring: a prefix or suffix
   * test would let `owner@evil.com` through.
   */
  r.post(
    '/google',
    authLimiter,
    wrap(async (req, res) => {
      const input = GoogleSignInInput.parse(req.body);

      let identity: GoogleIdentity | null = null;
      if (input.credential) identity = await verifier.verifyIdToken(input.credential);
      if (!identity && input.accessToken) identity = await verifier.verifyAccessToken(input.accessToken);
      // One message for every failure mode. Distinguishing "bad token" from "unverified email"
      // from "not configured" tells a prober which of those they hit.
      if (!identity) throw new ApiError(401, 'INVALID_CREDENTIALS', 'A valid Google credential is required.');

      const email = identity.email;
      const player = await withTransaction(pool, async (client) => {
        let row = (
          await client.query(`SELECT ${PLAYER_COLUMNS} FROM players WHERE google_id = $1`, [identity!.googleId])
        ).rows[0];
        if (!row) {
          row = (
            await client.query(`SELECT ${PLAYER_COLUMNS} FROM players WHERE LOWER(email) = LOWER($1)`, [email])
          ).rows[0];
        }
        if (adminEmails.has(email.toLowerCase())) {
          const admin = (await client.query(`SELECT ${PLAYER_COLUMNS} FROM players WHERE id = 'p_admin'`)).rows[0];
          if (admin) row = admin;
        }

        if (row) {
          // `google_id` is UNIQUE. If this identity is already attached to a different row — an
          // account auto-created on an earlier sign-in, now resolving to p_admin — detach it there
          // first, or the UPDATE below collides on players_google_id_key.
          await client.query('UPDATE players SET google_id = NULL WHERE google_id = $1 AND id <> $2', [
            identity!.googleId,
            row.id,
          ]);
          await client.query('UPDATE players SET google_id = $1, email = $2 WHERE id = $3', [
            identity!.googleId,
            email,
            row.id,
          ]);
          return (await client.query(`SELECT ${PLAYER_COLUMNS} FROM players WHERE id = $1`, [row.id])).rows[0];
        }

        // New account. The password hash is of a value nobody holds, so the account is reachable
        // only through Google until its owner sets a password.
        const id = newPlayerId();
        const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '') || 'player';
        const hash = await bcrypt.hash(`google:${identity!.googleId}:${randomUUID()}`, 10);
        const nickname = (identity!.name || base).slice(0, 30);
        // Legacy appended four random digits and accepted whatever came out; a collision returned a
        // 500. Retry on the unique violation instead, then give up rather than loop forever.
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const username = `${base}_${Math.floor(1000 + Math.random() * 9000)}`;
          try {
            await client.query(
              `INSERT INTO players (id, username, password_hash, store_nickname, role, email, google_id)
               VALUES ($1, $2, $3, $4, 'player', $5, $6)`,
              [id, username, hash, nickname, email, identity!.googleId],
            );
            return (await client.query(`SELECT ${PLAYER_COLUMNS} FROM players WHERE id = $1`, [id])).rows[0];
          } catch (err) {
            const code = (err as { code?: string }).code;
            const constraint = (err as { constraint?: string }).constraint;
            if (code === '23505' && constraint !== 'players_google_id_key') continue;
            throw err;
          }
        }
        throw new ApiError(503, 'CONFLICT', 'Could not allocate a username. Please try again.');
      });

      await regenerate(req);
      req.session.playerId = player.id;
      stampSessionEpoch(req);
      res.json({ success: true, user: MePlayer.parse(player) });
    }),
  );

  r.get('/status', wrap(async (req, res) => res.json(await status(req))));
  r.get(
    '/me',
    wrap(async (req, res) => {
      const s = await status(req);
      if (!s.loggedIn) throw new ApiError(401, 'UNAUTHENTICATED', 'Not logged in.');
      res.json(s.user);
    }),
  );

  return r;
}

const DUMMY_HASH = bcrypt.hashSync('grimore-dummy-password', 10);

function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}
