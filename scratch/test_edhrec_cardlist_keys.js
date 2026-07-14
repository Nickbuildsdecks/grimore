const https = require('https');

const slug = 'koma-cosmos-serpent';
const url = `https://json.edhrec.com/pages/commanders/${slug}.json`;

https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    if (res.statusCode === 200) {
      try {
        const json = JSON.parse(data);
        const cardlists = json.container.json_dict.cardlists;
        if (cardlists && cardlists.length > 0) {
          cardlists.forEach((list, idx) => {
            console.log(`[${idx}] tag: ${list.tag}, header: ${list.header}, card count: ${list.cardviews ? list.cardviews.length : 'no cardviews field'}`);
            if (list.cardviews && list.cardviews.length > 0) {
              console.log("  First card keys:", Object.keys(list.cardviews[0]));
              console.log("  First card sample name:", list.cardviews[0].name);
              console.log("  First card sample price/synergy:", list.cardviews[0].price, list.cardviews[0].synergy);
            }
          });
        }
      } catch (e) {
        console.error("Parse error:", e);
      }
    }
  });
});
