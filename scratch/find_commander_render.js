const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes("builder-commander-image-container") || line.includes("commander-image-container")) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
    // Print 30 lines after
    for (let i = 1; i <= 30; i++) {
      console.log(`  [${idx + 1 + i}] ${lines[idx + i]}`);
    }
  }
});
