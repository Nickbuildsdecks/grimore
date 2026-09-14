/**
 * Social slice — friends, direct messages, notifications and follows, ported from legacy server.js.
 *
 * ## Every social route failed on Postgres
 *
 * Three separate schema divergences, each fatal on its own:
 *
 *  1. **`friend_requests` does not exist.** All six /api/friends routes query a table the baseline schema
 *     never created. Migration 0007 creates it.
 *  2. **`direct_messages` does not exist either.** The baseline DOES have a `messages` table with exactly
 *     the right shape (id, sender_id, recipient_id, subject, body, is_read, created_at), so this slice
 *     uses that rather than creating a duplicate. Nothing is lost by the choice: with no
 *     `direct_messages` table, no message can ever have been stored on Postgres.
 *  3. **`follows` is keyed (follower_id, following_id)**, but every legacy query names `followed_id`.
 *
 * On top of those, `notifications.type` is NOT NULL with no default and every legacy INSERT omits it, so
 * even a correctly-typed write raises. Each notification now carries a real type; 0007 also adds a
 * default so any remaining legacy writer keeps working. `notifications.id` stays the integer serial from
 * the schema — legacy inserted `notif_<ts>_<rand>` text ids, the same mistake the decks slice found in
 * `deck_comments`. Legacy's `read_status` was drift too: the column is `is_read`.
 *
 * ## Other legacy bugs fixed
 *
 *  - **Friend requests were not symmetric.** The pair had no uniqueness, so if two players requested each
 *    other at the same moment both rows were written and the friendship status became whichever one the
 *    query happened to return. 0007 adds a unique index on the unordered pair.
 *  - **A declined request was permanent.** Decline set status='declined' and the "already exists" guard
 *    then matched that row forever, so the two players could never become friends. Declining now clears
 *    the row, and a new request can be sent.
 *  - **Accept did not check the current status**, so a request already accepted or declined could be
 *    re-accepted, re-notifying the sender each time.
 *  - **Sending a message was not atomic** with writing the recipient's notification; a failure between
 *    them delivered a message with no bell. They now share a transaction (likewise friend request /
 *    accept / follow).
 *  - **`follows` had no uniqueness**, so a double-click inserted the row twice and the unfollow toggle
 *    then needed two clicks to clear it.
 *  - **Notifications were capped at 10 with no way to see more and no way to mark all read.** The limit
 *    is now a query parameter, and `{ all: true }` clears the bell.
 *  - Marking a message read reported success even when the id belonged to someone else's message; it now
 *    404s, so the UI cannot silently fail.
 *  - `store_nickname` came from the session (`req.session.player.storeNickname`), which goes stale after a
 *    profile rename. Notification text is built from the database row.
 */
import { Router } from 'express';
import type { PoolClient, Queryable } from '@grimore/db';
import { withTransaction } from '@grimore/db';
import {
  FeedbackInput,
  Friend,
  FriendRequest,
  FriendshipState,
  DirectMessage,
  Id,
  MarkNotificationReadInput,
  Notification,
  NotificationsQuery,
  SendMessageInput,
  type NotificationType,
} from '@grimore/shared';
import type { AppContext } from '../app.js';
import { ApiError, wrap } from '../lib/errors.js';
import { requireAuth, sessionPlayerId } from '../lib/auth.js';

function newId(prefix: string): string {
  return prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
}

/** Always writes `type`: the column is NOT NULL and every legacy INSERT omitted it. */
async function notify(
  db: Queryable,
  playerId: string,
  type: NotificationType,
  title: string,
  message: string,
  linkUrl: string | null = null,
): Promise<void> {
  await db.query(
    'INSERT INTO notifications (player_id, type, title, message, link_url, is_read) VALUES ($1, $2, $3, $4, $5, 0)',
    [playerId, type, title, message, linkUrl],
  );
}

