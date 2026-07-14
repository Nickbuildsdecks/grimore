const sqlite3 = require('sqlite3').verbose();
const dbPath = 'C:\\Users\\772wa\\.gemini\\antigravity\\conversations\\a46f7c8a-3787-41de-aed1-8f3c5c03da8c.db';

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('Error opening database:', err);
    process.exit(1);
  }
});

// Let's get steps 36965, 36962, 36954, 36883, 36679
db.all("SELECT idx, step_payload FROM steps WHERE idx IN (36679, 36883, 36954, 36962, 36965);", [], (err, rows) => {
  if (err) {
    console.error(err);
    db.close();
    return;
  }
  
  for (const row of rows) {
    console.log(`\n================ STEP ${row.idx} ================`);
    if (row.step_payload) {
      const payload = row.step_payload;
      console.log('Payload size:', payload.length);
      // Let's print out the printable string segments of length > 3
      const textMatches = [];
      let currentStr = '';
      for (let i = 0; i < payload.length; i++) {
        const c = payload[i];
        if (c >= 32 && c <= 126) {
          currentStr += String.fromCharCode(c);
        } else {
          if (currentStr.length > 3) {
            textMatches.push(currentStr);
          }
          currentStr = '';
        }
      }
      if (currentStr.length > 3) {
        textMatches.push(currentStr);
      }
      
      console.log('Printable strings:');
      console.log(textMatches.filter(s => s.trim().length > 0).slice(0, 30));
    }
  }
  db.close();
});
