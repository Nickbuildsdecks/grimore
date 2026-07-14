const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\style.css';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('keyframes') || line.includes('spin')) {
      console.log(`${idx + 1}: ${line.trim()}`);
    }
  });
} else {
  console.log("File not found");
}
