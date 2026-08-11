let db;
try {
  db = require('./db');
} catch (e) {
  db = require('../db');
}

async function cleanupTestDebris() {
  await db.initDb();
  console.log("=== Grimore Live Test Debris Cleaner ===");

  try {
    await db.run("PRAGMA foreign_keys = OFF;");
  } catch (e) {
    // Postgres does not use PRAGMA
  }

  // Find test decks (e.g. deck_name starting with 'Test', 'Cloned', 'Quick Import', or id starting with 'd_17')
  const testDecks = await db.query(`
    SELECT id, deck_name, player_id 
    FROM decks 
    WHERE deck_name LIKE 'Test%' 
       OR deck_name LIKE 'Cloned%' 
       OR deck_name LIKE 'Quick Import%'
       OR id LIKE 'd_1786%'
       OR player_id LIKE 'p_1786%'
  `);

  console.log(`Found ${testDecks.length} test deck(s) to remove from live database:`);
  testDecks.forEach(d => console.log(` - [${d.id}] ${d.deck_name} (User: ${d.player_id})`));

  // Find test players
  const testPlayers = await db.query(`SELECT id, store_nickname FROM players WHERE id LIKE 'p_1786%' OR username LIKE 'Test%'`);

  if (testDecks.length > 0) {
    const deckIds = testDecks.map(d => `'${d.id}'`).join(',');
    
    // Delete deck likes & cards & decks
    await db.run(`DELETE FROM deck_likes WHERE deck_id IN (${deckIds})`);
    await db.run(`DELETE FROM deck_cards WHERE deck_id IN (${deckIds})`);
    await db.run(`DELETE FROM decks WHERE id IN (${deckIds})`);
    console.log(`Deleted ${testDecks.length} test deck(s) from live database.`);
  }

  if (testPlayers.length > 0) {
    const playerIds = testPlayers.map(p => `'${p.id}'`).join(',');
    
    await db.run(`DELETE FROM deck_likes WHERE player_id IN (${playerIds})`);
    await db.run(`DELETE FROM deck_cards WHERE deck_id IN (SELECT id FROM decks WHERE player_id IN (${playerIds}))`);
    await db.run(`DELETE FROM decks WHERE player_id IN (${playerIds})`);
    await db.run(`DELETE FROM players WHERE id IN (${playerIds})`);
    console.log(`Deleted ${testPlayers.length} test player account(s) from live database.`);
  }

  try {
    await db.run("PRAGMA foreign_keys = ON;");
  } catch (e) {}

  console.log("=== Live Cleanup Complete ===");
}

cleanupTestDebris().catch(console.error);
