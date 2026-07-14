const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes("function fetchJson") || line.includes("const fetchJson")) {
    console.log(`Line ${idx + 1}: ${line}`);
    // Print 20 lines after
    for (let i = 1; i <= 20; i++) {
      console.log(`Line ${idx + 1 + i}: ${lines[idx + i]}`);
    }
  }
});
