const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\index.html';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  console.log("Contains deckbuilder-col-stats:", content.includes('deckbuilder-col-stats'));
} else {
  console.log("File not found");
}
