-- `card_price_cache` has no unique key, so the legacy `INSERT OR REPLACE` that feeds it has nothing
-- to upsert against. That statement is SQLite-only and raises on Postgres, which is why the price
-- cache has never been written by the legacy app on the dialect it ships on.
--
-- Two things the table's shape suggests but the code does not do. It carries `scryfall_id`,
-- `set_code` and `collector_number`, which look like a per-printing cache — but nothing has ever
-- written a meaningful set code or collector number into it, and `execution/migrate_sqlite_to_postgres.js`
-- explicitly drops their NOT NULL constraints, so the rows carried over from SQLite have them NULL.
-- Every reader joins on `LOWER(pc.card_name)` alone. The cache is per-name in practice, and the
-- SQLite table it was migrated from keys on `card_name` outright.
--
-- So the key is LOWER(card_name). Deduplicate first, then add the index -- in that order, in the one
-- transaction the migrator wraps this in, because the index cannot be created while duplicates exist
-- and a half-applied state would leave the upsert with no target.
--
-- Duplicates are known to be present, not hypothetical: legacy's readers fan out result rows when a
-- name has more than one cache row, which is how the condition was originally found.

-- Newest row wins. `cached_at` is the intended recency column; `id` breaks ties for rows inserted in
-- the same statement, and DESC on both means the row a reader would most likely have surfaced is the
-- one kept.
DELETE FROM card_price_cache
 WHERE id IN (
   SELECT id FROM (
     SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY LOWER(card_name)
              ORDER BY cached_at DESC NULLS LAST, id DESC
            ) AS rn
       FROM card_price_cache
   ) ranked
   WHERE rn > 1
 );

-- Matches the expression every reader joins on, so it serves those lookups as well as constraining
-- writes. Replaces the non-unique index of the same shape created by `db.js`/0002, which this makes
-- redundant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_card_price_cache_name_unique
  ON card_price_cache (LOWER(card_name));
DROP INDEX IF EXISTS idx_card_price_cache_lower_card_name;
