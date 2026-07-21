const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Check if persistent volume mount directory exists (Fly.io volume location)
const dataDir = '/data';
const dbPath = fs.existsSync(dataDir) 
  ? path.join(dataDir, 'grimore.db') 
  : path.join(__dirname, 'grimore.db');

// Connect to SQLite Database
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error connecting to SQLite database:', err.message);
  } else {
    console.log('Connected to Grimore SQLite database.');
    db.run("PRAGMA foreign_keys = ON;", (err) => {
      if (err) console.error("Failed to enable foreign keys:", err.message);
    });
  }
});

// Helper for DB queries using Promises
const query = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// Initialize Tables
async function initDb() {
  // Create Seasons Table
  await run(`
    CREATE TABLE IF NOT EXISTS seasons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      points_entry INTEGER DEFAULT 1,
      points_kill INTEGER DEFAULT 1,
      points_win INTEGER DEFAULT 2,
      points_draw INTEGER DEFAULT 1,
      remainder_pref TEXT DEFAULT '3', -- '3' or '5'
      use_point_pairing INTEGER DEFAULT 1,
      checkin_enabled INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Players Table
  await run(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      store_nickname TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      email TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Decks Table
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

  // Create Deck Stats Table (for tracking deck performance)
  await run(`
    CREATE TABLE IF NOT EXISTS deck_stats (
      deck_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      total_points INTEGER DEFAULT 0,
      total_kills INTEGER DEFAULT 0,
      total_wins INTEGER DEFAULT 0,
      total_matches INTEGER DEFAULT 0,
      PRIMARY KEY (deck_id, season_id),
      FOREIGN KEY(deck_id) REFERENCES decks(id)
    )
  `);

  // Create Deck Cards Table (for tracking individual card budget details)
  await run(`
    CREATE TABLE IF NOT EXISTS deck_cards (
      deck_id TEXT NOT NULL,
      card_name TEXT NOT NULL,
      cheapest_card_price REAL DEFAULT 0,
      quantity INTEGER DEFAULT 1,
      scryfall_id TEXT,
      PRIMARY KEY (deck_id, card_name),
      FOREIGN KEY(deck_id) REFERENCES decks(id)
    )
  `);

  // Safe migrations for existing DB
  try {
    await run("ALTER TABLE deck_cards ADD COLUMN quantity INTEGER DEFAULT 1");
  } catch (e) {
    // Ignore if column already exists
  }
  try {
    await run("ALTER TABLE deck_cards ADD COLUMN scryfall_id TEXT");
  } catch (e) {
    // Ignore if column already exists
  }
  try {
    await run("ALTER TABLE seasons ADD COLUMN checkin_enabled INTEGER DEFAULT 1");
  } catch (e) {
    // Ignore if column already exists
  }
  try {
    await run("ALTER TABLE deck_cards ADD COLUMN custom_tag TEXT DEFAULT NULL");
  } catch (e) {
    // Ignore if column already exists
  }

  // Create Player Stats Table (for season standings)
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

  // Create Pods Table
  await run(`
    CREATE TABLE IF NOT EXISTS pods (
      id TEXT PRIMARY KEY,
      season_id TEXT NOT NULL,
      round_num INTEGER NOT NULL,
      pod_label INTEGER NOT NULL, -- Pod 1, Pod 2...
      completed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Pod Results Table
  await run(`
    CREATE TABLE IF NOT EXISTS pod_results (
      pod_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      deck_id TEXT,
      kills INTEGER DEFAULT 0,
      placed_first INTEGER DEFAULT 0, -- 1 = Win, 0 = Loss/Draw
      placed_draw INTEGER DEFAULT 0,  -- 1 = Draw
      points_awarded INTEGER DEFAULT 0,
      PRIMARY KEY (pod_id, player_id),
      FOREIGN KEY(pod_id) REFERENCES pods(id),
      FOREIGN KEY(player_id) REFERENCES players(id)
    )
  `);

  // Create Active Roster Table (for checking in to current round)
  await run(`
    CREATE TABLE IF NOT EXISTS active_roster (
      player_id TEXT PRIMARY KEY,
      deck_id TEXT,
      checked_in INTEGER DEFAULT 1,
      FOREIGN KEY(player_id) REFERENCES players(id)
    )
  `);

  // Create Card Price Cache (to minimize Scryfall API hammering)
  await run(`
    CREATE TABLE IF NOT EXISTS card_price_cache (
      card_name TEXT PRIMARY KEY,
      price REAL,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Movers Table (to track price spikes for budget cards)
  await run(`
    CREATE TABLE IF NOT EXISTS price_movers (
      card_name TEXT PRIMARY KEY,
      old_price REAL,
      new_price REAL,
      percentage_change REAL,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Safe migrations for Phase 4 fields
  try {
    await run("ALTER TABLE seasons ADD COLUMN schedule_mode TEXT DEFAULT 'tabletop'");
  } catch (e) {}
  try {
    await run("ALTER TABLE players ADD COLUMN role TEXT DEFAULT 'player'");
  } catch (e) {}
  try {
    await run("ALTER TABLE players ADD COLUMN avatar_url TEXT");
  } catch (e) {}
  try {
    await run("ALTER TABLE players ADD COLUMN profile_commander TEXT");
  } catch (e) {}
  try {
    await run("ALTER TABLE decks ADD COLUMN cloned_from_deck_id TEXT");
  } catch (e) {}
  try {
    await run("ALTER TABLE decks ADD COLUMN original_creator_name TEXT");
  } catch (e) {}
  try {
    await run("ALTER TABLE decks ADD COLUMN is_public INTEGER DEFAULT 1");
  } catch (e) {}
  try {
    await run("ALTER TABLE decks ADD COLUMN format TEXT DEFAULT 'commander'");
  } catch (e) {}
  try {
    await run("ALTER TABLE decks ADD COLUMN budget_limit REAL");
  } catch (e) {}
  try {
    await run("ALTER TABLE decks ADD COLUMN likes_count INTEGER DEFAULT 0");
  } catch (e) {}
  try {
    await run("ALTER TABLE seasons ADD COLUMN budget_limit REAL");
  } catch (e) {}
  try {
    await run("ALTER TABLE decks ADD COLUMN featured_card_name TEXT");
  } catch (e) {}
  try {
    await run("ALTER TABLE deck_cards ADD COLUMN is_commander INTEGER DEFAULT 0");
  } catch (e) {}
  try {
    await run("ALTER TABLE card_price_cache ADD COLUMN scryfall_id TEXT");
  } catch (e) {}
  try {
    await run("ALTER TABLE card_price_cache ADD COLUMN type_line TEXT");
  } catch (e) {}
  try {
    await run("ALTER TABLE card_price_cache ADD COLUMN oracle_text TEXT");
  } catch (e) {}
  try {
    await run("ALTER TABLE card_price_cache ADD COLUMN mana_cost TEXT");
  } catch (e) {}
  try {
    await run("ALTER TABLE card_price_cache ADD COLUMN cmc REAL DEFAULT 0");
  } catch (e) {}
  try {
    await run("ALTER TABLE card_price_cache ADD COLUMN colors TEXT");
  } catch (e) {}
  try {
    await run("ALTER TABLE decks ADD COLUMN format TEXT DEFAULT 'commander'");
  } catch (e) {}
  try {
    await run("ALTER TABLE seasons ADD COLUMN banlist TEXT DEFAULT '[]'");
  } catch (e) {}
  try {
    await run("ALTER TABLE seasons ADD COLUMN max_rares INTEGER DEFAULT -1");
  } catch (e) {}
  try {
    await run("ALTER TABLE seasons ADD COLUMN allowed_rarities TEXT DEFAULT '[\"common\",\"uncommon\",\"rare\",\"mythic\"]'");
  } catch (e) {}
  try {
    await run("ALTER TABLE seasons ADD COLUMN allowed_colors TEXT DEFAULT '[\"W\",\"U\",\"B\",\"R\",\"G\",\"C\"]'");
  } catch (e) {}
  try {
    await run("ALTER TABLE decks ADD COLUMN legality_reason TEXT DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE decks ADD COLUMN include_basic_lands_in_price INTEGER DEFAULT 0");
  } catch (e) {}
  try {
    await run("ALTER TABLE decks ADD COLUMN keep_cheapest INTEGER DEFAULT 0");
  } catch (e) {}
  try {
    await run("ALTER TABLE players ADD COLUMN email TEXT DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE players ADD COLUMN profile_bio TEXT DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE players ADD COLUMN profile_theme TEXT DEFAULT 'default'");
  } catch (e) {}
  try {
    await run("ALTER TABLE players ADD COLUMN featured_deck_id TEXT DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE players ADD COLUMN discord_handle TEXT DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE players ADD COLUMN moxfield_username TEXT DEFAULT NULL");
  } catch (e) {}
  try {
    await run("ALTER TABLE decks ADD COLUMN custom_tags TEXT DEFAULT '[]'");
  } catch (e) {}
  await run(`
    CREATE TABLE IF NOT EXISTS password_resets (
      username TEXT NOT NULL,
      token TEXT PRIMARY KEY,
      expires_at DATETIME NOT NULL
    )
  `);



  // Create Deck Likes Table
  await run(`
    CREATE TABLE IF NOT EXISTS deck_likes (
      deck_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      PRIMARY KEY (deck_id, player_id),
      FOREIGN KEY(deck_id) REFERENCES decks(id),
      FOREIGN KEY(player_id) REFERENCES players(id)
    )
  `);

  // Per-player preferences for individual Scryfall printings/art treatments.
  // A vote is intentionally scoped to a printing ID instead of a card name so
  // alternate artwork, frames, and promos can be rated independently.
  await run(`
    CREATE TABLE IF NOT EXISTS card_art_votes (
      player_id TEXT NOT NULL,
      scryfall_id TEXT NOT NULL,
      card_name TEXT NOT NULL,
      vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (player_id, scryfall_id),
      FOREIGN KEY(player_id) REFERENCES players(id)
    )
  `);
  await run(`
    CREATE INDEX IF NOT EXISTS idx_card_art_votes_card_name
    ON card_art_votes(card_name)
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
    CREATE INDEX IF NOT EXISTS idx_artist_follows_player
    ON artist_follows(player_id)
  `);

  // Small preference cache used to substitute a followed illustrator's
  // printing in search results without issuing per-card Scryfall requests.
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
  await run(`
    CREATE INDEX IF NOT EXISTS idx_followed_artist_printings_lookup
    ON followed_artist_printings(card_name, artist_key)
  `);

  // Create Deck Comments Table
  await run(`
    CREATE TABLE IF NOT EXISTS deck_comments (
      id TEXT PRIMARY KEY,
      deck_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      comment_text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(deck_id) REFERENCES decks(id),
      FOREIGN KEY(player_id) REFERENCES players(id)
    )
  `);

  // Create Notifications Table
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

  // Create Follows Table
  await run(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL,
      followed_id TEXT NOT NULL,
      PRIMARY KEY (follower_id, followed_id),
      FOREIGN KEY(follower_id) REFERENCES players(id),
      FOREIGN KEY(followed_id) REFERENCES players(id)
    )
  `);

  // Create Direct Messages Table
  await run(`
    CREATE TABLE IF NOT EXISTS direct_messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      read_status INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(sender_id) REFERENCES players(id),
      FOREIGN KEY(recipient_id) REFERENCES players(id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_dm_recipient ON direct_messages(recipient_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_dm_sender ON direct_messages(sender_id)`);

  // Create Friend Requests Table
  await run(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(sender_id) REFERENCES players(id),
      FOREIGN KEY(recipient_id) REFERENCES players(id),
      UNIQUE(sender_id, recipient_id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_fr_recipient ON friend_requests(recipient_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_fr_sender ON friend_requests(sender_id)`);

  // Create Scryfall Local Database Copy Table
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
      rarity TEXT DEFAULT 'common',
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_scryfall_cards_name ON scryfall_cards(card_name)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_scryfall_cards_name_nocase ON scryfall_cards(card_name COLLATE NOCASE)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_card_price_cache_nocase ON card_price_cache(card_name COLLATE NOCASE)`);

  // Create Scryfall Card Tags Cache Table
  await run(`
    CREATE TABLE IF NOT EXISTS scryfall_card_tags (
      card_name TEXT PRIMARY KEY,
      tags TEXT, -- JSON array of tags stringified
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Collections Table
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
  await run(`CREATE INDEX IF NOT EXISTS idx_collections_player ON collections(player_id)`);

  // Create Collection Cards Table
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
  await run(`CREATE INDEX IF NOT EXISTS idx_collection_cards_id ON collection_cards(collection_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_collection_cards_name ON collection_cards(card_name)`);

  // Create Wishlist Cards Table
  await run(`
    CREATE TABLE IF NOT EXISTS wishlist_cards (
      player_id TEXT NOT NULL,
      card_name TEXT NOT NULL,
      scryfall_id TEXT,
      quantity INTEGER DEFAULT 1,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (player_id, card_name, scryfall_id),
      FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_wishlist_cards_player ON wishlist_cards(player_id)`);

  // Create Deleted Items Table (Recovery System)
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
  await run(`CREATE INDEX IF NOT EXISTS idx_deleted_items_player ON deleted_items(player_id)`);

  // Index optimization for performance queries
  await run(`CREATE INDEX IF NOT EXISTS idx_deck_cards_deck ON deck_cards(deck_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_decks_player ON decks(player_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_pod_results_player ON pod_results(player_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_pod_results_pod ON pod_results(pod_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_pod_results_deck ON pod_results(deck_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_pods_season ON pods(season_id)`);

  // Setup default Season if none exists
  const activeSeason = await get("SELECT * FROM seasons WHERE is_active = 1");
  if (!activeSeason) {
    await run(`
      INSERT INTO seasons (id, name, points_entry, points_kill, points_win, points_draw, remainder_pref, use_point_pairing, is_active)
      VALUES ('season_default', 'Commander League Season 1', 1, 1, 2, 1, '3', 1, 1)
    `);
  }

  // Setup custom Admin 'NickBuildsDecks' (purging the old default 'admin')
  const bcrypt = require('bcryptjs');
  
  // Purge old default admin
  await run("DELETE FROM players WHERE username = 'admin'");
  
  const adminPlayer = await get("SELECT * FROM players WHERE username = 'nickbuildsdecks'");
  if (!adminPlayer) {
    const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
    const hash = await bcrypt.hash(adminPassword, 10);
    await run(`
      INSERT INTO players (id, username, password_hash, store_nickname, is_admin, role)
      VALUES ('p_admin', 'nickbuildsdecks', ?, 'Nick', 1, 'admin')
    `, [hash]);
    console.log("Admin account created: NickBuildsDecks");
    if (!process.env.ADMIN_PASSWORD) {
      console.warn("[SECURITY WARNING] Admin seeded with default password 'ChangeMe123!'. Please define ADMIN_PASSWORD in your .env file.");
    }
  }

  // Purge any tokens, emblems, art series, or un-set cards from local card cache and clean card_price_cache
  await run(`
    DELETE FROM scryfall_cards 
    WHERE LOWER(type_line) = 'card'
       OR LOWER(type_line) LIKE 'card //%'
       OR LOWER(type_line) LIKE '%token%'
       OR LOWER(type_line) LIKE '%emblem%'
       OR LOWER(type_line) LIKE '%art series%'
       OR LOWER(type_line) LIKE '%card // token%'
       OR LOWER(rarity) = 'funny'
  `);
  await run(`
    DELETE FROM card_price_cache 
    WHERE LOWER(type_line) = 'card'
       OR LOWER(type_line) LIKE 'card //%'
       OR LOWER(type_line) LIKE '%token%'
       OR LOWER(type_line) LIKE '%emblem%'
       OR LOWER(type_line) LIKE '%art series%'
       OR LOWER(type_line) LIKE '%card // token%'
  `);
  // Clear incorrect scryfall_ids in deck_cards for basic lands and art cards to force clean repricing
  await run(`
    UPDATE deck_cards 
    SET scryfall_id = NULL 
    WHERE LOWER(card_name) IN (
      'cultivate', 'island', 'lotus cobra', 'negate', 'tireless tracker',
      'forest', 'mountain', 'plains', 'swamp'
    )
  `);
  console.log("Cleaned up tokens, emblems, and funny cards from local cache database.");

  // Try to attach MTGJSON database if it exists
  const localMTGJSON = path.join(__dirname, 'AllPrintings.sqlite');
  const dataMTGJSON = '/data/AllPrintings.sqlite';
  let activeMTGJSON = null;
  
  if (fs.existsSync(dataMTGJSON)) {
    activeMTGJSON = dataMTGJSON;
  } else if (fs.existsSync(localMTGJSON)) {
    activeMTGJSON = localMTGJSON;
  }
  
  if (activeMTGJSON) {
    try {
      await run(`ATTACH DATABASE ? AS mtgjson`, [activeMTGJSON]);
      console.log(`Attached MTGJSON database successfully from: ${activeMTGJSON}`);
    } catch (e) {
      console.error("Failed to attach MTGJSON database:", e.message);
    }
  } else {
    console.log("MTGJSON database not found. Offline fallback queries disabled.");
  }
}

module.exports = {
  db,
  query,
  run,
  get,
  initDb
};
