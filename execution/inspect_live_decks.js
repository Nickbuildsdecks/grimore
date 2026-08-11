let db;
try {
  db = require('./db');
} catch (e) {
  db = require('../db');
}

async function inspectDecks() {
  await db.initDb();
  console.log("=== Inspecting All Decks on Database ===");
  const decks = await db.query(`SELECT id, deck_name, player_id, is_public FROM decks ORDER BY id DESC`);
  console.log(`Total decks: ${decks.length}`);
  decks.forEach(d => console.log(` - [${d.id}] "${d.deck_name}" (Owner: ${d.player_id}, Public: ${d.is_public})`));
}

inspectDecks().catch(console.error);
