const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes("auth-magic-canvas") || line.includes("app-bg-canvas") || line.includes("initAuthMagicCanvas") || line.includes("initAppBgCanvas")) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
    // Print 20 lines after
    for (let i = 1; i <= 20; i++) {
      console.log(`  [${idx + 1 + i}] ${lines[idx + i]}`);
    }
  }
});
