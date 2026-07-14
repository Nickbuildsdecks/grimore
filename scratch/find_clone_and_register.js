const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\server.js';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('is_public') && (line.includes('register') || line.includes('clone') || line.includes('cloned') || line.includes('INSERT INTO decks'))) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  });
}
