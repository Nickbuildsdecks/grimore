const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'grimore.db');
const db = new sqlite3.Database(dbPath);

db.all("SELECT id, deck_name, cheapest_total_price, format FROM decks", (err, decks) => {
  if (err) {
    console.error(err);
    return;
  }
  decks.forEach(d => {
    console.log(`Deck: ${d.deck_name} (ID: ${d.id}), Price: $${d.cheapest_total_price}`);
  });
  db.close();
});
