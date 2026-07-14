const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\app.js';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('function load') || line.includes('function get') || line.includes('function fetch')) {
      if (line.includes('async')) {
        console.log(`${idx + 1}: ${line.trim()}`);
      }
    }
  });
} else {
  console.log("File not found");
}
