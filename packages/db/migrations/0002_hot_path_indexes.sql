-- Hot-path indexes identified in the 2026-08-11 audit (N+1 / seq-scan findings).
-- All IF NOT EXISTS; safe to run against a live legacy database.
CREATE INDEX IF NOT EXISTS idx_players_username_lower ON players (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_players_email_lower ON players (LOWER(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decks_player ON decks (player_id);
-- decks had no timestamps in the legacy schema; additive with defaults (legacy inserts keep working).
ALTER TABLE decks ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE decks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_decks_public_updated ON decks (is_public, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_deck_cards_deck ON deck_cards (deck_id);
CREATE INDEX IF NOT EXISTS idx_deck_likes_deck ON deck_likes (deck_id);
CREATE INDEX IF NOT EXISTS idx_deck_comments_deck ON deck_comments (deck_id);
CREATE INDEX IF NOT EXISTS idx_notifications_player_unread ON notifications (player_id, is_read);
CREATE INDEX IF NOT EXISTS idx_scryfall_cards_name_lower ON scryfall_cards (LOWER(name));
CREATE INDEX IF NOT EXISTS idx_collection_cards_collection ON collection_cards (collection_id);
