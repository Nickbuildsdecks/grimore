const db = require('./db');
db.initDb().then(async () => {
  const count = await db.get("SELECT count(*) as count FROM scryfall_cards");
  console.log("Scryfall Cards Count:", count.count);
  
  // Check if MTGJSON attached cards table exists
  try {
    const mtgjson = await db.get("SELECT count(*) as count FROM mtgjson.cards");
    console.log("MTGJSON attached cards count:", mtgjson.count);
  } catch (e) {
    console.log("MTGJSON cards table check failed:", e.message);
  }
}).catch(console.error);
