const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\style.css';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  let openBrackets = 0;
  let inMediaQuery = false;
  lines.forEach((line, idx) => {
    if (line.includes('@media (max-width: 768px)')) {
      inMediaQuery = true;
      openBrackets = 0;
      console.log(`Media query starts at: ${idx + 1}`);
    }
    if (inMediaQuery) {
      const matchOpen = line.match(/\{/g);
      const matchClose = line.match(/\}/g);
      if (matchOpen) openBrackets += matchOpen.length;
      if (matchClose) openBrackets -= matchClose.length;
      if (openBrackets === 0 && line.includes('}')) {
        console.log(`Media query ends at: ${idx + 1}`);
        inMediaQuery = false;
      }
    }
  });
} else {
  console.log("File not found");
}
