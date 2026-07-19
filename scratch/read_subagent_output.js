const fs = require('fs');
const filepath = 'C:\\Users\\772wa\\.gemini\\antigravity-ide\\brain\\db1068ce-150a-4d05-845d-086a70efb3e2\\.system_generated\\logs\\transcript_full.jsonl';
const content = fs.readFileSync(filepath, 'utf8');
const lines = content.split('\n');
console.log('Total lines:', lines.length);
for (let i = 0; i < Math.min(lines.length, 10); i++) {
  console.log(`Line ${i}:`, lines[i].substring(0, 150));
}
