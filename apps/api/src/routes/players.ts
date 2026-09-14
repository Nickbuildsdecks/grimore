/**
 * Players slice — public profile, profile editing and account credentials, ported from legacy server.js
 * (`/api/players/:playerId/profile`, `/api/players/profile/update`, `/api/players/account/update`).
 *
 * ## Missing columns, again
 *
 * The profile read selects `profile_theme`, `featured_deck_id`, `discord_handle` and `moxfield_username`
 * from `players`, and joins `seasons` on `player_stats.season_id`. None of those five columns exist in
 * the baseline schema, so the endpoint raises on Postgres — the same class of divergence migration 0005
 * fixed for collections. Migration 0006 adds them.
 *
 * ## Security fixes
 *
 *  - **Account takeover via a hijacked session.** Legacy required the current password only for a
 *    *password* change; changing the username and email needed nothing. Anyone with a stolen session
 *    cookie could quietly move the account to their own email and lock the owner out. The current
 *    password is now required for any credential change.
 *  - **Username case collision.** `players.username` has a case-SENSITIVE UNIQUE constraint, while every
 *    lookup in the app uses LOWER(username). Legacy's account update checked `username = ?` exactly, so
 *    "Nick" could be registered alongside "nick" and both would answer to the same login. Usernames are
 *    normalized to lowercase (as the Username contract already does on register) and checked
 *    case-insensitively; migration 0006 adds the matching unique index.
 *  - Password changes re-issue the session id, so a session stolen before the change stops working.
 *
 * ## Other legacy bugs fixed
 *
 *  - `featured_deck_id` had no foreign key, so deleting a featured deck left a dangling pointer and the
 *    profile's featured-deck lookup silently returned nothing. Migration 0006 adds ON DELETE SET NULL.
 *  - The featured deck was returned from a bare `SELECT d.*` with no visibility check, leaking a private
 *    deck's contents to any viewer if the owner had featured it. It is now only served when public, or
 *    to the owner.
 *  - Profile updates wrote every column unconditionally, so a client that omitted a field wiped it.
 *  - Account update returned 400 for a taken username, which is a conflict, not a malformed request.
 *
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import type { Queryable, PoolClient } from '@grimore/db';
import { withTransaction } from '@grimore/db';
import {
  AccountUpdateInput,
  Id,
  OwnPlayerProfile,
  PlayerProfile,
  PlayerStats,
  ProfileDeck,
  ProfileUpdateInput,
} from '@grimore/shared';
import type { AppContext } from '../app.js';
import { ApiError, wrap } from '../lib/errors.js';
import { rejectProfanity } from '../lib/moderation.js';
import { requireAuth, sessionPlayerId } from '../lib/auth.js';

/** Everything on the public profile. `email` is added separately, and only for the owner. */
const PROFILE_COLUMNS = `id, username, store_nickname, avatar_url, profile_commander, profile_bio,
  profile_theme, featured_deck_id, discord_handle, moxfield_username, is_admin, role, premium_status, created_at`;

const DECK_COLUMNS = `d.id, d.deck_name, d.cheapest_total_price, d.featured_card_name, d.is_public,
  (SELECT card_name FROM deck_cards WHERE deck_id = d.id AND is_commander = 1 ORDER BY id LIMIT 1) AS commander_name,
  (SELECT scryfall_id FROM deck_cards WHERE deck_id = d.id AND is_commander = 1 ORDER BY id LIMIT 1) AS commander_scryfall_id`;

