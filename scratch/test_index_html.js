const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\index.html';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  // Simple check for unclosed div or section tags in the file
  const divsOpen = (content.match(/<div\b/g) || []).length;
  const divsClose = (content.match(/<\/div>/g) || []).length;
  const sectionsOpen = (content.match(/<section\b/g) || []).length;
  const sectionsClose = (content.match(/<\/section>/g) || []).length;
  
  console.log(`Divs - Open: ${divsOpen}, Close: ${divsClose}`);
  console.log(`Sections - Open: ${sectionsOpen}, Close: ${sectionsClose}`);
  if (divsOpen !== divsClose) {
    console.warn("WARNING: Div mismatch detected!");
  } else {
    console.log("Div count matches!");
  }
} else {
  console.log("File not found");
}
