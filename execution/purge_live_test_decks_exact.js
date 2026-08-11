let db;
try {
  db = require('./db');
} catch (e) {
  db = require('../db');
}

async function purgeLiveTestDebris() {
  await db.initDb();
  console.log("=== Purging All Remaining Gemini / Test Decks from Production ===");

  const targetDecks = await db.query(`
    SELECT id, deck_name, player_id, is_public 
    FROM decks 
    WHERE deck_name LIKE '%Test%'
       OR deck_name LIKE '%test%'
       OR deck_name LIKE 'Cloned%'
       OR deck_name LIKE '%Delete%'
       OR deck_name LIKE 'Quick Import%'
       OR deck_name LIKE '%Gemini%'
       OR id LIKE 'd_1786%'
  `);

  console.log(`Found ${targetDecks.length} test deck(s) on production:`);
  targetDecks.forEach(d => console.log(` - [${d.id}] "${d.deck_name}" (Owner: ${d.player_id}, Public: ${d.is_public})`));

  if (targetDecks.length > 0) {
    const ids = targetDecks.map(d => `'${d.id}'`).join(',');
    await db.run(`DELETE FROM deck_stats WHERE deck_id IN (${ids})`);
    await db.run(`DELETE FROM deck_likes WHERE deck_id IN (${ids})`);
    await db.run(`DELETE FROM deck_cards WHERE deck_id IN (${ids})`);
    await db.run(`DELETE FROM decks WHERE id IN (${ids})`);
    console.log(`Successfully purged ${targetDecks.length} test deck(s) from live server.`);
  }

  console.log("=== Live Test Debris Purge Complete ===");
}

purgeLiveTestDebris().catch(console.error);
