const fs = require('fs');
const files = [
  'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\index.html',
  'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\style.css',
  'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\app.js'
];
files.forEach(file => {
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes('builder-mobile-tabs')) {
        console.log(`${file}: ${idx + 1}: ${line}`);
      }
    });
  } else {
    console.log(`File not found: ${file}`);
  }
});
