const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\search.html';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  let insideDrawer = false;
  lines.forEach((line, idx) => {
    if (line.includes('id="card-inspector-drawer"')) insideDrawer = true;
    if (insideDrawer) {
      console.log(`${idx + 1}: ${line.trim()}`);
      if (line.includes('</div>') && idx > 330) {
        // Stop printing after a reasonable depth
      }
    }
  });
}
