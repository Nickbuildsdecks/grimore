/**
 * Legacy routes, exercised against a real Postgres database.
 *
 * Production runs `server.js` on Postgres. Every other legacy test runs it on SQLite, and `db.js`
 * builds a *different* table under the same name for each dialect -- `follows` has `following_id`
 * on Postgres and `followed_id` on SQLite, `collection_cards` has `foil` against `is_foil`. So a
 * route can be green in CI and 500 for every real user, which is how the divergence catalogued in
 * claude/postgres-schema-gap-2026-09-27.md accumulated unnoticed.
 *
 * This suite closes that hole for the write paths it covers: it boots the actual server against a
 * throwaway Postgres database, drives the routes over HTTP the way a browser does, and then reads
 * the rows back with SQL to confirm the write landed rather than trusting a 200.
 *
 * Skipped, not failed, when POSTGRES_TEST_URL is unset, so `npm run test:unit` on a developer
 * machine with no Postgres is unaffected.
 *
 *   POSTGRES_TEST_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres \
 *     node --test test/postgres-write-paths.test.js
 *
 * The URL names any database on the server; the suite creates and drops its own.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const net = require('node:net');

const ADMIN_URL = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
const ROOT = join(__dirname, '..');
// One name per run, so a crashed earlier run cannot leave a database this one inherits.
const DB_NAME = `legacy_writes_${process.pid}_${Date.now()}`;

let pg; // required lazily: absent from a SQLite-only install
let server;
let port;
let baseUrl;
let adminClient;
let appClient;

function describeSkip() {
  if (!ADMIN_URL) return 'POSTGRES_TEST_URL not set';
  try {
    pg = require('pg');
  } catch {
    return 'the pg package is not installed';
  }
  return false;
}
const skip = describeSkip();

// A suite that skips itself is indistinguishable from a suite that passes, and this one exists
// precisely because a green check hid a broken route for months. On CI a missing database is a
// misconfigured job, not a machine without Postgres, so fail loudly instead of reporting 7 skips as
// success.
if (skip && process.env.CI) {
  throw new Error(
    `test/postgres-write-paths.test.js cannot run on CI: ${skip}. ` +
      'Set POSTGRES_TEST_URL, or remove the job -- do not let it pass by skipping.',
  );
}

/** A free port, asked of the OS rather than guessed, so parallel runs cannot collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
  });
}

/**
 * Every client gets its own apparent source address.
 *
 * `/api/auth` is rate-limited to 20 attempts per client per 15 minutes, and the server runs with
 * `trust proxy 1` so the bucket is keyed on X-Forwarded-For -- which is how it works in production
 * behind Caddy. Sending a distinct value per client uses that same path rather than working around
 * it, and it means adding a test cannot silently push the suite over a shared ceiling and start
 * failing with 429s that look nothing like the bug under test.
 *
 * If a change ever removes `trust proxy`, every client collapses into one bucket and this suite
 * starts reporting 429 from `newPlayer` -- that is the symptom to recognise, not a flake.
 */
let clientSeq = 0;
function nextForwardedFor() {
  clientSeq += 1;
  return `10.77.${Math.floor(clientSeq / 250)}.${(clientSeq % 250) + 1}`;
}

/**
 * Minimal cookie-jar HTTP client. The session cookie is the whole point -- every route under test
 * is behind `req.session.player`, so a client that drops Set-Cookie tests only the 401 path.
 */
function makeClient() {
  const jar = new Map();
  const forwardedFor = nextForwardedFor();
  return function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: options.method || 'GET',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Forwarded-For': forwardedFor,
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        (res) => {
          for (const raw of res.headers['set-cookie'] || []) {
            const [pair] = raw.split(';');
            const i = pair.indexOf('=');
            jar.set(pair.slice(0, i), pair.slice(i + 1));
          }
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            let body = null;
            try {
              body = data ? JSON.parse(data) : null;
            } catch {
              body = data;
            }
            resolve({ status: res.statusCode, body });
          });
        },
      );
      req.on('error', reject);
      if (options.body) req.write(JSON.stringify(options.body));
      req.end();
    });
  };
}

/**
 * The database is built the way a post-cutover production box is: the v2 baseline, then every
 * migration, then whatever `initDb()` adds when the server boots. The migrations are included
 * because without them seven tables the app writes do not exist at all, which masks the column
 * mismatches this suite is here to catch behind an earlier "relation does not exist".
 */
