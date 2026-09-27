const test = require('node:test');
const assert = require('node:assert');

const { fetchJson } = require('../scryfallService');

/**
 * `fetchJson` used to ignore the status code entirely, handing every response body — a JSON error, a
 * proxy's HTML page, a 429 — straight to `JSON.parse`. When the body was not JSON the caller got a
 * bare `SyntaxError: Unexpected token '<'` naming neither the URL nor the status, which is exactly
 * what the startup log showed on 2026-09-26 and exactly what is useless when diagnosing it.
 *
 * These run against live hosts. `api.scryfall.com` is blocked from this environment, so the error
 * paths are exercised against Google's token endpoints, which are reachable and return a
 * well-defined 400 for a malformed request. Nothing here depends on Google specifically — only on
 * having some host that reliably answers with a non-2xx.
 */
test('fetchJson rejects a non-2xx response instead of parsing its body', async () => {
  // A malformed request; Google answers 400 with a JSON error document.
  const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=not-a-real-token';
  await assert.rejects(
    () => fetchJson(url),
    (err) => {
      assert.ok(err instanceof Error, 'rejects with an Error');
      assert.match(err.message, /HTTP 400/, 'names the status');
      assert.ok(err.message.includes(url), 'names the URL');
      // A slice of the body is kept: Scryfall's error carries a `details` field worth reading.
      assert.match(err.message, /invalid_token/, 'keeps enough of the body to be useful');
      return true;
    },
  );
});

test('fetchJson resolves a 2xx JSON body', async () => {
  // Google's JWKS document: a stable, public, genuinely-JSON 200.
  const body = await fetchJson('https://www.googleapis.com/oauth2/v3/certs');
  assert.ok(body && typeof body === 'object', 'parsed into an object');
  assert.ok(Array.isArray(body.keys), 'looks like the document we asked for');
});

test('fetchJson names the host when the request never completes', async () => {
  const url = 'https://this-host-does-not-exist.invalid/whatever.json';
  await assert.rejects(
    () => fetchJson(url),
    (err) => {
      assert.ok(err.message.includes(url), 'names the URL rather than only the DNS error');
      return true;
    },
  );
});
