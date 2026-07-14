const fs = require('fs');
const files = [
  'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\index.html',
  'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\app.js'
];
files.forEach(file => {
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes('auto-tag') || line.toLowerCase().includes('autotag') || line.includes('Auto Tag')) {
        console.log(`${file} Line ${idx + 1}: ${line.substring(0, 300)}`);
      }
    });
  }
});
