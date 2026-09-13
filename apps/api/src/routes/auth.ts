/**
 * Auth slice — first strangler route group, ported from legacy server.js (register/login/logout/status/me).
 *
 * Compatibility: reads/writes the SAME `players` table and bcrypt hashes the legacy app uses, so an
 * account created on either side works on both. Session is server-side in Redis (cookie holds only the sid).
 *
 * Deliberate differences vs legacy (all audit findings):
 *  - Login never auto-creates accounts.
 *  - Google login / password reset are NOT ported yet (they need verified tokens + email delivery — Phase 2).
 *  - Responses use the typed contracts from @grimore/shared (snake_case player fields).
 */
import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { RegisterInput, LoginInput, MePlayer, type AuthStatus } from '@grimore/shared';
import type { AppContext } from '../app.js';
import { ApiError, wrap } from '../lib/errors.js';

const PLAYER_COLUMNS = `id, username, store_nickname, avatar_url, profile_commander, profile_bio, is_admin,
  role, premium_status, premium_until, created_at, email`;

function newPlayerId(): string {
  // Same shape the legacy app generates, so ids stay uniform across both apps.
  return 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
}

export function authRouter(ctx: AppContext): Router {
  const { pool } = ctx;
  const r = Router();

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

  async function loadMe(playerId: string, isGuest = false) {
    const q = await pool.query(`SELECT ${PLAYER_COLUMNS} FROM players WHERE id = $1`, [playerId]);
    const row = q.rows[0];
    if (!row) return null;
    return MePlayer.parse({ ...row, is_guest: isGuest });
  }

  async function status(req: Request): Promise<AuthStatus> {
    const id = req.session.playerId;
    if (!id) return { loggedIn: false, googleClientId: '' };
    const user = await loadMe(id, req.session.isGuest ?? false);
    if (!user) {
      req.session.destroy(() => {});
      return { loggedIn: false, googleClientId: '' };
    }
    return { loggedIn: true, user, googleClientId: '' };
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
      req.session.isGuest = false;
      const user = MePlayer.parse({ ...row, is_guest: false });
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
