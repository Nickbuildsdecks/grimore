const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes("function ") && (line.includes("Builder") || line.includes("Grid") || line.includes("Deck") || line.includes("Card"))) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
