-- `wishlist_cards` is queried by all three /api/wishlist routes and by the collections card-add
-- handler, but the baseline schema never created it — so the wishlist feature raises on Postgres,
-- the same class of divergence as migrations 0005-0007.
CREATE TABLE IF NOT EXISTS wishlist_cards (
  id          SERIAL PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  card_name   TEXT NOT NULL,
  scryfall_id TEXT,
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The upsert key. Postgres treats NULLs as distinct in a plain unique index, so a card with no
-- printing id could otherwise be wished for twice; LOWER(card_name) matches how the rest of the app
-- looks cards up, and stops "Sol Ring" and "sol ring" becoming two rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_identity
  ON wishlist_cards (player_id, LOWER(card_name), COALESCE(scryfall_id, ''));
CREATE INDEX IF NOT EXISTS idx_wishlist_player ON wishlist_cards (player_id, card_name);