async function buildDatabase() {
  const { Client } = pg;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB_NAME}`;
  const dbUrl = url.toString();

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const migrations = join(ROOT, 'packages/db/migrations');
  for (const file of readdirSync(migrations).sort()) {
    if (!file.endsWith('.sql')) continue;
    await client.query(readFileSync(join(migrations, file), 'utf8'));
  }
  await client.end();
  return dbUrl;
}

test.before(async () => {
  if (skip) return;
  const dbUrl = await buildDatabase();
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      POSTGRES_URL: dbUrl,
      PORT: String(port),
      NODE_ENV: 'test',
      SESSION_SECRET: 'postgres-write-paths-suite-secret-value',
      // The server falls back to an in-memory session store without this, which is what we want:
      // the suite is about SQL, not Redis.
      REDIS_URL: '',
      // Without this the boot chain downloads the whole oracle-cards dump before the tasks after it
      // run, which both wastes CI minutes and makes the sanitizer assertion below race the download.
      SKIP_SCRYFALL_BULK_SYNC: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  server.stdout.on('data', (d) => log.push(String(d)));
  server.stderr.on('data', (d) => log.push(String(d)));
  server.serverLog = log;

  // initDb() runs after listen(), so a reachable port is not readiness. Poll a route that touches
  // nothing until it answers.
  const probe = makeClient();
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const res = await probe('/api/auth/me');
      if (res.status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`server did not become ready:\n${log.join('')}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  // The boot chain is fire-and-forget in server.js, and "Database initialized successfully" is
  // logged partway through it -- before the Scryfall sync and the deck_cards sanitizer. Waiting for
  // the last line instead means the schema is settled AND the sanitizer has actually run, so the
  // assertion about it later is not vacuously true.
  const initDeadline = Date.now() + 60000;
  while (!log.join('').includes('Startup tasks complete')) {
    if (Date.now() > initDeadline) throw new Error(`boot never completed:\n${log.join('')}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  const { Client } = pg;
  appClient = new Client({ connectionString: dbUrl });
  await appClient.connect();
  adminClient = new Client({ connectionString: ADMIN_URL });
  await adminClient.connect();
});

test.after(async () => {
  if (skip) return;
  if (appClient) await appClient.end();
  if (server && !server.killed) {
    server.kill('SIGKILL');
    await new Promise((r) => server.once('exit', r));
  }
  if (adminClient) {
    await adminClient.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await adminClient.end();
  }
});

/** A registered, logged-in player, with its own cookie jar. */
async function newPlayer(tag) {
  const client = makeClient();
  const username = `wp_${tag}_${Math.random().toString(36).slice(2, 8)}`;
  const reg = await client('/api/auth/register', {
    method: 'POST',
    body: {
      username,
      password: 'Sufficiently-Long-Pass-9',
      storeNickname: `Tester ${tag}`,
      email: `${username}@example.test`,
    },
  });
  assert.equal(reg.status, 200, `register ${tag}: ${JSON.stringify(reg.body)}`);
  // Registration deliberately does not start a session ("You can now log in"), so the cookie this
  // client needs comes from an explicit login.
  const login = await client('/api/auth/login', {
    method: 'POST',
    body: { username, password: 'Sufficiently-Long-Pass-9' },
  });
  assert.equal(login.status, 200, `login ${tag}: ${JSON.stringify(login.body)}`);
  const row = await appClient.query('SELECT id FROM players WHERE username = $1', [
    username.toLowerCase(),
  ]);
  assert.equal(row.rows.length, 1, `register ${tag} wrote no players row`);
  return { client, username, id: row.rows[0].id };
}

/**
 * A deck row, inserted directly. The deck-creation route imports from Moxfield over the network,
 * which a test must not depend on; the league routes only need a deck to point at.
 */
async function seedDeck(playerId, name) {
  const id = `deck_${Math.random().toString(36).slice(2, 10)}`;
  await appClient.query(
    'INSERT INTO decks (id, player_id, deck_name, moxfield_url) VALUES ($1, $2, $3, $4)',
    [id, playerId, name, `https://example.test/${id}`],
  );
  return id;
}

