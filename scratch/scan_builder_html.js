const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\index.html';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('class="drawer-tab') || line.includes('drawer-tab-') || line.includes('id="pane-') || line.includes('id="inspector-')) {
      console.log(`${idx + 1}: ${line}`);
    }
  });
} else {
  console.log("File not found");
}
