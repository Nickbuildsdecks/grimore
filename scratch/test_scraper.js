const https = require('https');

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
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP Error ${res.statusCode}: ${data}`));
          } else {
            resolve(JSON.parse(data));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Grimore/1.0 (grimore@lgs.com)',
        'Accept': 'text/html'
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP Error ${res.statusCode}`));
        } else {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

async function test() {
  try {
    const cardName = "Wrath of God";
    console.log(`Searching Scryfall for: ${cardName}`);
    const cardData = await fetchJson(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(cardName)}`);
    const set = cardData.set;
    const number = cardData.collector_number;
    console.log(`Found: Set=${set}, Number=${number}`);
    
    const taggerUrl = `https://tagger.scryfall.com/card/${set.toLowerCase()}/${number.toLowerCase()}`;
    console.log(`Scraping tagger: ${taggerUrl}`);
    const html = await fetchHtml(taggerUrl);
    
    const metaMatch = html.match(/<meta name="description" content="([\s\S]+?)"\s*\/?>/i) || 
                      html.match(/<meta property="og:description" content="([\s\S]+?)"\s*\/?>/i);
                      
    if (metaMatch) {
      const description = metaMatch[1];
      console.log(`Found description meta:\n${description}\n`);
      const cardTagsIndex = description.indexOf("Card Tags:");
      if (cardTagsIndex !== -1) {
        const tagsText = description.substring(cardTagsIndex);
        const tags = [...tagsText.matchAll(/(?:★|•)\s*([^\r\n"•★]+)/g)].map(m => m[1].trim());
        console.log("Parsed Card Tags:", tags);
      } else {
        console.log("No Card Tags found in description.");
      }
    } else {
      console.log("Meta description tag not found in HTML.");
    }
  } catch(e) {
    console.error("Test failed:", e);
  }
}

test();
