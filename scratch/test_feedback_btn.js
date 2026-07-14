const fs = require('fs');
const path = require('path');

const jsContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const jsLines = jsContent.split('\n');

jsLines.forEach((line, idx) => {
  if (line.toLowerCase().includes("feedback")) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
