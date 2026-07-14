const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\search.js';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('addEventListener') || line.includes('keyup') || line.includes('keydown') || line.includes('change') || line.includes('input')) {
      console.log(`${idx + 1}: ${line}`);
    }
  });
} else {
  console.log("File not found");
}
