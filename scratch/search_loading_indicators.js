const fs = require('fs');

function searchFile(file) {
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes('load') || line.toLowerCase().includes('spinner') || line.toLowerCase().includes('loading')) {
        if (line.toLowerCase().includes('display') || line.toLowerCase().includes('textcontent') || line.toLowerCase().includes('innerhtml')) {
          console.log(`${file}:${idx + 1}: ${line.substring(0, 150).trim()}`);
        }
      }
    });
  }
}

searchFile('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\app.js');
searchFile('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\search.js');
