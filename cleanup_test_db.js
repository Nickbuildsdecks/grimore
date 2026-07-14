const db = require('./db');

async function cleanup() {
  await db.initDb();
  console.log("Database initialized.");

  // Delete decks not owned by p_admin or not part of the standard set
  const decksDeleted = await db.run("DELETE FROM decks WHERE player_id LIKE 'p_1783%'");
  console.log("Deleted test decks:", decksDeleted);

  // Delete test players
  const playersDeleted = await db.run("DELETE FROM players WHERE id LIKE 'p_1783%'");
  console.log("Deleted test players:", playersDeleted);
}

cleanup().catch(console.error);
