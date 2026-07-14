const https = require('https');

const params = [
  'userName=PatheticCG',
  'username=PatheticCG',
  'user=PatheticCG',
  'authorName=PatheticCG'
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
        console.log(`Param: ?${param} -> totalResults: ${parsed.totalResults}`);
        if (parsed.data && parsed.data.length > 0) {
          console.log(`Creators:`, parsed.data.map(d => d.createdByUser?.userName));
        }
      } catch (e) {
        console.log(`Param: ?${param} -> parse error`);
      }
      setTimeout(() => tryParam(idx + 1), 1000);
    });
  });
  req.on('error', (e) => {
    console.error(e);
    tryParam(idx + 1);
  });
  req.end();
}

tryParam(0);
