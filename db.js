const Database = require('better-sqlite3');
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
    max: 35,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    allowExitOnIdle: false
  });
  pgPool.on('error', (err) => {
    console.error('Unexpected error on idle PostgreSQL pool client:', err.message);
  });
  console.log('Connected to Grimore PostgreSQL database pool (max 35 connections).');
} else {
  // Check if persistent volume mount directory exists (Fly.io volume location)
  const dataDir = '/data';
  const dbPath = fs.existsSync(dataDir) 
    ? path.join(dataDir, 'grimore.db') 
    : path.join(__dirname, 'grimore.db');

  try {
    sqliteDb = new Database(dbPath);
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');
    sqliteDb.pragma('synchronous = NORMAL');
    console.log('Connected to Grimore SQLite database via better-sqlite3 (WAL Mode).');
  } catch (err) {
    // Fail fast: a null sqliteDb would make every subsequent query throw a confusing
    // "Cannot read properties of null" 500. Better to crash at boot so the operator sees it.
    console.error('FATAL: cannot open SQLite database:', err.message);
    process.exit(1);
  }
}

// Graceful shutdown: checkpoint the WAL and close the DB so we don't leave a large,
// un-checkpointed -wal file (and a possibly-inconsistent snapshot) on restart/redeploy.
function closeDbAndExit(signal) {
  try {
    if (sqliteDb) {
      sqliteDb.pragma('wal_checkpoint(TRUNCATE)');
      sqliteDb.close();
      console.log(`[shutdown] SQLite checkpointed and closed on ${signal}.`);
    }
  } catch (e) {
    console.error('[shutdown] error closing SQLite:', e.message);
  }
  process.exit(0);
}
process.on('SIGTERM', () => closeDbAndExit('SIGTERM'));
process.on('SIGINT', () => closeDbAndExit('SIGINT'));

// Convert SQLite '?' parameters to PostgreSQL '$1, $2, ...'.
// Skips '?' characters that appear inside single- or double-quoted string literals so a
// literal question mark (e.g. LIKE '%?%') does not shift the parameter numbering.
function convertSqlPlaceholders(sql) {
  let index = 1;
  let out = '';
  let quote = null; // null, "'", or '"'
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        // handle doubled-quote escape ('' or "")
        if (sql[i + 1] === quote) { out += sql[++i]; }
        else quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === '?') {
      out += `$${index++}`;
    } else {
      out += ch;
    }
  }
  return out;
}

