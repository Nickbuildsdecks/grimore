const https = require('https');

const slug = 'koma-cosmos-serpent';
const url = `https://json.edhrec.com/pages/commanders/${slug}.json`;

console.log("Fetching EDHREC json from:", url);

https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log("Status code:", res.statusCode);
    if (res.statusCode === 200) {
      try {
        const json = JSON.parse(data);
        console.log("JSON keys:", Object.keys(json).slice(0, 10));
        if (json.container && json.container.json_dict) {
          const dict = json.container.json_dict;
          console.log("json_dict keys:", Object.keys(dict).slice(0, 10));
          if (dict.cardlist) {
            console.log("Found cardlist! Length:", dict.cardlist.length);
            console.log("Sample card:", dict.cardlist[0]);
          }
        }
      } catch (e) {
        console.error("Failed to parse JSON:", e.message);
      }
    } else {
      console.log("Non-200 response:", data.substring(0, 500));
    }
  });
}).on('error', (err) => {
  console.error("Error:", err.message);
});
