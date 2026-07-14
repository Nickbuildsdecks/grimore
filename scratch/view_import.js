const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes("/api/decks/import-moxfield")) {
    console.log(`Line ${idx + 1}: ${line}`);
    // Print 40 lines after
    for (let i = 1; i <= 40; i++) {
      console.log(`Line ${idx + 1 + i}: ${lines[idx + i]}`);
    }
  }
});