/** Display name straight from the row — the session copy goes stale after a profile rename. */
async function nicknameOf(db: Queryable, playerId: string): Promise<string> {
  const q = await db.query('SELECT store_nickname FROM players WHERE id = $1', [playerId]);
  return (q.rows[0]?.store_nickname as string | undefined) ?? 'A player';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// ── Friends ───────────────────────────────────────────────────────────────────────────────────────
export function friendsRouter(ctx: AppContext): Router {
  const { pool } = ctx;
  const r = Router();
  r.use(requireAuth);

  /** The one row for this pair, in whichever direction it was created. */
  async function loadPair(db: Queryable, me: string, other: string, forUpdate = false) {
    const q = await db.query(
      `SELECT * FROM friend_requests
       WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      [me, other],
    );
    return q.rows[0] ?? null;
  }

  r.get(
    '/',
    wrap(async (req, res) => {
      const me = sessionPlayerId(req);
      // Friendship is symmetric, so "the friend" is whichever side of the row is not the caller.
      const rows = await pool.query(
        `SELECT CASE WHEN fr.sender_id = $1 THEN fr.recipient_id ELSE fr.sender_id END AS friend_id,
                CASE WHEN fr.sender_id = $1 THEN rp.store_nickname ELSE sp.store_nickname END AS friend_name,
                CASE WHEN fr.sender_id = $1 THEN rp.username ELSE sp.username END AS friend_username,
                CASE WHEN fr.sender_id = $1 THEN rp.avatar_url ELSE sp.avatar_url END AS friend_avatar,
                fr.updated_at AS friends_since
         FROM friend_requests fr
         JOIN players sp ON sp.id = fr.sender_id
         JOIN players rp ON rp.id = fr.recipient_id
         WHERE fr.status = 'accepted' AND (fr.sender_id = $1 OR fr.recipient_id = $1)
         ORDER BY friend_name ASC`,
        [me],
      );
      res.json(rows.rows.map((f) => Friend.parse(f)));
    }),
  );

  r.get(
    '/requests',
    wrap(async (req, res) => {
      const me = sessionPlayerId(req);
      const rows = await pool.query(
        `SELECT fr.id, fr.sender_id, fr.created_at, p.store_nickname AS sender_name,
                p.username AS sender_username, p.avatar_url AS sender_avatar
         FROM friend_requests fr JOIN players p ON p.id = fr.sender_id
         WHERE fr.recipient_id = $1 AND fr.status = 'pending'
         ORDER BY fr.created_at DESC, fr.id DESC`,
        [me],
      );
      res.json(rows.rows.map((f) => FriendRequest.parse(f)));
    }),
  );

  r.get(
    '/status/:playerId',
    wrap(async (req, res) => {
      const me = sessionPlayerId(req);
      const other = Id.parse(req.params.playerId);
      const row = await loadPair(pool, me, other);
      if (!row) {
        res.json(FriendshipState.parse({ status: 'none' }));
        return;
      }
      res.json(FriendshipState.parse({ status: row.status, isSender: row.sender_id === me, requestId: row.id }));
    }),
  );

  r.post(
    '/request/:playerId',
    wrap(async (req, res) => {
      const me = sessionPlayerId(req);
      const other = Id.parse(req.params.playerId);
      if (me === other) throw new ApiError(400, 'VALIDATION', 'You cannot friend yourself.');

      const requestId = await withTransaction(pool, async (client: PoolClient) => {
        const target = await client.query('SELECT 1 FROM players WHERE id = $1', [other]);
        if (!target.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Player not found.');

        const existing = await loadPair(client, me, other, true);
        if (existing) {
          if (existing.status === 'accepted') throw new ApiError(409, 'CONFLICT', 'You are already friends.');
          if (existing.status === 'pending') throw new ApiError(409, 'CONFLICT', 'A friend request is already pending.');
          // A previously declined request is cleared rather than blocking the pair forever, which is what
          // legacy's "already exists" guard did.
          await client.query('DELETE FROM friend_requests WHERE id = $1', [existing.id]);
        }
        const id = newId('fr_');
        await client.query('INSERT INTO friend_requests (id, sender_id, recipient_id) VALUES ($1, $2, $3)', [id, me, other]);
        const nickname = await nicknameOf(client, me);
        await notify(client, other, 'friend_request', `Friend request from ${nickname}`,
          `${nickname} wants to be your friend. Check your Friends tab to accept.`);
        return id;
      });
      res.status(201).json({ success: true, requestId });
    }),
  );

  r.post(
    '/accept/:requestId',
    wrap(async (req, res) => {
      const me = sessionPlayerId(req);
      const requestId = Id.parse(req.params.requestId);
      await withTransaction(pool, async (client: PoolClient) => {
        const q = await client.query('SELECT * FROM friend_requests WHERE id = $1 AND recipient_id = $2 FOR UPDATE', [
          requestId,
          me,
        ]);
        const fr = q.rows[0];
        if (!fr) throw new ApiError(404, 'NOT_FOUND', 'Request not found.');
        // Legacy accepted unconditionally, so an already-settled request could be re-accepted and the
        // sender re-notified every time.
        if (fr.status !== 'pending') throw new ApiError(409, 'CONFLICT', 'This request has already been answered.');
        await client.query(`UPDATE friend_requests SET status = 'accepted', updated_at = now() WHERE id = $1`, [requestId]);
        const nickname = await nicknameOf(client, me);
        await notify(client, fr.sender_id, 'friend_accepted', `${nickname} accepted your friend request`,
          `You are now friends with ${nickname}. You can message them directly from your friends list.`);
      });
      res.json({ success: true });
    }),
  );

  r.post(
    '/decline/:requestId',
    wrap(async (req, res) => {
      const me = sessionPlayerId(req);
      const requestId = Id.parse(req.params.requestId);
      // Deleting rather than marking 'declined' leaves the pair free to try again. Legacy's decline wrote
      // a row that its own duplicate guard then treated as blocking, permanently.
      const del = await pool.query(`DELETE FROM friend_requests WHERE id = $1 AND recipient_id = $2 AND status = 'pending'`, [
        requestId,
        me,
      ]);
      if (!del.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Request not found.');
      res.json({ success: true });
    }),
  );

  r.delete(
    '/:playerId',
    wrap(async (req, res) => {
      const me = sessionPlayerId(req);
      const other = Id.parse(req.params.playerId);
      const del = await pool.query(
        `DELETE FROM friend_requests
         WHERE status = 'accepted'
           AND ((sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1))`,
        [me, other],
      );
      // Legacy reported success whether or not a friendship existed.
      if (!del.rowCount) throw new ApiError(404, 'NOT_FOUND', 'You are not friends with this player.');
      res.json({ success: true });
    }),
  );

  return r;
}

// ── Messages ──────────────────────────────────────────────────────────────────────────────────────
export function messagesRouter(ctx: AppContext): Router {
  const { pool } = ctx;
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/inbox',
    wrap(async (req, res) => {
      const me = sessionPlayerId(req);
      const rows = await pool.query(
        `SELECT m.*, m.sender_id AS counterpart_id, p.store_nickname AS counterpart_name,
                p.username AS counterpart_username
         FROM messages m LEFT JOIN players p ON p.id = m.sender_id
         WHERE m.recipient_id = $1
         ORDER BY m.created_at DESC, m.id DESC LIMIT 50`,
        [me],
      );
      res.json(rows.rows.map((m) => DirectMessage.parse(m)));
    }),
  );

  r.get(
    '/sent',
    wrap(async (req, res) => {
      const me = sessionPlayerId(req);
      const rows = await pool.query(
        `SELECT m.*, m.recipient_id AS counterpart_id, p.store_nickname AS counterpart_name,
                p.username AS counterpart_username
         FROM messages m LEFT JOIN players p ON p.id = m.recipient_id
         WHERE m.sender_id = $1
         ORDER BY m.created_at DESC, m.id DESC LIMIT 50`,
        [me],
      );
      res.json(rows.rows.map((m) => DirectMessage.parse(m)));
    }),
  );

  r.get(
    '/unread-count',
    wrap(async (req, res) => {
      const me = sessionPlayerId(req);
      const q = await pool.query('SELECT COUNT(*)::int AS count FROM messages WHERE recipient_id = $1 AND is_read = 0', [me]);
      res.json({ count: q.rows[0]?.count ?? 0 });
    }),
  );

  r.post(
    '/send',
    wrap(async (req, res) => {
      const input = SendMessageInput.parse(req.body);
      const me = sessionPlayerId(req);
      const messageId = await withTransaction(pool, async (client: PoolClient) => {
        const recipient = await client.query('SELECT id FROM players WHERE LOWER(username) = LOWER($1)', [
          input.recipientUsername,
        ]);
        const recipientId = recipient.rows[0]?.id as string | undefined;
        if (!recipientId) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
        if (recipientId === me) throw new ApiError(400, 'VALIDATION', 'You cannot message yourself.');

        const subject = input.subject || '(no subject)';
        const id = newId('msg_');
        await client.query(
          'INSERT INTO messages (id, sender_id, recipient_id, subject, body, is_read) VALUES ($1, $2, $3, $4, $5, 0)',
          [id, me, recipientId, subject, input.body],
        );
        // Same transaction as the message: legacy could deliver a message with no bell notification.
        const nickname = await nicknameOf(client, me);
        await notify(client, recipientId, 'message', `Message from ${nickname}`,
          `"${subject}": ${truncate(input.body, 120)}`);
        return id;
      });
      res.status(201).json({ success: true, messageId });
    }),
  );

  r.post(
    '/feedback',
    wrap(async (req, res) => {
      const input = FeedbackInput.parse(req.body);
      const me = sessionPlayerId(req);
      await withTransaction(pool, async (client: PoolClient) => {
        const admin = await client.query('SELECT id FROM players WHERE is_admin = 1 ORDER BY created_at ASC LIMIT 1');
        const adminId = admin.rows[0]?.id as string | undefined;
        if (!adminId) throw new ApiError(503, 'UNAVAILABLE', 'Feedback is unavailable: no administrator account exists.');
        if (adminId === me) throw new ApiError(400, 'VALIDATION', 'You are the administrator.');
        const nickname = await nicknameOf(client, me);
        await client.query(
          'INSERT INTO messages (id, sender_id, recipient_id, subject, body, is_read) VALUES ($1, $2, $3, $4, $5, 0)',
          [newId('msg_'), me, adminId, `Feedback from ${nickname}`, input.body],
        );
        await notify(client, adminId, 'feedback', `Feedback from ${nickname}`, truncate(input.body, 180));
      });
      res.status(201).json({ success: true });
    }),
  );

  r.post(
    '/:id/read',
    wrap(async (req, res) => {
      const me = sessionPlayerId(req);
      const id = Id.parse(req.params.id);
      const upd = await pool.query('UPDATE messages SET is_read = 1 WHERE id = $1 AND recipient_id = $2', [id, me]);
      // Legacy answered success even when the id belonged to someone else's message.
      if (!upd.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Message not found.');
      res.json({ success: true });
    }),
  );

  return r;
}

// ── Notifications ─────────────────────────────────────────────────────────────────────────────────
export function notificationsRouter(ctx: AppContext): Router {
  const { pool } = ctx;
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/',
    wrap(async (req, res) => {
      const me = sessionPlayerId(req);
      const q = NotificationsQuery.parse(req.query);
      // Legacy hard-coded LIMIT 10 with no way to page further back.
      const rows = await pool.query(
        `SELECT * FROM notifications
         WHERE player_id = $1 ${q.unreadOnly ? 'AND is_read = 0' : ''}
         ORDER BY created_at DESC, id DESC LIMIT $2`,
        [me, q.limit],
      );
      const unread = await pool.query('SELECT COUNT(*)::int AS count FROM notifications WHERE player_id = $1 AND is_read = 0', [me]);
      res.json({ items: rows.rows.map((n) => Notification.parse(n)), unreadCount: unread.rows[0]?.count ?? 0 });
    }),
  );

  r.post(
    '/read',
    wrap(async (req, res) => {
      const me = sessionPlayerId(req);
      const input = MarkNotificationReadInput.parse(req.body);
      if (input.all) {
        const upd = await pool.query('UPDATE notifications SET is_read = 1 WHERE player_id = $1 AND is_read = 0', [me]);
        res.json({ success: true, updated: upd.rowCount ?? 0 });
        return;
      }
      const upd = await pool.query('UPDATE notifications SET is_read = 1 WHERE id = $1 AND player_id = $2', [input.id, me]);
      if (!upd.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Notification not found.');
      res.json({ success: true, updated: 1 });
    }),
  );

  return r;
}

// ── Follows (mounted under /api/players to keep the legacy paths) ─────────────────────────────────
export function followsRouter(ctx: AppContext): Router {
  const { pool } = ctx;
  const r = Router();

  r.post(
    '/:playerId/follow',
    requireAuth,
    wrap(async (req, res) => {
      const me = sessionPlayerId(req);
      const target = Id.parse(req.params.playerId);
      if (me === target) throw new ApiError(400, 'VALIDATION', 'You cannot follow yourself.');
      const following = await withTransaction(pool, async (client: PoolClient) => {
        const exists = await client.query('SELECT 1 FROM players WHERE id = $1', [target]);
        if (!exists.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Player not found.');
        // The legacy column name was `followed_id`, which does not exist: the column is `following_id`.
        const del = await client.query('DELETE FROM follows WHERE follower_id = $1 AND following_id = $2', [me, target]);
        if (del.rowCount) return false;
        // ON CONFLICT against the unique index from 0007: a double-click cannot insert twice.
        await client.query(
          'INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [me, target],
        );
        const nickname = await nicknameOf(client, me);
        await notify(client, target, 'follow', 'New follower', `${nickname} started following you.`);
        return true;
      });
      res.json({ success: true, following });
    }),
  );

  r.get(
    '/:playerId/following',
    wrap(async (req, res) => {
      const me = req.session.playerId ?? null;
      const target = Id.parse(req.params.playerId);
      if (!me) {
        res.json({ following: false, followerCount: 0 });
        return;
      }
      const [mine, count] = await Promise.all([
        pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [me, target]),
        pool.query('SELECT COUNT(*)::int AS count FROM follows WHERE following_id = $1', [target]),
      ]);
      res.json({ following: !!mine.rowCount, followerCount: count.rows[0]?.count ?? 0 });
    }),
  );

  return r;
}
