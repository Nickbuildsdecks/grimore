const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const pgUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
let isPostgres = false;
let pgPool = null;
let sqliteDb = null;

if (pgUrl) {
  isPostgres = true;
  pgPool = new Pool({
    connectionString: pgUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  console.log('Connected to Grimore PostgreSQL database pool.');
} else {
  // Check if persistent volume mount directory exists (Fly.io volume location)
  const dataDir = '/data';
  const dbPath = fs.existsSync(dataDir) 
    ? path.join(dataDir, 'grimore.db') 
    : path.join(__dirname, 'grimore.db');

  sqliteDb = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Error connecting to SQLite database:', err.message);
    } else {
      console.log('Connected to Grimore SQLite database.');
      sqliteDb.run("PRAGMA foreign_keys = ON;", (err) => {
        if (err) console.error("Failed to enable foreign keys:", err.message);
      });
    }
  });
}

// Convert SQLite '?' parameters to PostgreSQL '$1, $2, ...'
function convertSqlPlaceholders(sql) {
  let index = 1;
  return sql.replace(/\?/g, () => `$${index++}`);
}

// Helper for DB queries using Promises
const query = (sql, params = []) => {
  if (isPostgres) {
    const pgSql = convertSqlPlaceholders(sql);
    return pgPool.query(pgSql, params).then(res => res.rows);
  }
  return new Promise((resolve, reject) => {
    sqliteDb.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const run = (sql, params = []) => {
  if (isPostgres) {
    const pgSql = convertSqlPlaceholders(sql);
    return pgPool.query(pgSql, params).then(res => ({
      id: res.rows && res.rows[0] ? res.rows[0].id : null,
      changes: res.rowCount
    }));
  }
  return new Promise((resolve, reject) => {
    sqliteDb.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

const get = (sql, params = []) => {
  if (isPostgres) {
    const pgSql = convertSqlPlaceholders(sql);
    return pgPool.query(pgSql, params).then(res => res.rows[0] || null);
  }
  return new Promise((resolve, reject) => {
    sqliteDb.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// Initialize Tables
async function initDb() {
  if (isPostgres) {
    // Postgres DDL Initialization
    await query(`
      CREATE TABLE IF NOT EXISTS seasons (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        points_entry INTEGER DEFAULT 1,
        points_kill INTEGER DEFAULT 1,
        points_win INTEGER DEFAULT 2,
        points_draw INTEGER DEFAULT 1,
        remainder_pref TEXT DEFAULT '3',
        use_point_pairing INTEGER DEFAULT 1,
        checkin_enabled INTEGER DEFAULT 1,
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        store_nickname TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        email TEXT DEFAULT NULL,
        google_id TEXT UNIQUE DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS decks (
        id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES players(id),
        moxfield_url TEXT UNIQUE NOT NULL,
        deck_name TEXT NOT NULL,
        cheapest_total_price REAL DEFAULT 0,
        last_checked TIMESTAMP,
        is_legal INTEGER DEFAULT 1,
        keep_cheapest INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS deck_stats (
        deck_id TEXT PRIMARY KEY REFERENCES decks(id),
        total_wins INTEGER DEFAULT 0,
        total_kills INTEGER DEFAULT 0,
        total_points INTEGER DEFAULT 0,
        games_played INTEGER DEFAULT 0,
        win_rate REAL DEFAULT 0.0
      );
      CREATE TABLE IF NOT EXISTS deck_cards (
        id SERIAL PRIMARY KEY,
        deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        card_name TEXT NOT NULL,
        quantity INTEGER DEFAULT 1,
        purchase_price REAL DEFAULT 0.0,
        cheapest_price REAL DEFAULT 0.0,
        set_code TEXT,
        collector_number TEXT,
        is_commander INTEGER DEFAULT 0,
        is_partner INTEGER DEFAULT 0,
        scryfall_id TEXT,
        manual_target_price REAL DEFAULT NULL,
        keep_cheapest INTEGER DEFAULT 0,
        mana_cost TEXT,
        cmc REAL DEFAULT 0,
        type_line TEXT,
        rarity TEXT,
        image_uris TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS price_overrides (
        id SERIAL PRIMARY KEY,
        card_name TEXT UNIQUE NOT NULL,
        price REAL NOT NULL,
        notes TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS scryfall_cards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        set_code TEXT NOT NULL,
        set_name TEXT,
        collector_number TEXT NOT NULL,
        rarity TEXT,
        price REAL,
        foil_price REAL,
        image_uri TEXT,
        scryfall_uri TEXT,
        type_line TEXT,
        mana_cost TEXT,
        cmc REAL,
        oracle_text TEXT,
        colors TEXT,
        color_identity TEXT,
        legalities TEXT,
        edhrec_rank INTEGER,
        keywords TEXT,
        card_faces TEXT,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS card_price_cache (
        id SERIAL PRIMARY KEY,
        scryfall_id TEXT UNIQUE NOT NULL,
        card_name TEXT NOT NULL,
        set_code TEXT NOT NULL,
        collector_number TEXT NOT NULL,
        price REAL NOT NULL,
        foil_price REAL,
        image_uri TEXT,
        scryfall_uri TEXT,
        type_line TEXT,
        mana_cost TEXT,
        cmc REAL,
        rarity TEXT,
        cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS tournaments (
        id TEXT PRIMARY KEY,
        season_id TEXT REFERENCES seasons(id),
        name TEXT NOT NULL,
        date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        format TEXT DEFAULT 'commander',
        status TEXT DEFAULT 'setup',
        current_round INTEGER DEFAULT 0,
        pairing_strategy TEXT DEFAULT 'swiss',
        deck_lock INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS tournament_players (
        tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        deck_id TEXT REFERENCES decks(id),
        registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_checked_in INTEGER DEFAULT 0,
        dropped INTEGER DEFAULT 0,
        score INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        draws INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        kills INTEGER DEFAULT 0,
        PRIMARY KEY (tournament_id, player_id)
      );
      CREATE TABLE IF NOT EXISTS tournament_rounds (
        id SERIAL PRIMARY KEY,
        tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        round_number INTEGER NOT NULL,
        status TEXT DEFAULT 'in_progress',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        round_number INTEGER NOT NULL,
        pod_number INTEGER NOT NULL,
        player1_id TEXT REFERENCES players(id),
        player2_id TEXT REFERENCES players(id),
        player3_id TEXT REFERENCES players(id),
        player4_id TEXT REFERENCES players(id),
        winner_id TEXT REFERENCES players(id),
        is_draw INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        scores_submitted INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS match_reports (
        id SERIAL PRIMARY KEY,
        match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        reporter_id TEXT NOT NULL REFERENCES players(id),
        winner_id TEXT REFERENCES players(id),
        kills_json TEXT,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (match_id, reporter_id)
      );
      CREATE TABLE IF NOT EXISTS player_collection (
        id SERIAL PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        card_name TEXT NOT NULL,
        quantity INTEGER DEFAULT 1,
        set_code TEXT,
        collector_number TEXT,
        scryfall_id TEXT,
        foil INTEGER DEFAULT 0,
        purchase_price REAL DEFAULT 0.0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (player_id, card_name, set_code, collector_number, foil)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender_id TEXT REFERENCES players(id),
        recipient_id TEXT REFERENCES players(id),
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("PostgreSQL database tables initialized successfully.");
    return;
  }

  // SQLite DDL Initialization
  await run(`
    CREATE TABLE IF NOT EXISTS seasons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      points_entry INTEGER DEFAULT 1,
      points_kill INTEGER DEFAULT 1,
      points_win INTEGER DEFAULT 2,
      points_draw INTEGER DEFAULT 1,
      remainder_pref TEXT DEFAULT '3',
      use_point_pairing INTEGER DEFAULT 1,
      checkin_enabled INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      store_nickname TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      email TEXT DEFAULT NULL,
      google_id TEXT UNIQUE DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try {
    await run("ALTER TABLE players ADD COLUMN google_id TEXT");
  } catch (e) {
    // Column already exists
  }

  await run(`
    CREATE TABLE IF NOT EXISTS decks (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      moxfield_url TEXT UNIQUE NOT NULL,
      deck_name TEXT NOT NULL,
      cheapest_total_price REAL DEFAULT 0,
      last_checked DATETIME,
      is_legal INTEGER DEFAULT 1,
      keep_cheapest INTEGER DEFAULT 0,
      FOREIGN KEY(player_id) REFERENCES players(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS deck_stats (
      deck_id TEXT PRIMARY KEY,
      total_wins INTEGER DEFAULT 0,
      total_kills INTEGER DEFAULT 0,
      total_points INTEGER DEFAULT 0,
      games_played INTEGER DEFAULT 0,
      win_rate REAL DEFAULT 0.0,
      FOREIGN KEY(deck_id) REFERENCES decks(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS deck_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deck_id TEXT NOT NULL,
      card_name TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      purchase_price REAL DEFAULT 0.0,
      cheapest_price REAL DEFAULT 0.0,
      set_code TEXT,
      collector_number TEXT,
      is_commander INTEGER DEFAULT 0,
      is_partner INTEGER DEFAULT 0,
      scryfall_id TEXT,
      manual_target_price REAL DEFAULT NULL,
      keep_cheapest INTEGER DEFAULT 0,
      mana_cost TEXT,
      cmc REAL DEFAULT 0,
      type_line TEXT,
      rarity TEXT,
      image_uris TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS price_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_name TEXT UNIQUE NOT NULL,
      price REAL NOT NULL,
      notes TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS scryfall_cards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      set_code TEXT NOT NULL,
      set_name TEXT,
      collector_number TEXT NOT NULL,
      rarity TEXT,
      price REAL,
      foil_price REAL,
      image_uri TEXT,
      scryfall_uri TEXT,
      type_line TEXT,
      mana_cost TEXT,
      cmc REAL,
      oracle_text TEXT,
      colors TEXT,
      color_identity TEXT,
      legalities TEXT,
      edhrec_rank INTEGER,
      keywords TEXT,
      card_faces TEXT,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS card_price_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scryfall_id TEXT UNIQUE NOT NULL,
      card_name TEXT NOT NULL,
      set_code TEXT NOT NULL,
      collector_number TEXT NOT NULL,
      price REAL NOT NULL,
      foil_price REAL,
      image_uri TEXT,
      scryfall_uri TEXT,
      type_line TEXT,
      mana_cost TEXT,
      cmc REAL,
      rarity TEXT,
      cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id TEXT PRIMARY KEY,
      season_id TEXT,
      name TEXT NOT NULL,
      date DATETIME DEFAULT CURRENT_TIMESTAMP,
      format TEXT DEFAULT 'commander',
      status TEXT DEFAULT 'setup',
      current_round INTEGER DEFAULT 0,
      pairing_strategy TEXT DEFAULT 'swiss',
      deck_lock INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(season_id) REFERENCES seasons(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS tournament_players (
      tournament_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      deck_id TEXT,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_checked_in INTEGER DEFAULT 0,
      dropped INTEGER DEFAULT 0,
      score INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      draws INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      kills INTEGER DEFAULT 0,
      PRIMARY KEY (tournament_id, player_id),
      FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
      FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
      FOREIGN KEY(deck_id) REFERENCES decks(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS tournament_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      status TEXT DEFAULT 'in_progress',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      tournament_id TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      pod_number INTEGER NOT NULL,
      player1_id TEXT,
      player2_id TEXT,
      player3_id TEXT,
      player4_id TEXT,
      winner_id TEXT,
      is_draw INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      scores_submitted INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
      FOREIGN KEY(player1_id) REFERENCES players(id),
      FOREIGN KEY(player2_id) REFERENCES players(id),
      FOREIGN KEY(player3_id) REFERENCES players(id),
      FOREIGN KEY(player4_id) REFERENCES players(id),
      FOREIGN KEY(winner_id) REFERENCES players(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS match_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT NOT NULL,
      reporter_id TEXT NOT NULL,
      winner_id TEXT,
      kills_json TEXT,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE,
      FOREIGN KEY(reporter_id) REFERENCES players(id),
      FOREIGN KEY(winner_id) REFERENCES players(id),
      UNIQUE (match_id, reporter_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS player_collection (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL,
      card_name TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      set_code TEXT,
      collector_number TEXT,
      scryfall_id TEXT,
      foil INTEGER DEFAULT 0,
      purchase_price REAL DEFAULT 0.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE,
      UNIQUE (player_id, card_name, set_code, collector_number, foil)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT,
      recipient_id TEXT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(sender_id) REFERENCES players(id),
      FOREIGN KEY(recipient_id) REFERENCES players(id)
    )
  `);

  // Performance Indexes
  await run(`CREATE INDEX IF NOT EXISTS idx_deck_cards_deck_id ON deck_cards(deck_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_deck_cards_card_name ON deck_cards(card_name);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_scryfall_cards_name ON scryfall_cards(name);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_player_collection_player ON player_collection(player_id);`);

  console.log("SQLite database initialized successfully.");
}

module.exports = {
  db: isPostgres ? pgPool : sqliteDb,
  query,
  run,
  get,
  initDb,
  isPostgres
};
