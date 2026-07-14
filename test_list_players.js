const db = require('./db');

async function test() {
  await db.initDb();
  console.log("Database initialized.");
  const players = await db.query("SELECT id, username, store_nickname, moxfield_username, is_admin FROM players");
  console.log("Players in DB:", players);
}

test().catch(console.error);
