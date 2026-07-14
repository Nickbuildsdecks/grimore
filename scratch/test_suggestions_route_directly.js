const db = require('../db');

async function testSuggestions(deckId) {
  try {
    const commanders = await db.query(
      "SELECT card_name FROM deck_cards WHERE deck_id = ? AND is_commander = 1",
      [deckId]
    );
    console.log("Commanders found:", commanders);
    if (commanders.length === 0) {
      console.log("No commander found.");
      return;
    }

    const getEdhrecSlugForCommanders = (names) => {
      const slugs = names.map(name => {
        return name.toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-+|-+$/g, '');
      });
      slugs.sort();
      return slugs.join('-');
    };

    const commanderNames = commanders.map(c => c.card_name);
    const slug = getEdhrecSlugForCommanders(commanderNames);
    console.log("Slug:", slug);
    const edhrecUrl = `https://json.edhrec.com/pages/commanders/${slug}.json`;
    console.log("Fetching EDHREC URL:", edhrecUrl);

    const https = require('https');
    const fetchJson = (url) => {
      return new Promise((resolve, reject) => {
        const req = https.get(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 6000
        }, (res) => {
          if (res.statusCode !== 200) return reject(new Error(`Status: ${res.statusCode}`));
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(JSON.parse(data)));
        });
        req.on('error', reject);
      });
    };

    const json = await fetchJson(edhrecUrl);
    const cardlists = json.container.json_dict.cardlists || [];
    console.log(`Fetched ${cardlists.length} lists from EDHREC.`);
    
    const allNames = new Set();
    cardlists.forEach(list => {
      if (list.cardviews) {
        list.cardviews.forEach(c => {
          if (c.name) allNames.add(c.name);
        });
      }
    });

    const namesArray = Array.from(allNames);
    console.log(`Unique suggestions name count: ${namesArray.length}`);

    const cardMap = {};
    if (namesArray.length > 0) {
      const chunkSize = 90;
      for (let i = 0; i < namesArray.length; i += chunkSize) {
        const chunk = namesArray.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const dbCards = await db.query(
          `SELECT sc.card_name, sc.scryfall_id, sc.type_line, pc.price as cheapest_card_price
           FROM scryfall_cards sc
           LEFT JOIN card_price_cache pc ON sc.card_name = pc.card_name
           WHERE sc.card_name IN (${placeholders})`,
          chunk
        );
        dbCards.forEach(c => {
          cardMap[c.card_name.toLowerCase()] = c;
        });
      }
    }

    console.log(`Matched ${Object.keys(cardMap).length} cards in DB.`);
    
    // Check first list
    const firstList = cardlists[0];
    if (firstList) {
      console.log(`Category: ${firstList.header}`);
      firstList.cardviews.slice(0, 3).forEach(c => {
        const matched = cardMap[c.name.toLowerCase()];
        console.log(`- ${c.name}: price=${matched ? matched.cheapest_card_price : '0.15'}, id=${matched ? matched.scryfall_id : 'null'}`);
      });
    }

  } catch (e) {
    console.error("Test failed:", e.message);
  }
}

testSuggestions('d_1782861745554_mz7oxa5z0');
