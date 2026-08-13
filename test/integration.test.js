const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const baseUrl = 'http://127.0.0.1:3000';

function requestJson(path, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const reqOptions = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch (e) {
          json = data;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

test('GET /api/auth/me returns non-logged in status initially', async () => {
  const res = await requestJson('/api/auth/me');
  assert.equal(res.status, 200);
  assert.equal(res.body.loggedIn, false);
});

// Credentials come from the environment — never commit a real account's password.
// If TEST_USER/TEST_PASS are not set, this test is skipped rather than exercising a
// hardcoded production login.
test('POST /api/auth/login validates credentials and sets session', { skip: !process.env.TEST_USER || !process.env.TEST_PASS }, async () => {
  const res = await requestJson('/api/auth/login', {
    method: 'POST',
    body: { username: process.env.TEST_USER, password: process.env.TEST_PASS }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.user.username, process.env.TEST_USER);
});

test('GET /api/decks/discover returns public community decks array', async () => {
  const res = await requestJson('/api/decks/discover');
  assert.equal(res.status, 200);
  assert(Array.isArray(res.body), 'Discover feed must return an array');
});

test('GET /api/decks/my-decks requires login session', async () => {
  const res = await requestJson('/api/decks/my-decks');
  assert.equal(res.status, 401);
});

test('GET /api/cards/search handles Scryfall query parameters', async () => {
  const res = await requestJson('/api/cards/search?q=Sol+Ring');
  assert.equal(res.status, 200);
  assert(Array.isArray(res.body.cards) || Array.isArray(res.body), 'Search response contains cards array');
});

test('GET /api/recommendations returns structured candidate list', async () => {
  const res = await requestJson('/api/recommendations?deckId=d_1782861745554_mz7oxa5z0');
  assert.equal(res.status, 200);
});

// NOTE: These tests are read-only and create no decks, so there is nothing to tear down.
// The previous teardown ran `DELETE FROM decks WHERE deck_name LIKE '%test%' OR id LIKE '%test%'`,
// which — against the live DB these tests hit — deleted real users' decks ("Greatest Hits",
// "Contest Winner", etc.). Never delete by name/id substring. If a future test creates data,
// track the exact IDs it created and delete only those, and point the suite at a throwaway DB.
