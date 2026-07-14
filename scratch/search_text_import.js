const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\app.js';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('handleTextImportDeck') || line.includes('text-import') || line.includes('import-text')) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  });
}
