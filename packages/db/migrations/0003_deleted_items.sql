-- deleted_items (soft-delete recycle bin) existed only in the legacy SQLite branch of db.js;
-- the Postgres branch never created it, so legacy DELETE /api/decks/:id would fail on Postgres.
CREATE TABLE IF NOT EXISTS deleted_items (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deleted_items_player ON deleted_items (player_id, deleted_at DESC);
