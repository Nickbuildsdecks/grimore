const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const lines = content.split('\n');

lines.forEach((line, idx) => {
  if (line.includes("background") || line.includes("background-color")) {
    if (line.includes("body") || line.includes("html") || line.includes("app-layout") || line.includes("view-section") || line.includes("dashboard-view")) {
      console.log(`Line ${idx + 1}: ${line.trim()}`);
    } else {
      // Print context of lines containing layout background color rules
      const prev = lines[idx-1] || '';
      if (prev.includes("body") || prev.includes("html") || prev.includes("#app-layout") || prev.includes(".view-section")) {
        console.log(`Line ${idx + 1} (under ${prev.trim()}): ${line.trim()}`);
      }
    }
  }
});
