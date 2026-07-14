const fs = require('fs');

function search(file) {
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes('moxfield') && (line.toLowerCase().includes('import') || line.toLowerCase().includes('load'))) {
        console.log(`${file}:${idx + 1}: ${line.substring(0, 150).trim()}`);
      }
    });
  }
}

search('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\index.html');
search('C:\\Users\\772wa\\.gemini\antigravity\\scratch\\mtg-tournament-platform\\public\\app.js');
