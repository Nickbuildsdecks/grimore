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
        if (json.creature) {
          console.log("Creature suggestions length:", json.creature.length);
          console.log("First creature suggestion:", json.creature[0]);
        }
      } catch (e) {
        console.error("Parse error:", e);
      }
    }
  });
});
