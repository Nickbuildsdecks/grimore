-- Support for the v2 cards slice (apps/api/src/routes/cards.ts).
--
-- `scryfall_cards.colors` / `color_identity` / `legalities` / `keywords` / `card_faces` are TEXT columns
-- holding JSON. Casting them with `::jsonb` inline is unsafe: a single malformed row aborts the whole
-- query, and Postgres is free to evaluate the cast before the WHERE clause that would have excluded it.
-- try_jsonb() returns NULL instead of raising, so one bad row degrades to "no colors" rather than a 500.
CREATE OR REPLACE FUNCTION public.try_jsonb(t text) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE STRICT AS $fn$
BEGIN
  RETURN t::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$fn$;

-- Card search is a substring match (`ILIKE '%q%'`), which no btree index can serve. pg_trgm can.
-- CREATE EXTENSION needs privileges the production app role may not have, so failure to install it
-- is caught and ignored: search still works, it just falls back to a sequential scan.
DO $do$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS idx_scryfall_cards_name_trgm ON scryfall_cards USING gin (name gin_trgm_ops);
EXCEPTION WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
  RAISE NOTICE 'pg_trgm unavailable; card search will sequential-scan scryfall_cards';
END;
$do$;

-- card_price_cache is looked up by name on every card read (the COALESCE(pc.price, sc.price, 0.15) standard).
CREATE INDEX IF NOT EXISTS idx_card_price_cache_name_lower ON card_price_cache (LOWER(card_name));
