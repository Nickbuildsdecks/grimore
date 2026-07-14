const https = require('https');

const params = [
  'authorUserName=PatheticCG',
  'authorUsername=PatheticCG',
  'authorUsernames=PatheticCG',
  'authorUserNames=PatheticCG',
  'createdBy=PatheticCG',
  'owner=PatheticCG',
  'ownerName=PatheticCG',
  'creator=PatheticCG',
  'userId=PatheticCG',
  'userNames=PatheticCG',
  'users=PatheticCG',
  'authorUserName=patheticcg',
  'authorUsername=patheticcg',
  'authorUsernames=patheticcg',
  'authorUserNames=patheticcg'
];

function tryParam(idx) {
  if (idx >= params.length) {
    console.log('All parameters tested.');
    return;
  }
  const param = params[idx];
  const options = {
    hostname: 'api2.moxfield.com',
    path: `/v2/decks/search?${param}&pageNumber=1&pageSize=5&sortType=updated&sortDirection=Descending`,
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
      try {
        const parsed = JSON.parse(data);
        console.log(`Param: ?${param} -> Status: ${res.statusCode}, totalResults: ${parsed.totalResults}`);
        if (parsed.data && parsed.data.length > 0) {
          console.log(`  Creators:`, [...new Set(parsed.data.map(d => d.createdByUser?.userName))]);
          console.log(`  Deck Names:`, parsed.data.map(d => d.name));
        }
      } catch (e) {
        console.log(`Param: ?${param} -> Status: ${res.statusCode}, parse error`);
      }
      setTimeout(() => tryParam(idx + 1), 1000);
    });
  });
  req.on('error', (e) => {
    console.error(`Error with ?${param}:`, e.message);
    tryParam(idx + 1);
  });
  req.end();
}

tryParam(0);