export function playersRouter(ctx: AppContext): Router {
  const { pool } = ctx;
  const r = Router();

  async function usernameTaken(db: Queryable, username: string, exceptPlayerId: string): Promise<boolean> {
    const q = await db.query('SELECT 1 FROM players WHERE LOWER(username) = LOWER($1) AND id <> $2', [
      username,
      exceptPlayerId,
    ]);
    return (q.rowCount ?? 0) > 0;
  }

  // ── Public profile ──────────────────────────────────────────────────────────────────────────────
  r.get(
    '/:playerId/profile',
    wrap(async (req, res) => {
      const playerId = Id.parse(req.params.playerId);
      const viewerId = req.session.playerId ?? null;
      const isOwner = viewerId === playerId;

      const profileQ = await pool.query(`SELECT ${PROFILE_COLUMNS} FROM players WHERE id = $1`, [playerId]);
      const row = profileQ.rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Player not found.');

      // Email is PII and stays off the public endpoint; it is merged in only for the owner.
      let profile;
      if (isOwner) {
        const own = await pool.query('SELECT email FROM players WHERE id = $1', [playerId]);
        profile = OwnPlayerProfile.parse({ ...row, email: own.rows[0]?.email ?? null });
      } else {
        profile = PlayerProfile.parse(row);
      }

      const [statsQ, decksQ] = await Promise.all([
        // LEFT JOIN, not JOIN: player_stats rows predating the season tag have a NULL season_id, and an
        // inner join would drop a player's stats entirely.
        pool.query(
          `SELECT ps.player_id, ps.total_games, ps.total_wins, ps.total_kills, ps.total_points, ps.win_rate,
                  ps.season_id, s.name AS season_name
           FROM player_stats ps LEFT JOIN seasons s ON s.id = ps.season_id
           WHERE ps.player_id = $1`,
          [playerId],
        ),
        pool.query(
          `SELECT ${DECK_COLUMNS} FROM decks d
           WHERE d.player_id = $1 AND (d.is_public = 1 OR $2::boolean) ORDER BY d.updated_at DESC, d.id DESC`,
          [playerId, isOwner],
        ),
      ]);

      let featuredDeck = null;
      if (profile.featured_deck_id) {
        // Legacy selected the featured deck with no visibility check, so featuring a private deck
        // published it to every visitor.
        const fd = await pool.query(
          `SELECT ${DECK_COLUMNS} FROM decks d WHERE d.id = $1 AND (d.is_public = 1 OR $2::boolean)`,
          [profile.featured_deck_id, isOwner],
        );
        featuredDeck = fd.rows[0] ? ProfileDeck.parse(fd.rows[0]) : null;
      }

      res.json({
        profile,
        stats: statsQ.rows.map((s) => PlayerStats.parse(s)),
        publicDecks: decksQ.rows.map((d) => ProfileDeck.parse(d)),
        featuredDeck,
        isOwner,
      });
    }),
  );

  // ── Edit own profile ────────────────────────────────────────────────────────────────────────────
  r.post(
    '/profile/update',
    requireAuth,
    wrap(async (req, res) => {
      const input = ProfileUpdateInput.parse(req.body);
      const playerId = sessionPlayerId(req);
      rejectProfanity({
        Nickname: input.storeNickname,
        Commander: input.profileCommander,
        Bio: input.profileBio,
        'Discord handle': input.discordHandle,
        'Moxfield username': input.moxfieldUsername,
      });

      const updated = await withTransaction(pool, async (client: PoolClient) => {
        if (input.featuredDeckId) {
          const deck = await client.query('SELECT 1 FROM decks WHERE id = $1 AND player_id = $2', [
            input.featuredDeckId,
            playerId,
          ]);
          if (!deck.rowCount) throw new ApiError(400, 'VALIDATION', 'Selected featured deck does not belong to you.');
        }
        const q = await client.query(
          `UPDATE players SET store_nickname = $1, avatar_url = $2, profile_commander = $3, profile_bio = $4,
                              profile_theme = $5, featured_deck_id = $6, discord_handle = $7, moxfield_username = $8
           WHERE id = $9
           RETURNING ${PROFILE_COLUMNS}`,
          [input.storeNickname, input.avatarUrl, input.profileCommander, input.profileBio, input.profileTheme,
           input.featuredDeckId, input.discordHandle, input.moxfieldUsername, playerId],
        );
        return q.rows[0];
      });
      res.json({ success: true, profile: PlayerProfile.parse(updated) });
    }),
  );

  // ── Change credentials ──────────────────────────────────────────────────────────────────────────
  r.post(
    '/account/update',
    requireAuth,
    wrap(async (req, res) => {
      const input = AccountUpdateInput.parse(req.body);
      const playerId = sessionPlayerId(req);

      const me = await pool.query('SELECT password_hash FROM players WHERE id = $1', [playerId]);
      if (!me.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Player not found.');
      // Required for ANY credential change, not just a password one — see the header comment.
      const ok = await bcrypt.compare(input.currentPassword, me.rows[0].password_hash);
      if (!ok) throw new ApiError(403, 'FORBIDDEN', 'Current password is incorrect.');

      await withTransaction(pool, async (client: PoolClient) => {
        if (input.newUsername) {
          rejectProfanity({ Username: input.newUsername });
          // The Username contract already lowercased it; the check matches how logins look accounts up.
          if (await usernameTaken(client, input.newUsername, playerId)) {
            throw new ApiError(409, 'USERNAME_TAKEN', 'Username is already taken.');
          }
          await client.query('UPDATE players SET username = $1 WHERE id = $2', [input.newUsername, playerId]);
        }
        if (input.newEmail) {
          const taken = await client.query('SELECT 1 FROM players WHERE LOWER(email) = LOWER($1) AND id <> $2', [
            input.newEmail,
            playerId,
          ]);
          if (taken.rowCount) throw new ApiError(409, 'EMAIL_TAKEN', 'Email address is already in use.');
          await client.query('UPDATE players SET email = $1 WHERE id = $2', [input.newEmail, playerId]);
        }
        if (input.newPassword) {
          const hash = await bcrypt.hash(input.newPassword, 10);
          await client.query('UPDATE players SET password_hash = $1 WHERE id = $2', [hash, playerId]);
        }
      });

      // A password change invalidates other sessions by rotating this one's id; a session stolen before
      // the change no longer resolves. Legacy left every existing session valid.
      if (input.newPassword) {
        await new Promise<void>((resolve, reject) =>
          req.session.regenerate((err) => (err ? reject(err) : resolve())),
        );
        req.session.playerId = playerId;
        req.session.isGuest = false;
      }
      res.json({ success: true });
    }),
  );

  return r;
}
