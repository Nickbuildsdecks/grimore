-- The social feature set (friends, direct messages, notifications, follows) against the real schema.
--
-- Three separate divergences made every social route fail on Postgres:
--   1. `friend_requests` does not exist at all — the six /api/friends routes have no table to read.
--   2. The messages routes query `direct_messages`, which does not exist either. The baseline DOES have
--      a `messages` table with exactly the right shape (id, sender_id, recipient_id, subject, body,
--      is_read, created_at), so the v2 slice uses that rather than creating a duplicate table. Nothing
--      is lost: with no `direct_messages` table, no message can ever have been stored on Postgres.
--   3. `follows` is keyed (follower_id, following_id), but every legacy query names `followed_id`.
--
-- `notifications` needs no rename: the baseline column is `is_read` and legacy's `read_status` was the
-- drift. Its `id` stays the integer serial from the schema — legacy inserted `notif_<ts>_<rand>` text
-- ids, the same mistake the decks slice found in deck_comments.

CREATE TABLE IF NOT EXISTS friend_requests (
  id           TEXT PRIMARY KEY,
  sender_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT friend_requests_not_self CHECK (sender_id <> recipient_id)
);

-- Friendship is symmetric, so the pair must be unique in EITHER direction: without this, two players who
-- request each other simultaneously end up with two rows and an ambiguous status.
CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pair
  ON friend_requests (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id));
CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient ON friend_requests (recipient_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_requests_sender ON friend_requests (sender_id, status);

-- `follows` has no uniqueness, so a double-click could insert the same follow twice and the unfollow
-- toggle would then need two clicks to clear it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_follows_pair ON follows (follower_id, following_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows (following_id);

-- Inbox and sent list both order by created_at within one participant.
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages (recipient_id) WHERE is_read = 0;

-- notifications.type is NOT NULL with no default, and every legacy INSERT omits it — so even with the
-- right id type, writing a notification raises. A default keeps older writers working.
ALTER TABLE notifications ALTER COLUMN type SET DEFAULT 'general';
CREATE INDEX IF NOT EXISTS idx_notifications_player_created ON notifications (player_id, created_at DESC);
