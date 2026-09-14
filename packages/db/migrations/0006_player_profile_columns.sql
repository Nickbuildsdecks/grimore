-- Columns the legacy profile handlers read and write, but which the baseline schema never created.
--
-- `GET /api/players/:playerId/profile` selects profile_theme, featured_deck_id, discord_handle and
-- moxfield_username from `players`; none of them exist, so the endpoint raises on Postgres. The same
-- four are written by `POST /api/players/profile/update`. Same class of divergence as migration 0005.
ALTER TABLE players ADD COLUMN IF NOT EXISTS profile_theme     TEXT NOT NULL DEFAULT 'default';
ALTER TABLE players ADD COLUMN IF NOT EXISTS featured_deck_id  TEXT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS discord_handle    TEXT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS moxfield_username TEXT;

-- ON DELETE SET NULL, not CASCADE: deleting a deck must clear the pointer, never delete the player.
-- Without this the decks slice's DELETE would fail with a foreign key violation once a deck is featured.
DO $do$
BEGIN
  ALTER TABLE players
    ADD CONSTRAINT players_featured_deck_id_fkey
    FOREIGN KEY (featured_deck_id) REFERENCES decks(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END;
$do$;

-- The profile's stats query joins `seasons` on `player_stats.season_id`, which the baseline also lacks.
-- Nullable, mirroring deck_stats.season_id: player_stats is keyed on player_id alone (lifetime totals),
-- and the column just records which season the row was last accumulated under.
ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS season_id TEXT;
DO $do$
BEGIN
  ALTER TABLE player_stats
    ADD CONSTRAINT player_stats_season_id_fkey
    FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END;
$do$;

-- players.username has a case-SENSITIVE UNIQUE constraint, but every lookup in the app is
-- LOWER(username) — so "Nick" and "nick" are two accounts that both answer to one login. A unique index
-- on the lowercase form closes that. It is created concurrently-safe via a guarded block: on a database
-- that already contains a case-collision it must not block the rest of the migration.
DO $do$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS idx_players_username_lower_unique ON players (LOWER(username));
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'players.username has case-insensitive duplicates; unique index not created';
END;
$do$;

CREATE INDEX IF NOT EXISTS idx_players_featured_deck ON players (featured_deck_id) WHERE featured_deck_id IS NOT NULL;
