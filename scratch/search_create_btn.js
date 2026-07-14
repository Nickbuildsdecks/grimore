const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\index.html';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('onclick="') && (line.includes('deck') || line.includes('Builder') || line.includes('create') || line.includes('new'))) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  });
} else {
  console.log("File not found");
}
