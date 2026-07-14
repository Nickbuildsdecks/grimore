const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\server.js';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('admin') || line.includes('sync') || line.includes('mtgjson')) {
      if (line.includes('app.get') || line.includes('app.post')) {
        console.log(`${idx + 1}: ${line}`);
      }
    }
  });
} else {
  console.log("File not found");
}
