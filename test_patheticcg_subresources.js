const https = require('https');

const paths = [
  '/v1/users/patheticcg/decks/public',
  '/v2/users/patheticcg/decks/public',
  '/v1/users/PatheticCG/decks/public',
  '/v2/users/PatheticCG/decks/public',
  '/v1/users/patheticcg/decks',
  '/v2/users/patheticcg/decks'
];

function tryPath(idx) {
  if (idx >= paths.length) {
    console.log('All paths tested.');
    return;
  }
  const path = paths[idx];
  const options = {
    hostname: 'api2.moxfield.com',
    path: path,
    method: 'GET',
    headers: {
      'User-Agent': 'Grimore/1.0 (grimore@lgs.com)',
      'Accept': 'application/json'
    }
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      console.log(`Path: ${path} -> Status: ${res.statusCode}`);
      if (res.statusCode === 200) {
        try {
          const parsed = JSON.parse(data);
          console.log('Keys:', Object.keys(parsed));
          console.log('Snippet:', data.substring(0, 300));
        } catch (e) {
          console.log('JSON Parse error. Raw snippet:', data.substring(0, 300));
        }
      }
      setTimeout(() => tryPath(idx + 1), 1000);
    });
  });
  req.on('error', (e) => {
    console.error(e);
    tryPath(idx + 1);
  });
  req.end();
}

tryPath(0);
