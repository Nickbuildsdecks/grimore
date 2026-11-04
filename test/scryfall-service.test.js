const test = require('node:test');
const assert = require('node:assert');

const { fetchJson, importFilter, PLAYED_FORMATS } = require('../scryfallService');

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

/**
 * `importFilter` decides what the corpus **is**, which makes it the part of this service most worth
 * testing directly — and the part that was hardest to reach until it was lifted out of the import
 * loop, because the loop needs a database and a 500MB file.
 *
 * The goal it serves, in Nick's words: "every card in Magic the Gathering that is not… silly, no
 * uncards, cards that are legal in normal format, so like standard, legacy, modern, pauper,
 * commander, and like the actual played competitive formats."
 */
test('importFilter keeps a card legal in a format people play', () => {
  assert.strictEqual(importFilter({ legalities: { commander: 'legal' } }), true);
  assert.strictEqual(importFilter({ legalities: { pauper: 'legal' } }), true);
  // Restricted is legal, at one copy — which is what Vintage's list means.
  assert.strictEqual(importFilter({ legalities: { vintage: 'restricted' } }), true);
});

test('importFilter drops a card legal only in a format nobody brings to a table', () => {
  /*
    The change this test exists for. The old rule was "legal or restricted in ANY format Scryfall
    tracks", and the map also carries Alchemy, Historic, Timeless, Brawl, Oathbreaker and PreDH. A
    card that exists only in one of those passed a filter whose whole job is "would somebody bring
    this to a table" — and `digital` does not catch all of it, because a paper card rebalanced for
    Alchemy keeps its paper printing.
  */
  assert.strictEqual(
    importFilter({ legalities: { alchemy: 'legal', historic: 'legal' } }),
    'not-legal-anywhere-played',
  );
  assert.strictEqual(importFilter({ legalities: {} }), 'not-legal-anywhere-played');
  // Banned everywhere played is not legal anywhere played.
  assert.strictEqual(
    importFilter({ legalities: { commander: 'banned', legacy: 'banned' } }),
    'not-legal-anywhere-played',
  );
});

test('importFilter names which kind of thing it dropped, not just that it dropped one', () => {
  /*
    One total cannot tell "the dump was all tokens" from "the legality list got too narrow", and
    those are opposite bugs. The counter exists to make a broken import visible (D329); a reason per
    refusal is what lets it name which break happened.
  */
  const legal = { commander: 'legal' };
  assert.strictEqual(importFilter({ layout: 'token', legalities: legal }), 'not-a-card');
  assert.strictEqual(importFilter({ layout: 'emblem', legalities: legal }), 'not-a-card');
  assert.strictEqual(importFilter({ layout: 'art_series', legalities: legal }), 'not-a-card');
  assert.strictEqual(importFilter({ set_type: 'funny', legalities: legal }), 'funny-set');
  assert.strictEqual(
    importFilter({ border_color: 'silver', legalities: legal }), 'not-black-bordered',
  );
  assert.strictEqual(importFilter({ digital: true, legalities: legal }), 'digital-only');
});

test('importFilter keeps the multi-face layouts the engine supports', () => {
  /*
    `split`, `adventure`, `modal_dfc`, `transform` and `flip` are cards, and the engine has scripts
    for all five (#140, #141, #217). A layout filter that reached for "anything unusual" would drop
    them, so the exclusion list names the five non-card layouts rather than allow-listing the rest.
  */
  for (const layout of ['normal', 'split', 'adventure', 'modal_dfc', 'transform', 'flip']) {
    assert.strictEqual(
      importFilter({ layout, legalities: { commander: 'legal' } }), true, `${layout} was dropped`,
    );
  }
});

test('the played-format list is the seven named formats, spelled as Scryfall spells them', () => {
  /*
    A misspelled key reads as `undefined` and silently narrows the whole corpus — the failure this
    filter is least able to see from inside, since every card would simply be dropped with a
    plausible-looking reason. Pinned as a list so a typo is a failing test rather than an empty
    import.
  */
  assert.deepStrictEqual(
    [...PLAYED_FORMATS].sort(),
    ['commander', 'legacy', 'modern', 'pauper', 'pioneer', 'standard', 'vintage'],
  );
  for (const format of PLAYED_FORMATS) {
    assert.strictEqual(importFilter({ legalities: { [format]: 'legal' } }), true, format);
  }
});
