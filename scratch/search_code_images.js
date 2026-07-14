const fs = require('fs');

function search(file) {
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes('image') && (line.includes('scryfall') || line.includes('uri') || line.includes('url'))) {
        console.log(`${file}:${idx + 1}: ${line.trim()}`);
      }
    });
  }
}

search('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\app.js');
search('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\search.js');
search('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\server.js');