/**
 * An active season with one completed-pending pod and a pod_results row per entrant.
 *
 * Seeded with SQL rather than driven through /api/pairings/generate, which needs an organiser
 * session and at least three checked-in players. The statements under test are the two standings
 * rebuilds, and this is the state they run against.
 *
 * Only one season may be active at a time as far as the routes are concerned -- they all read
 * `WHERE is_active = 1` and take the first row -- so any earlier season is stood down first.
 */
async function seedPod(entrants) {
  const seasonId = `season_${Math.random().toString(36).slice(2, 10)}`;
  await appClient.query('UPDATE seasons SET is_active = 0 WHERE is_active = 1');
  await appClient.query('INSERT INTO seasons (id, name, is_active) VALUES ($1, $2, 1)', [
    seasonId,
    `Write-path season ${seasonId}`,
  ]);
  const podId = `pod_${Math.random().toString(36).slice(2, 10)}`;
  await appClient.query(
    'INSERT INTO pods (id, season_id, round_num, pod_label) VALUES ($1, $2, 1, 1)',
    [podId, seasonId],
  );
  for (const e of entrants) {
    await appClient.query(
      'INSERT INTO pod_results (pod_id, player_id, deck_id) VALUES ($1, $2, $3)',
      [podId, e.playerId, e.deckId],
    );
  }
  return { seasonId, podId };
}

