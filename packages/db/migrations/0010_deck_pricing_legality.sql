-- Columns the deck repricing and legality handlers read and write, which the baseline never created.
--
--  * `decks.include_basic_lands_in_price` is written by reprice-init and read by reload-cheapest to
--    decide whether basic lands count toward a deck's price.
--  * `decks.budget_limit` is read by validateDeckLegality as the per-deck budget when no season is
--    active.
--  * `seasons.allowed_rarities` / `allowed_colors` are read by validateDeckLegality; without them the
--    legality check raises, which it does on every reprice-finalize and reload-cheapest.
--
-- Both `allowed_*` columns hold JSON as TEXT, consistent with seasons.banlist (migration 0009).
ALTER TABLE decks   ADD COLUMN IF NOT EXISTS include_basic_lands_in_price INTEGER NOT NULL DEFAULT 0;
ALTER TABLE decks   ADD COLUMN IF NOT EXISTS budget_limit      REAL;
ALTER TABLE seasons ADD COLUMN IF NOT EXISTS allowed_rarities  TEXT NOT NULL DEFAULT '["common","uncommon","rare","mythic"]';
ALTER TABLE seasons ADD COLUMN IF NOT EXISTS allowed_colors    TEXT NOT NULL DEFAULT '["W","U","B","R","G","C"]';

-- Repricing looks every card in a deck up by name against the card tables.
CREATE INDEX IF NOT EXISTS idx_deck_cards_name_lower ON deck_cards (deck_id, LOWER(card_name));
