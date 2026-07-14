const https = require('https');

const bodies = [
  { q: 'PatheticCG' },
  { authorName: 'PatheticCG' },
  { author: 'PatheticCG' },
  { username: 'PatheticCG' },
  { authorUserName: 'PatheticCG' },
  { pageNumber: 1, pageSize: 5, authorName: 'PatheticCG' }
];

function tryBody(idx) {
  if (idx >= bodies.length) {
    console.log('All POST requests completed.');
    return;
  }
  const bodyObj = bodies[idx];
  const postData = JSON.stringify(bodyObj);
  
  const options = {
    hostname: 'api2.moxfield.com',
    path: '/v1/decks/search',
    method: 'POST',
    headers: {
      'User-Agent': 'Grimore/1.0 (grimore@lgs.com)',
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      console.log(`\nPOST Body: ${postData}`);
      console.log(`Status: ${res.statusCode}`);
      try {
        const parsed = JSON.parse(data);
        console.log('Keys:', Object.keys(parsed));
        if (parsed.totalResults !== undefined) {
          console.log('Total Results:', parsed.totalResults);
        }
        if (parsed.data && parsed.data.length > 0) {
          console.log('Creators:', parsed.data.map(d => d.createdByUser?.userName));
          console.log('Names:', parsed.data.map(d => d.name));
        } else {
          console.log('Snippet:', data.substring(0, 300));
        }
      } catch (e) {
        console.log('JSON Parse error. Raw snippet:', data.substring(0, 300));
      }
      setTimeout(() => tryBody(idx + 1), 1000);
    });
  });

  req.on('error', (e) => {
    console.error(e);
    tryBody(idx + 1);
  });

  req.write(postData);
  req.end();
}

tryBody(0);
