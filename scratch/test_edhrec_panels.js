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
        if (json.panels) {
          console.log("Panels keys:", Object.keys(json.panels));
          // Let's print a sample if it is an object
          console.log("Sample panel keys:", Object.keys(json.panels[Object.keys(json.panels)[0]] || {}));
        }
        if (json.container) {
          console.log("Container keys:", Object.keys(json.container));
          if (json.container.json_dict) {
            console.log("json_dict keys:", Object.keys(json.container.json_dict));
            if (json.container.json_dict.cardlists) {
              console.log("cardlists length:", json.container.json_dict.cardlists.length);
              console.log("Sample cardlist header/tag:", json.container.json_dict.cardlists[0].header, json.container.json_dict.cardlists[0].tag);
              console.log("Sample cardlists card:", json.container.json_dict.cardlists[0].cardlist ? json.container.json_dict.cardlists[0].cardlist[0] : 'none');
            }
          }
        }
      } catch (e) {
        console.error("Parse error:", e);
      }
    }
  });
});
