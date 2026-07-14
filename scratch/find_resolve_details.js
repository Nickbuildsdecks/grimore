const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes("resolveCardDetailsBatch")) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
    // Print 45 lines after
    for (let i = 1; i <= 45; i++) {
      console.log(`Line ${idx + 1 + i}: ${lines[idx + i]}`);
    }
  }
});
