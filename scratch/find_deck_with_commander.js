const db = require('../db');

async function run() {
  const decks = await db.query("SELECT id, deck_name FROM decks LIMIT 5");
  console.log("Decks:", decks);
  for (let d of decks) {
    const commanders = await db.query("SELECT card_name FROM deck_cards WHERE deck_id = ? AND is_commander = 1", [d.id]);
    console.log(`Deck: ${d.deck_name} (${d.id}) -> Commanders:`, commanders.map(c => c.card_name));
  }
}
run();