test('following a player writes a follows row on Postgres', { skip }, async () => {
  const a = await newPlayer('a');
  const b = await newPlayer('b');

  const res = await a.client(`/api/players/${b.id}/follow`, { method: 'POST' });
  assert.equal(res.status, 200, `follow returned ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.following, true);

  // The row, not the status code. `db.js` gives Postgres a `following_id` column where SQLite has
  // `followed_id`, so a route written against the SQLite name fails here and nowhere else.
  const { rows } = await appClient.query(
    'SELECT follower_id, following_id FROM follows WHERE follower_id = $1',
    [a.id],
  );
  assert.deepEqual(rows, [{ follower_id: a.id, following_id: b.id }]);

  const check = await a.client(`/api/players/${b.id}/following`);
  assert.equal(check.status, 200);
  assert.equal(check.body.following, true, 'the follow state must read back');
});

test('unfollowing removes the row', { skip }, async () => {
  const a = await newPlayer('c');
  const b = await newPlayer('d');
  await a.client(`/api/players/${b.id}/follow`, { method: 'POST' });

  const off = await a.client(`/api/players/${b.id}/follow`, { method: 'POST' });
  assert.equal(off.status, 200, `unfollow returned ${off.status}: ${JSON.stringify(off.body)}`);
  assert.equal(off.body.following, false);

  const { rows } = await appClient.query('SELECT 1 FROM follows WHERE follower_id = $1', [a.id]);
  assert.equal(rows.length, 0);
});

test('adding a card to a collection writes a collection_cards row', { skip }, async () => {
  const p = await newPlayer('e');
  const created = await p.client('/api/collections', {
    method: 'POST',
    body: { name: 'Write-path shoebox' },
  });
  assert.equal(created.status, 200, `create collection: ${JSON.stringify(created.body)}`);
  const collectionId = created.body.collectionId;

  const added = await p.client(`/api/collections/${collectionId}/cards`, {
    method: 'POST',
    body: { cardName: 'Sol Ring', quantity: 2, isFoil: true, condition: 'NM', language: 'EN' },
  });
  assert.equal(added.status, 200, `add card returned ${added.status}: ${JSON.stringify(added.body)}`);

  // Postgres spells the column `foil`; SQLite spells it `is_foil`.
  const { rows } = await appClient.query(
    'SELECT card_name, quantity, foil, condition, language FROM collection_cards WHERE collection_id = $1',
    [collectionId],
  );
  assert.equal(rows.length, 1, 'exactly one row for one card');
  assert.equal(rows[0].card_name, 'Sol Ring');
  assert.equal(Number(rows[0].quantity), 2);
  assert.equal(Number(rows[0].foil), 1, 'the foil flag must survive the write');
});

test('adding the same card again increments instead of duplicating', { skip }, async () => {
  const p = await newPlayer('f');
  const created = await p.client('/api/collections', {
    method: 'POST',
    body: { name: 'Upsert shoebox' },
  });
  const collectionId = created.body.collectionId;
  const card = { cardName: 'Arcane Signet', quantity: 1, isFoil: false };

  for (const _ of [1, 2]) {
    const res = await p.client(`/api/collections/${collectionId}/cards`, {
      method: 'POST',
      body: card,
    });
    assert.equal(res.status, 200, `add card: ${JSON.stringify(res.body)}`);
  }

  // The upsert names a conflict target. Postgres rejects a target that does not match a real
  // constraint, so this asserts the ON CONFLICT clause, not just the column names.
  const { rows } = await appClient.query(
    'SELECT quantity FROM collection_cards WHERE collection_id = $1',
    [collectionId],
  );
  assert.equal(rows.length, 1, 'the second add must not create a second row');
  assert.equal(Number(rows[0].quantity), 2);
});

test('deleting a collection and restoring it round-trips the cards', { skip }, async () => {
  const p = await newPlayer('g');
  const created = await p.client('/api/collections', {
    method: 'POST',
    body: { name: 'Round-trip shoebox' },
  });
  const collectionId = created.body.collectionId;
  await p.client(`/api/collections/${collectionId}/cards`, {
    method: 'POST',
    body: { cardName: 'Mana Crypt', quantity: 3, isFoil: true, condition: 'LP', language: 'JA' },
  });

  const removed = await p.client(`/api/collections/${collectionId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200, `delete: ${JSON.stringify(removed.body)}`);

  const recovery = await p.client('/api/recovery/deleted-items');
  assert.equal(recovery.status, 200, `recovery list: ${JSON.stringify(recovery.body)}`);
  const item = recovery.body.items.find((i) => i.item_id === collectionId);
  assert.ok(item, 'the deleted collection must be recoverable');

  const restored = await p.client(`/api/recovery/restore/${item.id}`, { method: 'POST' });
  assert.equal(restored.status, 200, `restore: ${JSON.stringify(restored.body)}`);

  // The archive is written with SELECT *, so it carries the dialect's own column names. The restore
  // has to read them back under whichever spelling it finds and write the local one.
  const { rows } = await appClient.query(
    'SELECT card_name, quantity, foil, condition, language FROM collection_cards WHERE collection_id = $1',
    [collectionId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].card_name, 'Mana Crypt');
  assert.equal(Number(rows[0].quantity), 3);
  assert.equal(Number(rows[0].foil), 1, 'the foil flag must survive delete and restore');
  assert.equal(rows[0].condition, 'LP');
  assert.equal(rows[0].language, 'JA');
});

test('a follow notifies the followed player', { skip }, async () => {
  const a = await newPlayer('h');
  const b = await newPlayer('i');
  const res = await a.client(`/api/players/${b.id}/follow`, { method: 'POST' });
  assert.equal(res.status, 200);

  // The follow route writes a notification straight after the follows row. On Postgres
  // `notifications.id` is a sequence and `type` is NOT NULL, so this asserts that too.
  const { rows } = await appClient.query(
    'SELECT title, message FROM notifications WHERE player_id = $1',
    [b.id],
  );
  const follow = rows.find((r) => r.title === 'New Follower');
  assert.ok(follow, `no follow notification: ${JSON.stringify(rows)}`);
  assert.match(follow.message, /started following you/);
});

test('the boot-time deck_cards sanitizer runs without error on Postgres', { skip }, async () => {
  // It joins scryfall_cards on the UUID column, which is named differently per dialect, and it
  // swallows its own errors into a console line -- so the only way it can be seen to work is to
  // read the log the server produced at boot.
  const log = server.serverLog.join('');
  assert.doesNotMatch(
    log,
    /\[DB Sanitize\] Error/,
    'the sanitizer failed at boot; see the [DB Sanitize] line',
  );
});

// ---------------------------------------------------------------------------------------------
// League: check-in and the standings rebuild.
//
// These are `INSERT OR REPLACE`, SQLite-only, a syntax error at "OR" on Postgres. The constraints
// they now target are real ones -- active_roster's primary key, and the partial unique indexes
// migration 0009 creates -- which is why they could be fixed without a schema change. The suite has
// to prove the ON CONFLICT targets resolve, because a wrong one is rejected outright.
// ---------------------------------------------------------------------------------------------

test('checking in writes one active_roster row, and re-checking in replaces it', { skip }, async () => {
  const p = await newPlayer('j');
  const deck = await seedDeck(p.id, 'Roster Deck');

  let res = await p.client('/api/roster/checkin', { method: 'POST', body: { deckId: deck } });
  assert.equal(res.status, 200, `check-in returned ${res.status}: ${JSON.stringify(res.body)}`);

  let rows = await appClient.query(
    'SELECT deck_id, checked_in FROM active_roster WHERE player_id = $1',
    [p.id],
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].deck_id, deck);
  assert.equal(Number(rows.rows[0].checked_in), 1);

  // SQLite's REPLACE deletes and reinserts; ON CONFLICT DO UPDATE has to leave one row too.
  const other = await seedDeck(p.id, 'Second Roster Deck');
  res = await p.client('/api/roster/checkin', { method: 'POST', body: { deckId: other } });
  assert.equal(res.status, 200, `second check-in: ${JSON.stringify(res.body)}`);

  rows = await appClient.query('SELECT deck_id FROM active_roster WHERE player_id = $1', [p.id]);
  assert.equal(rows.rows.length, 1, 'a second check-in must replace, not duplicate');
  assert.equal(rows.rows[0].deck_id, other, 'the newer deck must win');

  const status = await p.client('/api/roster/status');
  assert.equal(status.body.checkedIn, true);
  assert.equal(status.body.deckId, other);
});

