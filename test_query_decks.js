const db = require('./db');

async function test() {
  await db.initDb();
  console.log("Database initialized.");
  const decks = await db.query("SELECT id, player_id, moxfield_url, deck_name FROM decks");
  console.log("Decks in DB:", decks);
}

test().catch(console.error);
