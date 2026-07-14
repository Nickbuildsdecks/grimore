const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes("reprice-card-cheapest") || line.includes("reprice-finalize")) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
    // Print 15 lines before and after
    const start = Math.max(0, idx - 15);
    const end = Math.min(lines.length - 1, idx + 15);
    for (let i = start; i <= end; i++) {
      console.log(`  [${i + 1}] ${lines[i]}`);
    }
  }
});
