const https = require('https');
const db = require('../db');

function getEdhrecSlugForCommanders(names) {
  if (!names || names.length === 0) return '';
  const slugs = names.map(name => {
    return name.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '') // remove special characters
      .replace(/\s+/g, '-')         // spaces to hyphens
      .replace(/-+/g, '-')          // collapse hyphens
      .replace(/^-+|-+$/g, '');     // trim hyphens
  });
  slugs.sort();
  return slugs.join('-');
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 6000
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`EDHREC returned status code ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error("EDHREC request timed out"));
    });
  });
}

async function run() {
  const commanderName = 'Koma, Cosmos Serpent';
  const slug = getEdhrecSlugForCommanders([commanderName]);
  const url = `https://json.edhrec.com/pages/commanders/${slug}.json`;

  console.log("Fetching url:", url);
  try {
    const json = await fetchJson(url);
    const cardlists = json.container.json_dict.cardlists || [];
    console.log(`Fetched ${cardlists.length} cardlists.`);

    // Extract all unique card names
    const allNames = new Set();
    cardlists.forEach(list => {
      if (list.cardviews) {
        list.cardviews.forEach(c => {
          if (c.name) allNames.add(c.name);
        });
      }
    });

    const namesArray = Array.from(allNames);
    console.log(`Found ${namesArray.length} unique card names in suggestions.`);

    // Look up in database
    if (namesArray.length > 0) {
      // Chunk the array to avoid too many SQL parameters
      const chunkSize = 90;
      const dbCards = [];
      for (let i = 0; i < namesArray.length; i += chunkSize) {
        const chunk = namesArray.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const query = `
          SELECT sc.card_name, sc.scryfall_id, sc.type_line, sc.image_uri, pc.price as cheapest_card_price
          FROM scryfall_cards sc
          LEFT JOIN card_price_cache pc ON sc.card_name = pc.card_name
          WHERE sc.card_name IN (${placeholders})
        `;
        const results = await db.query(query, chunk);
        dbCards.push(...results);
      }

      console.log(`Matched ${dbCards.length} cards in local database.`);
      const cardMap = {};
      dbCards.forEach(c => {
        cardMap[c.card_name.toLowerCase()] = c;
      });

      // Show sample category mapped
      const sampleList = cardlists.find(l => l.tag === 'highsynergycards');
      if (sampleList && sampleList.cardviews) {
        console.log("High Synergy Cards Sample:");
        sampleList.cardviews.slice(0, 3).forEach(c => {
          const matched = cardMap[c.name.toLowerCase()];
          console.log(`- ${c.name}: synergy=${(c.synergy * 100).toFixed(0)}%, price=${matched ? matched.cheapest_card_price : '0.15'}, image=${matched ? matched.image_uri : 'null'}`);
        });
      }
    }
  } catch (e) {
    console.error("Error:", e.message);
  }
}

run();
