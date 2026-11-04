-- The card fields a rules engine needs, which the baseline never created.
--
-- `scryfall_cards` already carries `color_identity`, `legalities`, `keywords`, `card_faces` and
-- `edhrec_rank` (baseline), and the bulk importer has never written any of them — see the widened
-- statement in `scryfallService.js`. These six are the ones with no column at all, and each is
-- something `packages/rules-engine` cannot do without:
--
--  * `power` / `toughness` are TEXT, not numbers. A creature can be `*`, `1+*` or `?`, and a
--    column that cannot hold those would drop exactly the cards whose size is a rule.
--  * `loyalty` is TEXT for the same reason: planeswalkers printed with `X` exist.
--  * `layout` separates the multi-face kinds the engine already supports — `split`, `adventure`,
--    `modal_dfc`, `transform`, `flip` — from each other and from a plain card. The importer has
--    always read it (to exclude tokens and art series) and then discarded it.
--  * `oracle_id` is the card's identity *across* printings. This table's primary key is `id`, a
--    printing id, so there has been no stable way to say "this card" — which is what a decklist
--    naming a card means, and what a script attaches to.
--  * `produced_mana` is which colours a source can make. Without it every land and every rock
--    needs a hand-written script to be a mana source at all.
--
-- JSON goes in TEXT columns, consistent with `colors` / `legalities` / `keywords` / `card_faces`
-- and with migration 0004's `try_jsonb()` note: a malformed row degrades to NULL rather than
-- aborting the query that touched it.
ALTER TABLE scryfall_cards ADD COLUMN IF NOT EXISTS power         TEXT;
ALTER TABLE scryfall_cards ADD COLUMN IF NOT EXISTS toughness     TEXT;
ALTER TABLE scryfall_cards ADD COLUMN IF NOT EXISTS loyalty       TEXT;
ALTER TABLE scryfall_cards ADD COLUMN IF NOT EXISTS layout        TEXT;
ALTER TABLE scryfall_cards ADD COLUMN IF NOT EXISTS oracle_id     TEXT;
ALTER TABLE scryfall_cards ADD COLUMN IF NOT EXISTS produced_mana TEXT;

-- Not unique. Scryfall's `oracle_cards` bulk file holds one row per oracle id, but this table is
-- keyed by printing and has been written by other paths over the years; a unique index here would
-- make the migration itself fail on existing data rather than on anything a card sync does.
CREATE INDEX IF NOT EXISTS idx_scryfall_cards_oracle_id ON scryfall_cards (oracle_id);
