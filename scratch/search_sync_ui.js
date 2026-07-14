const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\index.html';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.toLowerCase().includes('sync') || line.toLowerCase().includes('database') || line.toLowerCase().includes('mtgjson')) {
      console.log(`${idx + 1}: ${line.substring(0, 200)}`);
    }
  });
} else {
  console.log("File not found");
}
