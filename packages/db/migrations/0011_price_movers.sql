-- `/api/movers` (the "Scroll Movers & Shakers" ticker) selects from `price_movers`, which the baseline
-- schema never created — so the endpoint raises. Same class as migrations 0005-0010.
--
-- The table is a materialised view of recent price change, refreshed by a job rather than written per
-- request. Nothing populates it yet: see TODO(price-mover-job) in apps/api/src/routes/misc.ts.
CREATE TABLE IF NOT EXISTS price_movers (
  id                SERIAL PRIMARY KEY,
  card_name         TEXT NOT NULL,
  scryfall_id       TEXT,
  previous_price    REAL NOT NULL,
  current_price     REAL NOT NULL,
  percentage_change REAL NOT NULL,
  image_uri         TEXT,
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per card per observation window; a refresh replaces rather than appends.
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_movers_card ON price_movers (LOWER(card_name));
-- The ticker orders by absolute swing, largest first.
CREATE INDEX IF NOT EXISTS idx_price_movers_swing ON price_movers (ABS(percentage_change) DESC);
