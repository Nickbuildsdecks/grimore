const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'grimore.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.all("SELECT id, deck_name, cheapest_total_price, format FROM decks", (err, decks) => {
    if (err) {
      console.error(err);
      return;
    }
    console.log(`Found ${decks.length} decks:`);
    let deckPromises = decks.map(d => {
      return new Promise((resolve) => {
        db.all("SELECT COUNT(*) as count FROM deck_cards WHERE deck_id = ?", [d.id], (err, row) => {
          resolve({
            id: d.id,
            deck_name: d.deck_name,
            format: d.format,
            dbPrice: d.cheapest_total_price,
            cardCount: row ? row[0].count : 0
          });
        });
      });
    });
    
    Promise.all(deckPromises).then(results => {
      results.forEach(r => {
        console.log(`- ID: ${r.id}, Name: ${r.deck_name}, Format: ${r.format}, Cards: ${r.cardCount}, DB Price: $${r.dbPrice}`);
      });
      
      // Let's print details of the deck that has a database price close to $107.44 or has many cards
      const target = results.find(r => r.cardCount > 0);
      if (target) {
        console.log(`\nInspecting Deck: ${target.deck_name} (${target.id})`);
        db.all("SELECT * FROM deck_cards WHERE deck_id = ?", [target.id], (err, cards) => {
          let sum = 0;
          cards.forEach(c => {
            const itemTotal = c.cheapest_card_price * c.quantity;
            sum += itemTotal;
            console.log(`  - ${c.card_name} (${c.quantity}x): $${c.cheapest_card_price.toFixed(2)} each, total $${itemTotal.toFixed(2)} (Scryfall ID: ${c.scryfall_id})`);
          });
          console.log(`Total sum: $${sum.toFixed(2)}`);
          db.close();
        });
      } else {
        db.close();
      }
    });
  });
});
