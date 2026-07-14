const fs = require('fs');
const file = 'C:\\Users\\772wa\\.gemini\\antigravity\\scratch\\mtg-tournament-platform\\server.js';
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, 'utf8');
  console.log("unhandledRejection in server.js:", content.includes('unhandledRejection'));
  console.log("uncaughtException in server.js:", content.includes('uncaughtException'));
} else {
  console.log("File not found");
}
