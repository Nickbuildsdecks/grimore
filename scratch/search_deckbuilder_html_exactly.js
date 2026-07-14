const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\index.html';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  let start = -1;
  lines.forEach((line, idx) => {
    if (line.includes('id="deckbuilder-view"') || (line.includes('id=') && line.includes('deckbuilder') && line.includes('section'))) {
      start = idx;
    }
  });
  if (start !== -1) {
    console.log(`Found start at line ${start + 1}`);
    for (let i = start; i < start + 150; i++) {
      if (i < lines.length) {
        console.log(`${i + 1}: ${lines[i]}`);
      }
    }
  } else {
    console.log("Not found deckbuilder-view");
  }
}