test('reporting a pod score rebuilds player and deck standings', { skip }, async () => {
  const a = await newPlayer('k');
  const b = await newPlayer('l');
  const deckA = await seedDeck(a.id, 'Standings Deck A');
  const deckB = await seedDeck(b.id, 'Standings Deck B');
  const { seasonId, podId } = await seedPod([
    { playerId: a.id, deckId: deckA },
    { playerId: b.id, deckId: deckB },
  ]);

  const res = await a.client(`/api/pairings/report/${podId}`, {
    method: 'POST',
    body: {
      results: [
        { player_id: a.id, kills: 2, placed_first: 1, placed_draw: 0 },
        { player_id: b.id, kills: 0, placed_first: 0, placed_draw: 0 },
      ],
    },
  });
  assert.equal(res.status, 200, `report returned ${res.status}: ${JSON.stringify(res.body)}`);

  // The rebuild is an upsert against a PARTIAL unique index. A target that does not restate the
  // index predicate is rejected outright, so reaching these rows at all is the assertion.
  const players = await appClient.query(
    'SELECT player_id, total_points, total_wins, total_kills, total_matches FROM player_stats WHERE season_id = $1 ORDER BY total_points DESC',
    [seasonId],
  );
  assert.equal(players.rows.length, 2, `expected both players: ${JSON.stringify(players.rows)}`);
  const winner = players.rows[0];
  assert.equal(winner.player_id, a.id, 'the pod winner leads on points');
  assert.equal(Number(winner.total_wins), 1);
  assert.equal(Number(winner.total_kills), 2);
  assert.equal(Number(winner.total_matches), 1);
  assert.ok(Number(winner.total_points) > Number(players.rows[1].total_points));

  const decks = await appClient.query(
    'SELECT deck_id, total_wins FROM deck_stats WHERE season_id = $1',
    [seasonId],
  );
  assert.equal(decks.rows.length, 2, `expected both decks: ${JSON.stringify(decks.rows)}`);
  assert.equal(
    Number(decks.rows.find((r) => r.deck_id === deckA).total_wins),
    1,
    'the winning deck records the win',
  );

  // Reporting again must update in place, not raise a duplicate-key error and not double the row
  // count -- the whole point of an upsert over a bare INSERT.
  const again = await a.client(`/api/pairings/report/${podId}`, {
    method: 'POST',
    body: {
      results: [
        { player_id: a.id, kills: 5, placed_first: 1, placed_draw: 0 },
        { player_id: b.id, kills: 0, placed_first: 0, placed_draw: 0 },
      ],
    },
  });
  assert.equal(again.status, 200, `second report: ${JSON.stringify(again.body)}`);
  const after = await appClient.query(
    'SELECT player_id, total_kills FROM player_stats WHERE season_id = $1',
    [seasonId],
  );
  assert.equal(after.rows.length, 2, 'a re-report must not add rows');
  assert.equal(
    Number(after.rows.find((r) => r.player_id === a.id).total_kills),
    5,
    'the corrected score must overwrite the old one',
  );
});
