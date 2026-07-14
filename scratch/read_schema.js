const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'grimore.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.all("PRAGMA table_info(decks)", (err, columns) => {
    if (err) {
      console.error(err);
      return;
    }
    console.log("Decks table columns:");
    columns.forEach(c => console.log(`- ${c.name} (${c.type})`));
    
    db.all("PRAGMA table_info(deck_cards)", (err, cols) => {
      console.log("\nDeck_cards table columns:");
      cols.forEach(c => console.log(`- ${c.name} (${c.type})`));
      db.close();
    });
  });
});
