const http = require('http');

function postJson(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch(e) {
          parsed = data; // fallback to raw string
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function run() {
  const testUser = `test_imp_${Date.now()}`;
  console.log(`Registering test user: ${testUser}`);

  const regRes = await postJson('/api/auth/register', {
    username: testUser,
    password: 'password123',
    email: `${testUser}@example.com`,
    storeNickname: 'ImporterTest'
  });

  console.log('Register response status:', regRes.statusCode);

  console.log(`Logging in test user: ${testUser}`);
  const loginRes = await postJson('/api/auth/login', {
    username: testUser,
    password: 'password123'
  });

  console.log('Login response status:', loginRes.statusCode);
  const cookie = loginRes.headers['set-cookie'] ? loginRes.headers['set-cookie'][0] : null;
  if (!cookie) {
    throw new Error("No session cookie returned on login!");
  }
  console.log("Session cookie retrieved:", cookie.split(';')[0]);

  console.log("Triggering Moxfield Account Import for 'patheticcg'...");
  const importRes = await postJson('/api/moxfield/import-account', {
    username: 'patheticcg'
  }, {
    'Cookie': cookie
  });

  console.log('Import response status:', importRes.statusCode);
  console.log('Import response body:', typeof importRes.body === 'string' ? importRes.body.substring(0, 500) : JSON.stringify(importRes.body, null, 2));
}

run().catch(console.error);
