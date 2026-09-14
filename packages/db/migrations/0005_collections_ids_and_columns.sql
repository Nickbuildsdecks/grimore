-- Makes the `collections` / `collection_cards` tables match what the application actually writes.
--
-- The baseline (a pg_dump of the legacy SQLite initDb()) gives `collections.id` an integer serial PK,
-- but every legacy handler inserts a TEXT id of the form `col_<ts>_<rand>` — so CREATE COLLECTION has
-- always failed on Postgres with "invalid input syntax for type integer". Several columns the handlers
-- read and write were likewise never created. This migration reconciles the schema with the code;
-- `packages/shared/src/contracts/collections.ts` documents the same divergence from the other side.
--
-- Converting the id to TEXT preserves existing rows: an integer id becomes its own decimal string, and
-- collection_cards.collection_id is converted in the same transaction so the foreign key still holds.

-- 1. id: integer serial -> text. The FK has to come off first and go back on after.
ALTER TABLE collection_cards DROP CONSTRAINT IF EXISTS collection_cards_collection_id_fkey;
ALTER TABLE collections ALTER COLUMN id DROP DEFAULT;
ALTER TABLE collections ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE collection_cards ALTER COLUMN collection_id TYPE TEXT USING collection_id::text;
ALTER TABLE collection_cards
  ADD CONSTRAINT collection_cards_collection_id_fkey
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE;
DROP SEQUENCE IF EXISTS collections_id_seq;

-- 2. Columns the legacy handlers read and write but the baseline never created.
--    `settings` holds JSON as TEXT, consistent with decks.custom_tags and scryfall_cards.colors.
ALTER TABLE collections      ADD COLUMN IF NOT EXISTS settings     TEXT    NOT NULL DEFAULT '{}';
ALTER TABLE collection_cards ADD COLUMN IF NOT EXISTS condition    TEXT    NOT NULL DEFAULT 'NM';
ALTER TABLE collection_cards ADD COLUMN IF NOT EXISTS language     TEXT    NOT NULL DEFAULT 'EN';
ALTER TABLE collection_cards ADD COLUMN IF NOT EXISTS is_for_trade INTEGER NOT NULL DEFAULT 0;

-- 3. The upsert key. `scryfall_id` is nullable and Postgres treats NULLs as distinct in a unique index,
--    so a NULL-id card could be inserted twice; COALESCE collapses that. LOWER(card_name) stops
--    "Sol Ring" and "sol ring" becoming two rows, matching how the rest of the app looks cards up.
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_cards_identity
  ON collection_cards (collection_id, LOWER(card_name), COALESCE(scryfall_id, ''), foil, condition, language);

CREATE INDEX IF NOT EXISTS idx_collections_player ON collections (player_id, created_at DESC);
