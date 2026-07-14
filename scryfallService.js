const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const db = require('./db');

// Delay helper
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Helper to make HTTPS requests with User-Agent
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Grimore/1.0 (grimore@lgs.com)',
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Download compressed file and extract it
function downloadBulkFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destPath);
    https.get(url, {
      headers: {
        'User-Agent': 'Grimore/1.0 (grimore@lgs.com)'
      }
    }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download bulk file: ${response.statusCode} ${response.statusMessage}`));
        return;
      }

      // Check if response is gzipped
      const contentEncoding = response.headers['content-encoding'];
      let decompressor = null;
      if (contentEncoding === 'gzip' || url.endsWith('.gz')) {
        decompressor = zlib.createGunzip();
      }

      response.on('error', reject);
      fileStream.on('error', reject);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });

      if (decompressor) {
        decompressor.on('error', reject);
        response.pipe(decompressor).pipe(fileStream);
      } else {
        response.pipe(fileStream);
      }
    }).on('error', reject);
  });
}

async function downloadAndImportScryfallBulk(force = false) {
  // Check if we already have cards and don't need a force reload
  if (!force) {
    const existing = await db.get("SELECT count(*) as count FROM scryfall_cards");
    if (existing && existing.count > 1000) {
      console.log(`Local Scryfall database already populated with ${existing.count} cards. Skipping initial sync.`);
      return;
    }
  }

  console.log("Starting Scryfall bulk data synchronization...");
  const tempPath = path.join(__dirname, 'scryfall-oracle-cards.json');

  try {
    // 1. Fetch metadata
    console.log("Retrieving Scryfall bulk metadata...");
    const metadata = await fetchJson('https://api.scryfall.com/bulk-data');
    const oracleCardsObj = (metadata.data || []).find(d => d.type === 'oracle_cards');

    if (!oracleCardsObj || !oracleCardsObj.download_uri) {
      throw new Error("Could not locate oracle_cards download_uri in Scryfall bulk data.");
    }

    console.log(`Oracle cards download size: ${(oracleCardsObj.size / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Downloading bulk file from: ${oracleCardsObj.download_uri}`);

    // 2. Download and decompress
    const startTime = Date.now();
    await downloadBulkFile(oracleCardsObj.download_uri, tempPath);
    console.log(`Download completed in ${((Date.now() - startTime) / 1000).toFixed(2)}s`);

    // 3. Read and parse bulk data using streaming readline to keep memory footprint under 30MB
    console.log("Importing card objects to SQLite database using streaming reader (transaction)...");
    const insertStart = Date.now();
    await db.run("BEGIN TRANSACTION");
    
    let cardCount = 0;
    try {
      const readline = require('readline');
      const fileStream = fs.createReadStream(tempPath, { encoding: 'utf8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      const insertCard = async (card) => {
        // Exclude tokens, emblems, art series, memorabilia, etc.
        const layout = card.layout || "";
        if (["token", "double_faced_token", "emblem", "art_series", "memorabilia"].includes(layout)) return;

        const set_type = card.set_type || "";
        if (["funny", "token", "memorabilia"].includes(set_type)) return;

        const border_color = card.border_color || "";
        if (border_color === "silver" || border_color === "gold") return;

        if (card.digital) return;

        // Verify the card is legal in at least one format to exclude completely non-legal/playtest cards
        const leg = card.legalities || {};
        const isLegalSomewhere = Object.values(leg).some(status => status === "legal" || status === "restricted");
        if (!isLegalSomewhere) return;

        const name = card.name;
        const scryfallId = card.id || null;
        const type_line = card.type_line || "";
        const oracle_text = card.oracle_text || "";
        const mana_cost = card.mana_cost || "";
        const cmc = card.cmc !== undefined ? card.cmc : 0;
        const colors = JSON.stringify(card.colors || []);
        const rarity = card.rarity || "common";
        
        let price = 0.05;
        if (card.prices) {
          const usd = parseFloat(card.prices.usd);
          const usdLow = parseFloat(card.prices.usd_low);
          if (usd) price = usd;
          if (usdLow && usdLow < price) price = usdLow;
        }

        await db.run(
          `INSERT OR REPLACE INTO scryfall_cards 
           (card_name, scryfall_id, type_line, oracle_text, mana_cost, cmc, colors, price, rarity, last_updated) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [name, scryfallId, type_line, oracle_text, mana_cost, cmc, colors, price, rarity]
        );
      };

      let currentObjectLines = [];
      let isAccumulating = false;

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // 1. Check if the line is a complete card JSON object (minified format)
        if (trimmed.startsWith('{"') && (trimmed.endsWith('}') || trimmed.endsWith('},'))) {
          let jsonStr = trimmed;
          if (jsonStr.endsWith(',')) {
            jsonStr = jsonStr.slice(0, -1);
          }
          try {
            const card = JSON.parse(jsonStr);
            await insertCard(card);
            cardCount++;
          } catch (e) {
            // Ignore parse errors
          }
          continue;
        }

        // 2. Fallback to pretty-printed accumulator format
        if (trimmed === '{') {
          isAccumulating = true;
          currentObjectLines = [trimmed];
        } else if (isAccumulating) {
          currentObjectLines.push(line);
          if (trimmed === '}' || trimmed === '},') {
            isAccumulating = false;
            let jsonStr = currentObjectLines.join('\n').trim();
            if (jsonStr.endsWith(',')) {
              jsonStr = jsonStr.slice(0, -1);
            }
            try {
              const card = JSON.parse(jsonStr);
              await insertCard(card);
              cardCount++;
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      }

      await db.run("COMMIT");
      console.log(`Import completed in ${((Date.now() - insertStart) / 1000).toFixed(2)}s. Parsed ${cardCount} cards.`);
    } catch (writeErr) {
      try {
        await db.run("ROLLBACK");
      } catch (rollbackErr) {}
      throw writeErr;
    }

  } catch (err) {
    console.error("Scryfall bulk import failed:", err);
  } finally {
    // 5. Cleanup temp file
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
        console.log("Temporary bulk data JSON file deleted.");
      } catch (cleanupErr) {
        console.warn("Failed to delete temp file:", cleanupErr.message);
      }
    }
  }
}

// Setup background sync intervals every 24 hours
function setupDailySync() {
  const INTERVAL_24H = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    console.log("Triggering scheduled 24-hour Scryfall bulk database update...");
    await downloadAndImportScryfallBulk(true);
  }, INTERVAL_24H);
}

module.exports = {
  downloadAndImportScryfallBulk,
  setupDailySync
};