// Prepared Statement Cache for better-sqlite3
const stmtCache = new Map();
function getStmt(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = sqliteDb.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

// Helper for DB queries using Promises
const query = (sql, params = []) => {
  if (isPostgres) {
    const pgSql = convertSqlPlaceholders(sql);
    return pgPool.query(pgSql, params).then(res => res.rows);
  }
  try {
    const stmt = getStmt(sql);
    return Promise.resolve(stmt.all(...params));
  } catch (err) {
    return Promise.reject(err);
  }
};

const run = (sql, params = []) => {
  if (isPostgres) {
    let pgSql = convertSqlPlaceholders(sql);
    // Postgres has no lastInsertRowid. For INSERTs lacking an explicit RETURNING clause,
    // append RETURNING id so callers that use the returned id work the same as on SQLite.
    if (/^\s*insert\s/i.test(pgSql) && !/\breturning\b/i.test(pgSql)) {
      pgSql = pgSql.replace(/;?\s*$/, ' RETURNING id');
    }
    return pgPool.query(pgSql, params)
      .then(res => ({
        id: res.rows && res.rows[0] ? res.rows[0].id : null,
        changes: res.rowCount
      }))
      .catch(err => {
        // A missing "id" column on RETURNING is not fatal — retry without it.
        if (/column "id" does not exist/i.test(err.message)) {
          return pgPool.query(convertSqlPlaceholders(sql), params)
            .then(res => ({ id: null, changes: res.rowCount }));
        }
        throw err;
      });
  }
  try {
    const stmt = getStmt(sql);
    const info = stmt.run(...params);
    return Promise.resolve({ id: info.lastInsertRowid, changes: info.changes });
  } catch (err) {
    return Promise.reject(err);
  }
};

// Run fn inside a real transaction. On Postgres, BEGIN/COMMIT/ROLLBACK are pinned to ONE
// pooled client (raw BEGIN/COMMIT through the pool land on different connections and are
// no-ops). On SQLite, better-sqlite3 is synchronous so we bracket with BEGIN/COMMIT.
async function withTransaction(fn) {
  if (isPostgres) {
    const client = await pgPool.connect();
    const clientRun = (sql, params = []) => client.query(convertSqlPlaceholders(sql), params)
      .then(res => ({ id: res.rows && res.rows[0] ? res.rows[0].id : null, changes: res.rowCount }));
    const clientGet = (sql, params = []) => client.query(convertSqlPlaceholders(sql), params)
      .then(res => res.rows[0] || null);
    const clientQuery = (sql, params = []) => client.query(convertSqlPlaceholders(sql), params)
      .then(res => res.rows);
    try {
      await client.query('BEGIN');
      const result = await fn({ run: clientRun, get: clientGet, query: clientQuery });
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }
  // SQLite path — synchronous engine, safe to bracket manually.
  await run('BEGIN');
  try {
    const result = await fn({ run, get, query });
    await run('COMMIT');
    return result;
  } catch (e) {
    try { await run('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

const get = (sql, params = []) => {
  if (isPostgres) {
    const pgSql = convertSqlPlaceholders(sql);
    return pgPool.query(pgSql, params).then(res => res.rows[0] || null);
  }
  try {
    const stmt = getStmt(sql);
    const res = stmt.get(...params);
    return Promise.resolve(res || null);
  } catch (err) {
    return Promise.reject(err);
  }
};


// Initialize Tables
async function initDb() {
  if (isPostgres) {
    // Postgres DDL Initialization - execute each statement independently
    const pgStatements = [
      `CREATE TABLE IF NOT EXISTS seasons (
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
      )`,
      `CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        store_nickname TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        email TEXT DEFAULT NULL,
        google_id TEXT UNIQUE DEFAULT NULL,
        role TEXT DEFAULT 'player',
        avatar_url TEXT DEFAULT NULL,
        profile_commander TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS decks (
        id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES players(id),
        moxfield_url TEXT UNIQUE NOT NULL,
        deck_name TEXT NOT NULL,
        cheapest_total_price REAL DEFAULT 0,
        last_checked TIMESTAMP,
        is_legal INTEGER DEFAULT 1,
        keep_cheapest INTEGER DEFAULT 0,
        is_public INTEGER DEFAULT 0,
        custom_tags TEXT,
        featured_card_name TEXT,
        format TEXT DEFAULT 'commander',
        cloned_from_deck_id TEXT,
        original_creator_name TEXT,
        legality_reason TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS deck_stats (
        deck_id TEXT PRIMARY KEY REFERENCES decks(id),
        total_wins INTEGER DEFAULT 0,
        total_kills INTEGER DEFAULT 0,
        total_points INTEGER DEFAULT 0,
        total_matches INTEGER DEFAULT 0,
        games_played INTEGER DEFAULT 0,
        win_rate REAL DEFAULT 0.0
      )`,
      `CREATE TABLE IF NOT EXISTS deck_cards (
        id SERIAL PRIMARY KEY,
        deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        card_name TEXT NOT NULL,
        quantity INTEGER DEFAULT 1,
        purchase_price REAL DEFAULT 0.0,
        cheapest_price REAL DEFAULT 0.0,
        cheapest_card_price REAL DEFAULT 0.0,
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
        custom_tag TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS price_overrides (
        id SERIAL PRIMARY KEY,
        card_name TEXT UNIQUE NOT NULL,
        price REAL NOT NULL,
        notes TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS scryfall_cards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        set_code TEXT DEFAULT 'unk',
        set_name TEXT,
        collector_number TEXT DEFAULT '1',
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
      )`,
      `CREATE TABLE IF NOT EXISTS card_price_cache (
        id SERIAL PRIMARY KEY,
        scryfall_id TEXT,
        card_name TEXT NOT NULL,
        set_code TEXT DEFAULT 'unk',
        collector_number TEXT DEFAULT '1',
        price REAL NOT NULL,
        foil_price REAL,
        image_uri TEXT,
        scryfall_uri TEXT,
        type_line TEXT,
        mana_cost TEXT,
        cmc REAL,
        rarity TEXT,
        cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS tournaments (
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
      )`,
      `CREATE TABLE IF NOT EXISTS tournament_players (
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
      )`,
      `CREATE TABLE IF NOT EXISTS tournament_rounds (
        id SERIAL PRIMARY KEY,
        tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        round_number INTEGER NOT NULL,
        status TEXT DEFAULT 'in_progress',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS matches (
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
      )`,
      `CREATE TABLE IF NOT EXISTS match_reports (
        id SERIAL PRIMARY KEY,
        match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        reporter_id TEXT NOT NULL REFERENCES players(id),
        winner_id TEXT REFERENCES players(id),
        kills_json TEXT,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (match_id, reporter_id)
      )`,
      `CREATE TABLE IF NOT EXISTS player_collection (
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
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender_id TEXT REFERENCES players(id),
        recipient_id TEXT REFERENCES players(id),
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS deck_likes (
        id SERIAL PRIMARY KEY,
        deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (deck_id, player_id)
      )`,
      `CREATE TABLE IF NOT EXISTS deck_comments (
        id SERIAL PRIMARY KEY,
        deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        comment_text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        link_url TEXT,
        is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS player_stats (
        player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        total_games INTEGER DEFAULT 0,
        total_wins INTEGER DEFAULT 0,
        total_kills INTEGER DEFAULT 0,
        total_points INTEGER DEFAULT 0,
        win_rate REAL DEFAULT 0.0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS scryfall_card_tags (
        card_name TEXT PRIMARY KEY,
        tags TEXT,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS collections (
        id SERIAL PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        is_public INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS collection_cards (
        id SERIAL PRIMARY KEY,
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        card_name TEXT NOT NULL,
        quantity INTEGER DEFAULT 1,
        set_code TEXT,
        collector_number TEXT,
        scryfall_id TEXT,
        foil INTEGER DEFAULT 0,
        purchase_price REAL DEFAULT 0.0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS follows (
        id SERIAL PRIMARY KEY,
        follower_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        following_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (follower_id, following_id)
      )`,
      `CREATE TABLE IF NOT EXISTS preference_events (
        id BIGSERIAL PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'app',
        signal REAL DEFAULT 0,
        context_json TEXT,
        occurrences INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (player_id, entity_type, entity_key, source)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_preference_events_player
       ON preference_events(player_id, last_seen_at DESC)`,
      `CREATE TABLE IF NOT EXISTS card_swipes (
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        card_key TEXT NOT NULL,
        card_name TEXT NOT NULL,
        scryfall_id TEXT,
        context_key TEXT NOT NULL DEFAULT 'explore',
        vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (player_id, card_key, context_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_card_swipes_player
       ON card_swipes(player_id, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS card_art_votes (
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        scryfall_id TEXT NOT NULL,
        card_name TEXT NOT NULL,
        artist TEXT,
        vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (player_id, scryfall_id)
      )`,
      `CREATE TABLE IF NOT EXISTS artist_follows (
        player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        artist_key TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (player_id, artist_key)
      )`,
      `CREATE TABLE IF NOT EXISTS followed_artist_printings (
        card_name TEXT NOT NULL,
        scryfall_id TEXT NOT NULL,
        artist_key TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        image_uri TEXT NOT NULL,
        set_name TEXT DEFAULT '',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (card_name, scryfall_id)
      )`,
      // Column migrations for Postgres
      `ALTER TABLE players ADD COLUMN IF NOT EXISTS google_id TEXT`,
      `ALTER TABLE card_art_votes ADD COLUMN IF NOT EXISTS artist TEXT`,
      `ALTER TABLE players ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'player'`,
      `ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
      `ALTER TABLE players ADD COLUMN IF NOT EXISTS profile_commander TEXT`,
      `ALTER TABLE players ADD COLUMN IF NOT EXISTS profile_bio TEXT`,
      `ALTER TABLE seasons ADD COLUMN IF NOT EXISTS schedule_mode TEXT`,
      `ALTER TABLE decks ADD COLUMN IF NOT EXISTS is_public INTEGER DEFAULT 0`,
      `ALTER TABLE decks ADD COLUMN IF NOT EXISTS custom_tags TEXT`,
      `ALTER TABLE decks ADD COLUMN IF NOT EXISTS featured_card_name TEXT`,
      `ALTER TABLE decks ADD COLUMN IF NOT EXISTS format TEXT DEFAULT 'commander'`,
      `ALTER TABLE decks ADD COLUMN IF NOT EXISTS cloned_from_deck_id TEXT`,
      `ALTER TABLE decks ADD COLUMN IF NOT EXISTS original_creator_name TEXT`,
      `ALTER TABLE decks ADD COLUMN IF NOT EXISTS legality_reason TEXT`,
      `ALTER TABLE decks ADD COLUMN IF NOT EXISTS likes_count INTEGER DEFAULT 0`,
      `ALTER TABLE deck_stats ADD COLUMN IF NOT EXISTS total_matches INTEGER DEFAULT 0`,
      `ALTER TABLE deck_stats ADD COLUMN IF NOT EXISTS season_id TEXT`,
      // player_stats never got the same treatment deck_stats has two lines up, so on Postgres it
      // has neither column while server.js writes both. Registration inserts
      // (player_id, season_id) for every active season, so with any season active the insert failed
      // and the route returned 500 -- after the players row had already been written, leaving an
      // account that exists and can log in but has no stats and never got its welcome notification.
      //
      // These are additive and IF NOT EXISTS, exactly like the deck_stats pair. They stop the 500.
      // They do NOT complete per-season standings on Postgres: the primary key here is player_id
      // alone, so one row per player rather than one per player per season. The composite
      // uniqueness that needs is what v2 migration 0009 introduces, and that has never run against
      // production.
      `ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS season_id TEXT`,
      `ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS total_matches INTEGER DEFAULT 0`,
      `ALTER TABLE scryfall_cards ADD COLUMN IF NOT EXISTS card_name TEXT`,
      // Premium billing (additive; flag-dark — unused until PREMIUM_GATING=on). See billing.js.
      `ALTER TABLE players ADD COLUMN IF NOT EXISTS premium_status TEXT DEFAULT 'free'`,
      `ALTER TABLE players ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`,
      `ALTER TABLE players ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`,
      `ALTER TABLE players ADD COLUMN IF NOT EXISTS premium_until TIMESTAMP`,
      `CREATE TABLE IF NOT EXISTS billing_events (id SERIAL PRIMARY KEY, stripe_event_id TEXT UNIQUE NOT NULL, type TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE INDEX IF NOT EXISTS idx_players_stripe_customer ON players(stripe_customer_id)`,
      `CREATE INDEX IF NOT EXISTS idx_deck_cards_commander ON deck_cards(deck_id, is_commander)`,
      `CREATE INDEX IF NOT EXISTS idx_decks_player ON decks(player_id)`,
      `CREATE INDEX IF NOT EXISTS idx_scryfall_cards_card_name ON scryfall_cards(card_name)`,
      `CREATE INDEX IF NOT EXISTS idx_scryfall_cards_lower_name ON scryfall_cards(LOWER(name))`,
      `CREATE INDEX IF NOT EXISTS idx_scryfall_cards_lower_card_name ON scryfall_cards(LOWER(card_name))`,
      `CREATE INDEX IF NOT EXISTS idx_card_price_cache_lower_card_name ON card_price_cache(LOWER(card_name))`,
      `CREATE INDEX IF NOT EXISTS idx_deck_cards_deck_id ON deck_cards(deck_id)`,
      `CREATE INDEX IF NOT EXISTS idx_deck_likes_deck_player ON deck_likes(deck_id, player_id)`,
      `CREATE INDEX IF NOT EXISTS idx_deck_comments_deck ON deck_comments(deck_id)`
    ];

    for (let stmt of pgStatements) {
      try {
        await query(stmt);
      } catch (e) {
        console.warn("Postgres DDL statement notice:", e.message);
      }
    }
    console.log("PostgreSQL database tables initialized successfully.");
    await seedAdminAccount();
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

  // Premium billing columns (additive; flag-dark — unused until PREMIUM_GATING=on). SQLite has no
  // ADD COLUMN IF NOT EXISTS on older engines, so each is guarded individually. See billing.js.
  for (const col of [
    "premium_status TEXT DEFAULT 'free'",
    "stripe_customer_id TEXT",
    "stripe_subscription_id TEXT",
    "premium_until DATETIME"
  ]) {
    try { await run(`ALTER TABLE players ADD COLUMN ${col}`); } catch (e) { /* already exists */ }
  }
  await run(`
    CREATE TABLE IF NOT EXISTS billing_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stripe_event_id TEXT UNIQUE NOT NULL,
      type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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

  // scryfall_cards — matches the LIVE SQLite schema (card_name keyed, no name/id/set_code).
  // The Scryfall importer and server.js SQLite queries both use these columns.
  await run(`
    CREATE TABLE IF NOT EXISTS scryfall_cards (
      card_name TEXT PRIMARY KEY,
      scryfall_id TEXT,
      type_line TEXT,
      oracle_text TEXT,
      mana_cost TEXT,
      cmc REAL,
      colors TEXT,
      price REAL,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      rarity TEXT DEFAULT 'common'
    )
  `);

  // card_price_cache — matches the LIVE SQLite schema (card_name keyed).
  await run(`
    CREATE TABLE IF NOT EXISTS card_price_cache (
      card_name TEXT PRIMARY KEY,
      price REAL,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      scryfall_id TEXT,
      type_line TEXT,
      oracle_text TEXT,
      mana_cost TEXT,
      cmc REAL DEFAULT 0,
      colors TEXT
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

  await run(`
    CREATE TABLE IF NOT EXISTS preference_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'app',
      signal REAL DEFAULT 0,
      context_json TEXT,
      occurrences INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (player_id, entity_type, entity_key, source),
      FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
    )
  `);

  // Gameplay taste. Keyed by card name, not printing: liking a card is a
  // statement about the card, and is scoped to the brew you were in.
  await run(`
    CREATE TABLE IF NOT EXISTS card_swipes (
      player_id TEXT NOT NULL,
      card_key TEXT NOT NULL,
      card_name TEXT NOT NULL,
      scryfall_id TEXT,
      context_key TEXT NOT NULL DEFAULT 'explore',
      vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (player_id, card_key, context_key),
      FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_card_swipes_player ON card_swipes(player_id, updated_at DESC);`);

  await run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Art taste. Keyed by printing, and only ever written by comparing
  // printings of one card, where art is the only thing that varies.
  await run(`
    CREATE TABLE IF NOT EXISTS card_art_votes (
      player_id TEXT NOT NULL,
      scryfall_id TEXT NOT NULL,
      card_name TEXT NOT NULL,
      artist TEXT,
      vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (player_id, scryfall_id),
      FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS artist_follows (
      player_id TEXT NOT NULL,
      artist_key TEXT NOT NULL,
      artist_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (player_id, artist_key),
      FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS followed_artist_printings (
      card_name TEXT NOT NULL,
      scryfall_id TEXT NOT NULL,
      artist_key TEXT NOT NULL,
      artist_name TEXT NOT NULL,
      image_uri TEXT NOT NULL,
      set_name TEXT DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (card_name, scryfall_id)
    )
  `);

  // Social / collection / notification tables — DDL matched EXACTLY to the live SQLite
  // schema (verified against the production grimore.db) so a fresh deploy creates the same
  // shapes server.js queries against (e.g. follows.followed_id, notifications.read_status).
  await run(`
    CREATE TABLE IF NOT EXISTS deck_likes (
      deck_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      PRIMARY KEY (deck_id, player_id),
      FOREIGN KEY(deck_id) REFERENCES decks(id),
      FOREIGN KEY(player_id) REFERENCES players(id)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS deck_comments (
      id TEXT PRIMARY KEY,
      deck_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      comment_text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      read_status INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(player_id) REFERENCES players(id)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS player_stats (
      player_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      total_points INTEGER DEFAULT 0,
      total_kills INTEGER DEFAULT 0,
      total_wins INTEGER DEFAULT 0,
      total_matches INTEGER DEFAULT 0,
      PRIMARY KEY (player_id, season_id),
      FOREIGN KEY(player_id) REFERENCES players(id)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS scryfall_card_tags (
      card_name TEXT PRIMARY KEY,
      tags TEXT,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      name TEXT NOT NULL,
      settings TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS collection_cards (
      collection_id TEXT NOT NULL,
      card_name TEXT NOT NULL,
      scryfall_id TEXT,
      quantity INTEGER DEFAULT 1,
      is_foil INTEGER DEFAULT 0,
      is_for_trade INTEGER DEFAULT 0,
      condition TEXT DEFAULT 'NM',
      language TEXT DEFAULT 'EN',
      purchase_price REAL DEFAULT NULL,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (collection_id, card_name, scryfall_id, is_foil, condition, language),
      FOREIGN KEY(collection_id) REFERENCES collections(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL,
      followed_id TEXT NOT NULL,
      PRIMARY KEY (follower_id, followed_id),
      FOREIGN KEY(follower_id) REFERENCES players(id),
      FOREIGN KEY(followed_id) REFERENCES players(id)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS deleted_items (
      id TEXT PRIMARY KEY,
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try {
    await run("ALTER TABLE deck_cards ADD COLUMN cheapest_card_price REAL DEFAULT 0.0");
  } catch (e) {
    // Column already exists
  }

  // Backfill columns registration/queries rely on for older SQLite player tables.
  const playerColumnMigrations = [
    "ALTER TABLE players ADD COLUMN role TEXT DEFAULT 'player'",
    "ALTER TABLE players ADD COLUMN avatar_url TEXT",
    "ALTER TABLE players ADD COLUMN profile_commander TEXT",
    "ALTER TABLE players ADD COLUMN profile_bio TEXT"
  ];
  for (const m of playerColumnMigrations) {
    try { await run(m); } catch (e) { /* column exists */ }
  }

  /*
    The columns the Postgres branch adds and this one never did.

    Every `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in the Postgres statement list above is a
    column `server.js` reads or writes. The SQLite branch had the four `players` ones immediately
    above and **none of the rest**, so on a freshly created local database:

      - `/api/decks/discover` answered 500 with `no such column: d.is_public`
      - the metagame endpoint answered 500 with `no such column: ds.season_id`
      - `INSERT INTO decks (... is_public, format)` -- deck creation -- could not run at all

    That is the opposite direction from the gap `claude/postgres-schema-gap-2026-09-27.md` and
    `scripts/audit-postgres-schema-gap.js` track, which is "what does Postgres not have that
    server.js writes". Nothing had ever audited this way round, and this way round is the one that
    breaks the workflow CLAUDE.md prescribes: *test locally first on http://localhost:3000*. Local
    was the broken one.

    Read-then-add rather than try-then-ignore. The blocks above this one wrap an `ALTER` in a
    `catch` that swallows everything, which cannot tell "the column is already there" from a typo,
    a missing table or a locked database -- so a real error would read as a successful migration.
    `PRAGMA table_info` answers the question the catch was guessing at.
  */
  const columnMigrations = [
    ['card_art_votes', 'artist', 'TEXT'],
    ['seasons', 'schedule_mode', 'TEXT'],
    ['decks', 'is_public', 'INTEGER DEFAULT 0'],
    ['decks', 'custom_tags', 'TEXT'],
    ['decks', 'featured_card_name', 'TEXT'],
    ['decks', 'format', "TEXT DEFAULT 'commander'"],
    ['decks', 'cloned_from_deck_id', 'TEXT'],
    ['decks', 'original_creator_name', 'TEXT'],
    ['decks', 'legality_reason', 'TEXT'],
    ['decks', 'likes_count', 'INTEGER DEFAULT 0'],
    ['deck_stats', 'total_matches', 'INTEGER DEFAULT 0'],
    ['deck_stats', 'season_id', 'TEXT'],
    ['player_stats', 'season_id', 'TEXT'],
    ['player_stats', 'total_matches', 'INTEGER DEFAULT 0'],
    ['scryfall_cards', 'card_name', 'TEXT'],

    /*
      And the columns the **v2 migrations** add, which the legacy SQLite branch also never got.

      `packages/db/migrations/` is this project's statement of what the schema is, and comparing it
      against a freshly created local database found twenty-one columns missing. Fifteen are below.
      Each one is read or written by `server.js`, and each absence is a 500 on a route rather than a
      degraded one:

        - `players.profile_theme` and its three siblings (migration 0006) -- `GET
          /api/players/:id/profile` answered `no such column: profile_theme`.
        - `decks.budget_limit` and `decks.include_basic_lands_in_price` -- both appear in the
          `INSERT INTO decks (...)` column lists in `server.js`, so **creating a deck could not work
          at all** on a fresh local database.
        - `players.sessions_valid_from` (migration 0014) -- `server.js` already catches its absence
          and warns that a password change cannot sign other sessions out. The warning was accurate
          on every local database there has ever been.
        - `seasons.banlist` and the four restriction columns beside it.

      The six `scryfall_cards` columns from migration 0015 are deliberately **not** here. That
      migration is for the Postgres card store, and `CARD_UPSERT_SQLITE` was deliberately left at
      thirteen columns when it was written (D329), so adding columns nothing writes would be the
      opposite of closing a gap.

      ## Two deliberate divergences, because SQLite's ALTER cannot express the Postgres form

      `ALTER TABLE ... ADD COLUMN x TIMESTAMPTZ NOT NULL DEFAULT now()` has no SQLite equivalent:
      SQLite refuses a non-constant default on an added column, and `NOT NULL` without a default
      would refuse the existing rows. So the four timestamp columns are added **nullable with no
      default**, and that is safe to do here because the code already reads them that way:
      `server.js` guards `sessions_valid_from` with `row ? new Date(...) : null`, and a null reads as
      "no cutoff", which is the right answer for a row that predates the column.
    */
    ['players', 'profile_theme', "TEXT DEFAULT 'default'"],
    ['players', 'featured_deck_id', 'TEXT'],
    ['players', 'discord_handle', 'TEXT'],
    ['players', 'moxfield_username', 'TEXT'],
    ['players', 'email_verified_at', 'DATETIME'],
    ['players', 'sessions_valid_from', 'DATETIME'],
    ['decks', 'budget_limit', 'REAL'],
    ['decks', 'include_basic_lands_in_price', 'INTEGER NOT NULL DEFAULT 0'],
    ['decks', 'created_at', 'DATETIME'],
    ['decks', 'updated_at', 'DATETIME'],
    ['seasons', 'allowed_colors', `TEXT NOT NULL DEFAULT '["W","U","B","R","G","C"]'`],
    ['seasons', 'allowed_rarities', `TEXT NOT NULL DEFAULT '["common","uncommon","rare","mythic"]'`],
    ['seasons', 'banlist', "TEXT NOT NULL DEFAULT '[]'"],
    ['seasons', 'budget_limit', 'REAL'],
    ['seasons', 'max_rares', 'INTEGER NOT NULL DEFAULT -1'],

    /*
      `deck_cards.custom_tag`, which no schema anywhere creates.

      `server.js` inserts it on the deck-save path (two sites) and selects `dc.custom_tag` in the
      deck queries, and it is in neither branch of this file nor in any v2 migration. Found by
      `scripts/audit-sqlite-schema-gap.js`, and it is the same class as the `direct_messages` and
      `password_resets` rows in `claude/postgres-schema-gap-2026-09-27.md`: referenced by the app,
      defined by nothing.

      Adding it here fixes the local half only. **Postgres still does not have it**, which is
      recorded in that document rather than fixed with a migration from here, because the migration
      list is a cutover artifact and the cutover is not mine to change.
    */
    ['deck_cards', 'custom_tag', 'TEXT']
  ];
  const columnsOf = async (table) => {
    try {
      const rows = await query(`PRAGMA table_info(${table})`);
      return new Set(rows.map((r) => String(r.name)));
    } catch (e) {
      // The table itself is missing, which is a different problem and a louder one: say so rather
      // than reporting the column as migrated.
      console.warn(`[initDb] cannot read columns of ${table}:`, e.message);
      return null;
    }
  };
  const seenColumns = new Map();
  for (const [table, column, spec] of columnMigrations) {
    if (!seenColumns.has(table)) seenColumns.set(table, await columnsOf(table));
    const have = seenColumns.get(table);
    if (have === null || have.has(column)) continue;
    try {
      await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
      have.add(column);
      console.log(`[initDb] added missing SQLite column ${table}.${column}`);
    } catch (e) {
      console.warn(`[initDb] could not add ${table}.${column}:`, e.message);
    }
  }

  // Index creation is best-effort: a pre-existing DB may have a drifted schema (e.g. an
  // older scryfall_cards without a `name` column), and a single missing-column error must
  // NOT abort initDb — that would take the whole app down on boot. Each index is guarded.
  const indexStatements = [
    `CREATE INDEX IF NOT EXISTS idx_deck_cards_deck_id ON deck_cards(deck_id)`,
    `CREATE INDEX IF NOT EXISTS idx_deck_cards_card_name ON deck_cards(card_name)`,
    `CREATE INDEX IF NOT EXISTS idx_deck_cards_commander ON deck_cards(deck_id, is_commander)`,
    `CREATE INDEX IF NOT EXISTS idx_decks_player ON decks(player_id)`,
    `CREATE INDEX IF NOT EXISTS idx_scryfall_cards_card_name ON scryfall_cards(card_name)`,
    // Expression index so the hot LOWER(card_name)=LOWER(?) price joins are index-backed
    // on SQLite (a plain index can't serve a LOWER(col) predicate).
    `CREATE INDEX IF NOT EXISTS idx_scryfall_cards_lower_card_name ON scryfall_cards(LOWER(card_name))`,
    `CREATE INDEX IF NOT EXISTS idx_card_price_cache_lower_card_name ON card_price_cache(LOWER(card_name))`,
    `CREATE INDEX IF NOT EXISTS idx_deck_likes_deck_player ON deck_likes(deck_id, player_id)`,
    `CREATE INDEX IF NOT EXISTS idx_deck_comments_deck ON deck_comments(deck_id)`,
    `CREATE INDEX IF NOT EXISTS idx_player_collection_player ON player_collection(player_id)`,
    `CREATE INDEX IF NOT EXISTS idx_preference_events_player ON preference_events(player_id, last_seen_at DESC)`,
  ];
  for (const stmt of indexStatements) {
    try { await run(stmt); } catch (e) { console.warn('[initDb] skipped index:', e.message); }
  }

  console.log("SQLite database initialized successfully.");
  await seedAdminAccount();
}

async function seedAdminAccount() {
  try {
    // Admin credentials come from the environment — never a source-committed password.
    // ADMIN_USER/ADMIN_PASSWORD override the defaults; if no password is provided a
    // random one-time password is generated and printed to the server log once.
    const adminUser = process.env.ADMIN_USER || 'nickbuildsdecks';
    const existingAdmin = await get("SELECT id FROM players WHERE username = ?", [adminUser]);
    if (!existingAdmin) {
      const bcrypt = require('bcryptjs');
      let adminPassword = process.env.ADMIN_PASSWORD;
      let generated = false;
      if (!adminPassword) {
        adminPassword = require('crypto').randomBytes(18).toString('base64url');
        generated = true;
      }
      const hash = bcrypt.hashSync(adminPassword, 10);
      await run(
        "INSERT INTO players (id, username, password_hash, store_nickname, is_admin, role) VALUES (?, ?, ?, ?, 1, 'admin')",
        ['p_admin', adminUser, hash, 'Nick']
      );
      if (generated) {
        console.log("\n==================== ADMIN ACCOUNT SEEDED ====================");
        console.log(`  Username: ${adminUser}`);
        console.log(`  One-time password (change this immediately): ${adminPassword}`);
        console.log("  Set ADMIN_USER / ADMIN_PASSWORD in the environment to control this.");
        console.log("==============================================================\n");
      } else {
        console.log(`Default admin account '${adminUser}' seeded from ADMIN_PASSWORD env var.`);
      }
    }
  } catch (err) {
    console.warn("Admin account seed notice:", err.message);
  }
}

module.exports = {
  db: isPostgres ? pgPool : sqliteDb,
  query,
  run,
  get,
  withTransaction,
  initDb,
  isPostgres
};
