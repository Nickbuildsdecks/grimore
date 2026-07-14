const fs = require('fs');
const logPath = 'C:\\Users\\772wa\\.gemini\\antigravity\\brain\\a46f7c8a-3787-41de-aed1-8f3c5c03da8c\\.system_generated\\logs\\transcript_full.jsonl';

if (!fs.existsSync(logPath)) {
  console.log('Log not found');
  process.exit(1);
}

const lines = fs.readFileSync(logPath, 'utf8').split('\n');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('circles.forEach') && line.includes('VIEW_FILE')) {
    const obj = JSON.parse(line);
    console.log("FOUND STEP FOR circles.forEach VIEW_FILE:", obj.step_index);
    console.log(obj.content);
    break;
  }
}
