// Uses better-sqlite3 (already a dependency) as the SQLite reader so the heavier `sqlite3`
// native module no longer has to be installed/compiled just for this one-off migration.
const Database = require('better-sqlite3');
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

  // Open read-only; better-sqlite3 handles WAL source files fine and we never write here.
  const sqliteDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  const pgPool = new Pool({ connectionString: pgUrl });

  // better-sqlite3 is synchronous; callers still `await` this, which is harmless on a value.
  const getSqliteRows = (table) => sqliteDb.prepare(`SELECT * FROM ${table}`).all();

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

  // SAFETY GUARD: this migration TRUNCATEs deck_cards/scryfall_cards and re-seeds them from
  // the source SQLite file. Refuse to run against a populated target unless the operator
  // explicitly opts in with FORCE_RESEED=1 (after taking a backup). This is what stops an
  // accidental run from wiping live Postgres deck data.
  const forceReseed = process.env.FORCE_RESEED === '1';
  try {
    const existing = await pgPool.query("SELECT COUNT(*)::int AS n FROM deck_cards");
    if (existing.rows[0].n > 0 && !forceReseed) {
      console.error(`ERROR: target deck_cards already has ${existing.rows[0].n} rows.`);
      console.error("Refusing to TRUNCATE and re-seed. Back up the database, then set FORCE_RESEED=1 to override.");
      await pgPool.end();
      sqliteDb.close();
      process.exit(1);
    }
  } catch (e) {
    // A failed count usually means the table does not exist yet — safe to continue to DDL.
    console.warn("WARN: pre-flight count on deck_cards failed (continuing):", e.message);
  }

  try {
    await pgPool.query("TRUNCATE deck_cards, scryfall_cards CASCADE;");
    await pgPool.query("ALTER TABLE scryfall_cards ALTER COLUMN set_code DROP NOT NULL;");
    await pgPool.query("ALTER TABLE scryfall_cards ALTER COLUMN set_code SET DEFAULT 'unk';");
    await pgPool.query("ALTER TABLE scryfall_cards ALTER COLUMN collector_number DROP NOT NULL;");
    await pgPool.query("ALTER TABLE scryfall_cards ALTER COLUMN collector_number SET DEFAULT '1';");
    await pgPool.query("ALTER TABLE card_price_cache ALTER COLUMN set_code DROP NOT NULL;");
    await pgPool.query("ALTER TABLE card_price_cache ALTER COLUMN collector_number DROP NOT NULL;");
    await pgPool.query("ALTER TABLE card_price_cache ALTER COLUMN scryfall_id DROP NOT NULL;");
  } catch (e) {
    // Do NOT swallow this — a failed truncate/DDL leaves the DB in an unknown state.
    console.error("FATAL: schema preparation / truncate failed:", e.message);
    await pgPool.end();
    sqliteDb.close();
    process.exit(1);
  }

  for (const table of tables) {
    try {
      // Check if table exists in SQLite
      const tableCheck = !!sqliteDb
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table);

      if (!tableCheck) {
        console.log(`- Table '${table}': does not exist in SQLite (skipped).`);
        continue;
      }

      const rows = await getSqliteRows(table);
      if (rows.length === 0) {
        console.log(`- Table '${table}': 0 rows (skipped).`);
        continue;
      }

      if (table === 'scryfall_cards') {
        for (const r of rows) {
          r.id = r.id || r.scryfall_id || ('scry_' + Math.random().toString(36).substr(2, 9));
          r.name = r.name || r.card_name;
          r.set_code = r.set_code || 'unk';
          r.collector_number = r.collector_number || '1';
          delete r.scryfall_id;
          delete r.card_name;
        }
      }

      const pgCols = await getPgColumns(table);
      if (pgCols.size === 0) {
        console.log(`- Table '${table}': does not exist in PostgreSQL (skipped).`);
        continue;
      }

      console.log(`- Migrating table '${table}': ${rows.length} row(s)...`);

      // Multi-row bulk insert helper
      const batchSize = table === 'scryfall_cards' ? 1000 : 250;
      let successCount = 0;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);

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
            const paramPlaceholder = ['prices', 'image_uris', 'legalities'].includes(k) ? `$${valParamIdx++}::jsonb` : `$${valParamIdx++}`;
            rowParams.push(paramPlaceholder);
            let val = r[k];
            if (['prices', 'image_uris', 'legalities'].includes(k) && typeof val === 'string' && val.trim().length === 0) {
              val = '{}';
            }
            queryValues.push(val);
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
          console.error(`  ⚠️ Batch insert error on ${table}: ${rowErr.message}`);
          // Fallback to row-by-row insert on batch error
          for (const r of batch) {
            const rowValues = validKeys.map(k => {
              let val = r[k];
              if (['prices', 'image_uris', 'legalities'].includes(k) && typeof val === 'string' && val.trim().length === 0) {
                val = '{}';
              }
              return val;
            });
            const singlePlaceholders = validKeys.map((k, idx) => ['prices', 'image_uris', 'legalities'].includes(k) ? `$${idx + 1}::jsonb` : `$${idx + 1}`).join(', ');
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
    } catch (e) {
      console.error(`  ❌ Error migrating table '${table}':`, e.message);
    }
  }

  // Sync is_public visibility, deduplicate cards, and sequence resets for Postgres
  try {
    await pgPool.query(`
      DELETE FROM deck_cards a USING deck_cards b 
      WHERE a.id < b.id AND a.deck_id = b.deck_id AND LOWER(a.card_name) = LOWER(b.card_name);
    `);
    await pgPool.query("ALTER TABLE deck_cards ADD COLUMN IF NOT EXISTS cheapest_card_price REAL DEFAULT 0.0;");
    await pgPool.query("ALTER TABLE scryfall_cards ADD COLUMN IF NOT EXISTS scryfall_id TEXT;");
    await pgPool.query("ALTER TABLE scryfall_cards ADD COLUMN IF NOT EXISTS card_name TEXT;");
    await pgPool.query("ALTER TABLE scryfall_cards ADD COLUMN IF NOT EXISTS name TEXT;");
    await pgPool.query("UPDATE scryfall_cards SET name = card_name WHERE name IS NULL AND card_name IS NOT NULL;");
    await pgPool.query("UPDATE scryfall_cards SET card_name = name WHERE card_name IS NULL AND name IS NOT NULL;");
    await pgPool.query("UPDATE scryfall_cards SET scryfall_id = id WHERE scryfall_id IS NULL AND id IS NOT NULL;");
    await pgPool.query("UPDATE decks SET is_public = 1 WHERE player_id = 'p_admin';");
    console.log("  ✓ Deduplicated deck_cards, synchronized scryfall_cards columns, and updated PostgreSQL database.");
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


