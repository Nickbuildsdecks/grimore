const { query, run, get } = require('../db');
const https = require('https');

function fetchJsonPost(url, body) {
  return new Promise((resolve, reject) => {
    const dataString = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'User-Agent': 'Grimore/1.0 (grimore@lgs.com)',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataString)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(dataString);
    req.end();
  });
}

async function prewarmCardPrices() {
  console.log("=== STARTING CARD PRICE PRE-WARMING & BATCH REPRICING ===");

  // Get all unique card names across all decks
  const uniqueCards = await query(`
    SELECT DISTINCT card_name 
    FROM deck_cards 
    WHERE card_name NOT IN ('Island', 'Swamp', 'Plains', 'Mountain', 'Forest', 'Snow-Covered Island', 'Snow-Covered Swamp', 'Snow-Covered Plains', 'Snow-Covered Mountain', 'Snow-Covered Forest')
  `);

  console.log(`Found ${uniqueCards.length} unique non-basic deck card names to verify and pre-warm.`);

  // 1. First sync from scryfall_cards local cache
  let localUpdates = 0;
  await run("BEGIN TRANSACTION");
  try {
    for (const { card_name } of uniqueCards) {
      const scryfallEntry = await get("SELECT price, scryfall_id, rarity, type_line, mana_cost, cmc FROM scryfall_cards WHERE card_name = ? OR card_name LIKE ? ORDER BY price ASC LIMIT 1", [card_name, card_name]);
      if (scryfallEntry && scryfallEntry.price) {
        await run(
          `INSERT OR REPLACE INTO card_price_cache 
           (scryfall_id, card_name, price, type_line, mana_cost, cmc, last_updated) 
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [scryfallEntry.scryfall_id || 'cache_' + Date.now(), card_name, scryfallEntry.price, scryfallEntry.type_line || '', scryfallEntry.mana_cost || '', scryfallEntry.cmc || 0]
        );

        await run(
          "UPDATE deck_cards SET cheapest_card_price = ? WHERE card_name = ?",
          [scryfallEntry.price, card_name]
        );
        localUpdates++;
      }
    }
    await run("COMMIT");
  } catch (err) {
    await run("ROLLBACK");
    throw err;
  }
  console.log(`✓ Local cache pre-warmed ${localUpdates} card prices.`);

  // 2. Re-calculate cheapest total price for all 93 decks
  const allDecks = await query("SELECT id, deck_name FROM decks");
  console.log(`Recalculating cheapest total prices for ${allDecks.length} decks...`);

  for (const deck of allDecks) {
    const totals = await get(`
      SELECT SUM(COALESCE(cheapest_card_price, 0.15) * quantity) as total 
      FROM deck_cards 
      WHERE deck_id = ? AND card_name NOT IN ('Island', 'Swamp', 'Plains', 'Mountain', 'Forest')
    `, [deck.id]);

    const total = parseFloat((totals.total || 0).toFixed(2));
    await run(
      "UPDATE decks SET cheapest_total_price = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?",
      [total, deck.id]
    );
  }

  console.log("✓ All 93 deck total prices recalculated and updated successfully.");
  console.log("=== CARD PRICE PRE-WARMING COMPLETE ===\n");
}

prewarmCardPrices().catch(console.error);
