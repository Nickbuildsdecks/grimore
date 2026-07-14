const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes("builderMainboard =") || line.includes("builderCommander =") || line.includes("openDeckBuilder(")) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
    // Print 35 lines after
    for (let i = 1; i <= 35; i++) {
      console.log(`Line ${idx + 1 + i}: ${lines[idx + i]}`);
    }
  }
});
