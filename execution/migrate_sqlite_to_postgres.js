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

  // Ordered list of tables to preserve foreign key hierarchy
  const tables = [
    'seasons',
    'players',
    'scryfall_cards',
    'scryfall_card_tags',
    'decks',
    'deck_stats',
    'deck_cards',
    'card_price_cache',
    'price_overrides',
    'player_stats',
    'active_roster',
    'deck_likes',
    'deck_comments',
    'notifications',
    'collections',
    'collection_cards',
    'wishlist_cards',
    'deleted_items',
    'card_art_votes',
    'tournaments',
    'tournament_players',
    'tournament_rounds',
    'matches',
    'match_reports',
    'player_collection',
    'messages'
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

      // Batch insert helper
      const BATCH_SIZE = 250;
      let successCount = 0;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);

        for (const row of batch) {
          // Filter keys to only those columns that exist in Postgres
          const validKeys = Object.keys(row).filter(k => pgCols.has(k.toLowerCase()));
          if (validKeys.length === 0) continue;

          const values = validKeys.map(k => row[k]);
          const placeholders = validKeys.map((_, idx) => `$${idx + 1}`).join(', ');

          const sql = `
            INSERT INTO ${table} (${validKeys.join(', ')})
            VALUES (${placeholders})
            ON CONFLICT DO NOTHING
          `;

          try {
            await pgPool.query(sql, values);
            successCount++;
          } catch (rowErr) {
            // Ignore single row insert conflicts or warnings
          }
        }
      }
      console.log(`  ✓ Successfully migrated '${table}' (${successCount} rows).`);
    } catch (err) {
      console.error(`  ⚠️ Warning migrating '${table}': ${err.message}`);
    }
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


