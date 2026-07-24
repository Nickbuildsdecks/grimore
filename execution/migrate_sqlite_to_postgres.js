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

  console.log("=== STARTING SQLITE TO POSTGRESQL MIGRATION ===");

  const dataDir = '/data';
  const dbPath = fs.existsSync(dataDir) 
    ? path.join(dataDir, 'grimore.db') 
    : path.join(__dirname, '../grimore.db');

  if (!fs.existsSync(dbPath)) {
    console.error(`❌ Source SQLite database not found at: ${dbPath}`);
    process.exit(1);
  }

  const sqliteDb = new sqlite3.Database(dbPath);
  const pgPool = new Pool({ connectionString: pgUrl });

  const getSqliteRows = (table) => new Promise((resolve, reject) => {
    sqliteDb.all(`SELECT * FROM ${table}`, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

  const tables = [
    'seasons',
    'players',
    'decks',
    'deck_stats',
    'deck_cards',
    'price_overrides',
    'scryfall_cards',
    'card_price_cache',
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
      const rows = await getSqliteRows(table);
      if (rows.length === 0) {
        console.log(`- Table '${table}': 0 rows (skipped).`);
        continue;
      }

      console.log(`- Migrating table '${table}': ${rows.length} row(s)...`);

      for (const row of rows) {
        const columns = Object.keys(row);
        const values = Object.values(row);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

        const sql = `
          INSERT INTO ${table} (${columns.join(', ')})
          VALUES (${placeholders})
          ON CONFLICT DO NOTHING
        `;

        await pgPool.query(sql, values);
      }
      console.log(`  ✓ Successfully migrated '${table}'.`);
    } catch (err) {
      console.error(`  ⚠️ Warning migrating '${table}': ${err.message}`);
    }
  }

  console.log("\n==================================================");
  console.log("=== MIGRATION COMPLETE: DATA SAVED TO POSTGRESQL ===");
  console.log("==================================================\n");

  await pgPool.end();
  sqliteDb.close();
}

migrateData().catch(console.error);
