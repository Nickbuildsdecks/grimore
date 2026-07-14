const fs = require('fs');

function checkHtml(filePath) {
  console.log("Validating:", filePath);
  if (!fs.existsSync(filePath)) {
    console.error("File does not exist!");
    return;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  
  // Basic check for unclosed tag brackets or mismatched structures
  let openAngle = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '<') openAngle++;
    else if (content[i] === '>') openAngle--;
    
    if (openAngle < 0 || openAngle > 1) {
      console.log(`Bracket mismatch at char ${i}: context: ${content.substring(Math.max(0, i-20), i+20)}`);
      openAngle = 0;
    }
  }
  console.log("Bracket match check finished.");
}

checkHtml('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\index.html');
checkHtml('C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\public\\suggestions.html');
