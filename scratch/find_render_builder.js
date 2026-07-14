const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes("renderBuilderCard") || line.includes("renderDeckBuilderGrid")) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
    // Print 50 lines after
    for (let i = 1; i <= 50; i++) {
      console.log(`Line ${idx + 1 + i}: ${lines[idx + i]}`);
    }
  }
});
