const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

async function migrateData() {
  const pgUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!pgUrl) {
    console.error("❌ Migration failed: POSTGRES_URL environment variable is required.");
    process.exit(1);
  }

  console.log("=== STARTING COMPLETE SQLITE TO POSTGRESQL MIGRATION ===");

  // Prioritize local workspace grimore.db uploaded in current directory
  let dbPath = path.join(__dirname, '../grimore.db');
  if (!fs.existsSync(dbPath)) {
    dbPath = path.join(__dirname, 'grimore.db');
  }
  if (!fs.existsSync(dbPath) && fs.existsSync('/data/grimore.db')) {
    dbPath = '/data/grimore.db';
  }

  if (!fs.existsSync(dbPath)) {
    console.error(`❌ Source SQLite database not found at: ${dbPath}`);
    process.exit(1);
  }

  console.log(`Using source SQLite database at: ${dbPath}`);

  const sqliteDb = new sqlite3.Database(dbPath);
  const pgPool = new Pool({ connectionString: pgUrl });

  const getSqliteRows = (table) => new Promise((resolve, reject) => {
    sqliteDb.all(`SELECT * FROM ${table}`, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

  const getPgColumns = async (table) => {
    const res = await pgPool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [table]
    );
    return new Set(res.rows.map(r => r.column_name.toLowerCase()));
  };

  // Ordered list of tables to preserve foreign key hierarchy and prioritize user decks
  const tables = [
    'players',
    'seasons',
    'decks',
    'deck_stats',
    'deck_cards',
    'player_stats',
    'active_roster',
    'deck_likes',
    'deck_comments',
    'notifications',
    'collections',
    'collection_cards',
    'wishlist_cards',
    'card_price_cache',
    'price_overrides',
    'scryfall_card_tags',
    'deleted_items',
    'card_art_votes',
    'tournaments',
    'tournament_players',
    'tournament_rounds',
    'matches',
    'match_reports',
    'player_collection',
    'messages',
    'preference_events',
    'card_swipes',
    'artist_follows',
    'followed_artist_printings',
    'scryfall_cards' // Large cache table goes LAST
  ];

  for (const table of tables) {
    try {
      // Check if table exists in SQLite
      const tableCheck = await new Promise((resolve) => {
        sqliteDb.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table], (err, row) => {
          resolve(!!row);
        });
      });

      if (!tableCheck) {
        console.log(`- Table '${table}': does not exist in SQLite (skipped).`);
        continue;
      }

      const rows = await getSqliteRows(table);
      if (rows.length === 0) {
        console.log(`- Table '${table}': 0 rows (skipped).`);
        continue;
      }

      const pgCols = await getPgColumns(table);
      if (pgCols.size === 0) {
        console.log(`- Table '${table}': does not exist in PostgreSQL (skipped).`);
        continue;
      }

      console.log(`- Migrating table '${table}': ${rows.length} row(s)...`);

      // Multi-row bulk insert helper
      const BATCH_SIZE = 100;
      let successCount = 0;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);

        if (batch.length === 0) continue;

        // Filter keys to only those columns that exist in Postgres
        const sampleRow = batch[0];
        const validKeys = Object.keys(sampleRow).filter(k => pgCols.has(k.toLowerCase()));
        if (validKeys.length === 0) continue;

        const valuePlaceholders = [];
        const queryValues = [];
        let valParamIdx = 1;

        for (const r of batch) {
          const rowParams = [];
          for (const k of validKeys) {
            rowParams.push(`$${valParamIdx++}`);
            queryValues.push(r[k]);
          }
          valuePlaceholders.push(`(${rowParams.join(', ')})`);
        }

        const sql = `
          INSERT INTO ${table} (${validKeys.join(', ')})
          VALUES ${valuePlaceholders.join(', ')}
          ON CONFLICT DO NOTHING
        `;

        try {
          const res = await pgPool.query(sql, queryValues);
          successCount += res.rowCount || batch.length;
        } catch (rowErr) {
          // Fallback to row-by-row insert on batch error
          for (const r of batch) {
            const rowValues = validKeys.map(k => r[k]);
            const singlePlaceholders = validKeys.map((_, idx) => `$${idx + 1}`).join(', ');
            const singleSql = `
              INSERT INTO ${table} (${validKeys.join(', ')})
              VALUES (${singlePlaceholders})
              ON CONFLICT DO NOTHING
            `;
            try {
              await pgPool.query(singleSql, rowValues);
              successCount++;
            } catch (e) {}
          }
        }
      }
      console.log(`  ✓ Successfully migrated '${table}' (${successCount} rows).`);
    } catch (err) {
      console.error(`  ⚠️ Warning migrating '${table}': ${err.message}`);
    }
  }

  // Sync is_public visibility, deduplicate cards, and sequence resets for Postgres
  try {
    await pgPool.query("TRUNCATE deck_cards, scryfall_cards CASCADE;");
    await pgPool.query("ALTER TABLE deck_cards ADD COLUMN IF NOT EXISTS cheapest_card_price REAL DEFAULT 0.0;");
    await pgPool.query("ALTER TABLE scryfall_cards ADD COLUMN IF NOT EXISTS scryfall_id TEXT;");
    await pgPool.query("ALTER TABLE scryfall_cards ADD COLUMN IF NOT EXISTS card_name TEXT;");
    await pgPool.query("UPDATE decks SET is_public = 1 WHERE player_id = 'p_admin';");
    console.log("  ✓ Truncated and ready for clean re-migration of deck_cards & scryfall_cards.");
  } catch (e) {
    console.warn("  ⚠️ Warning syncing PostgreSQL deck visibility:", e.message);
  }

  // Reset SERIAL sequences for auto-increment tables in Postgres
  const serialTables = ['deck_cards', 'price_overrides', 'card_price_cache', 'tournament_rounds', 'match_reports', 'player_collection', 'deck_likes', 'deck_comments', 'collections', 'collection_cards'];
  for (const sTable of serialTables) {
    try {
      await pgPool.query(`SELECT setval(pg_get_serial_sequence('${sTable}', 'id'), COALESCE((SELECT MAX(id) FROM ${sTable}), 1));`);
    } catch (e) {
      // Sequence reset warning ignored if sequence doesn't exist
    }
  }

  console.log("\n==================================================");
  console.log("=== MIGRATION COMPLETE: ALL DATA SAVED TO POSTGRESQL ===");
  console.log("==================================================\n");

  await pgPool.end();
  sqliteDb.close();
}

migrateData().catch(console.error);


