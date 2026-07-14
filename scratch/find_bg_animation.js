const fs = require('fs');
const path = require('path');

const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const lines = htmlContent.split('\n');

console.log("=== Canvas elements in HTML ===");
lines.forEach((line, idx) => {
  if (line.includes("<canvas") || line.includes("canvas")) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});

const cssContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const cssLines = cssContent.split('\n');
console.log("\n=== Animation rules in CSS ===");
cssLines.forEach((line, idx) => {
  if (line.includes("keyframes") || line.includes("animation:") || line.includes("@keyframes")) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
