const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\index.html';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  let inBuilderSection = false;
  let braces = 0;
  lines.forEach((line, idx) => {
    if (line.includes('id="deckbuilder-view"') || line.includes('view-section') && line.includes('deckbuilder')) {
      inBuilderSection = true;
      console.log(`--- Start of Deckbuilder section: Line ${idx + 1} ---`);
    }
    if (inBuilderSection) {
      if (idx < 1350) { // Limit output to first 150 lines of section
        console.log(`${idx + 1}: ${line}`);
      }
      if (line.includes('</section>')) {
        // We can stop after viewing a chunk
      }
    }
  });
} else {
  console.log("File not found");
}
