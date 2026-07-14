const https = require('https');

function testDomain(domain) {
  const options = {
    hostname: domain,
    path: '/v2/decks/search?authorName=PatheticCG&pageNumber=1&pageSize=5&sortType=updated&sortDirection=Descending',
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
      console.log(`Domain: ${domain} -> Status Code: ${res.statusCode}`);
      try {
        const parsed = JSON.parse(data);
        console.log(`Total Results: ${parsed.totalResults}`);
        if (parsed.data) {
          console.log(`Creators:`, parsed.data.map(d => d.createdByUser?.userName));
        }
      } catch (e) {
        console.log('JSON Parse error');
      }
    });
  });
  req.on('error', (e) => {
    console.error(`Error on ${domain}:`, e.message);
  });
  req.end();
}

testDomain('api.moxfield.com');
testDomain('api2.moxfield.com');
