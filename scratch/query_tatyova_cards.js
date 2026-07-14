const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes("removeBuilderCard") || line.includes("delete-btn") || line.includes("btn-danger")) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
