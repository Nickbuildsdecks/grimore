-- The Events / league feature: check-in roster, Commander pods, pod results, and per-season standings.
--
-- The baseline schema carries a `tournaments` / `tournament_players` / `tournament_rounds` / `matches`
-- model that **nothing in server.js references** (zero occurrences). The live model — 15 references,
-- and the one CLAUDE.md describes as the "4P Pods & Swiss Leaderboards" engine — is `active_roster`,
-- `pods` and `pod_results`, none of which the baseline creates. So every Events route raises on
-- Postgres, the same way collections, the profile, social and the wishlist did.
--
-- This migration creates the pods model. The unused tournament_* tables are left alone: dropping
-- tables is destructive and they may hold pre-cutover data.

-- Who is checked in right now. One row per player: checking in with a second deck replaces the first.
CREATE TABLE IF NOT EXISTS active_roster (
  player_id   TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  deck_id     TEXT REFERENCES decks(id) ON DELETE SET NULL,
  checked_in  INTEGER NOT NULL DEFAULT 1,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_active_roster_deck ON active_roster (deck_id) WHERE deck_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pods (
  id         TEXT PRIMARY KEY,
  season_id  TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  round_num  INTEGER NOT NULL,
  pod_label  INTEGER NOT NULL,
  completed  INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One pod label per round per season: re-running generation for a round must not silently double it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pods_round_label ON pods (season_id, round_num, pod_label);
CREATE INDEX IF NOT EXISTS idx_pods_season_round ON pods (season_id, round_num);

CREATE TABLE IF NOT EXISTS pod_results (
  pod_id         TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  player_id      TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  deck_id        TEXT REFERENCES decks(id) ON DELETE SET NULL,
  kills          INTEGER NOT NULL DEFAULT 0 CHECK (kills >= 0),
  placed_first   INTEGER NOT NULL DEFAULT 0,
  placed_draw    INTEGER NOT NULL DEFAULT 0,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pod_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_pod_results_player ON pod_results (player_id);
CREATE INDEX IF NOT EXISTS idx_pod_results_deck ON pod_results (deck_id) WHERE deck_id IS NOT NULL;

-- Season rules the legacy handlers read and write but the baseline never created, so POST /api/seasons
-- and POST /api/seasons/rules both raise. `banlist` holds JSON as TEXT, consistent with the rest.
ALTER TABLE seasons ADD COLUMN IF NOT EXISTS budget_limit REAL;
ALTER TABLE seasons ADD COLUMN IF NOT EXISTS banlist      TEXT NOT NULL DEFAULT '[]';
ALTER TABLE seasons ADD COLUMN IF NOT EXISTS max_rares    INTEGER NOT NULL DEFAULT -1;
-- Exactly one active season at a time; legacy relied on remembering to clear the flag first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_seasons_single_active ON seasons ((is_active)) WHERE is_active = 1;

-- Standings are per season, but `player_stats` is keyed on player_id alone and `deck_stats` on deck_id,
-- so a second season would overwrite the first. Rather than change a primary key on a table that may
-- hold production rows, the PK is replaced by two partial unique indexes: one for season-tagged rows,
-- one for the untagged lifetime row that pre-0006 data already occupies. Nothing is rewritten.
ALTER TABLE player_stats DROP CONSTRAINT IF EXISTS player_stats_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_stats_season
  ON player_stats (player_id, season_id) WHERE season_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_stats_lifetime
  ON player_stats (player_id) WHERE season_id IS NULL;

ALTER TABLE deck_stats DROP CONSTRAINT IF EXISTS deck_stats_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_stats_season
  ON deck_stats (deck_id, season_id) WHERE season_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_stats_lifetime
  ON deck_stats (deck_id) WHERE season_id IS NULL;
