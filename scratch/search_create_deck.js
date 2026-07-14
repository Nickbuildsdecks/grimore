const fs = require('fs');

function searchFile(filePath, query) {
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes(query)) {
        console.log(`${filePath}:${idx + 1}: ${line.trim()}`);
      }
    });
  } else {
    console.log(`File not found: ${filePath}`);
  }
}

console.log("Searching in server.js...");
searchFile('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\server.js', '/api/decks');
searchFile('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\server.js', 'insert into decks');
searchFile('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\server.js', 'INSERT INTO decks');

console.log("\nSearching in public/app.js...");
searchFile('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\app.js', 'createDeck');
searchFile('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\app.js', 'newDeck');
searchFile('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\app.js', '/api/decks/save');
