const fs = require('fs');

function search(file) {
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes('edhrec')) {
        console.log(`${file}:${idx + 1}: ${line.trim()}`);
      }
    });
  }
}

search('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\server.js');
search('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\db.js');
