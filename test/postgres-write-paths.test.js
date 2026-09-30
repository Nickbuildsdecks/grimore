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
const { readFileSync, readdirSync, existsSync } = require('node:fs');
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
  const request = function request(path, options = {}) {
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
  // The session cookie's current value, so a test can see whether logging in rotated it. Named rather
  // than reaching into the jar, because which cookie carries the session is the harness's business.
  request.sessionId = () => jar.get('grimore.sid') ?? jar.get('connect.sid') ?? null;
  return request;
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
      // Recovery mail: the console transport logs that a message went and withholds the body, so a send
      // succeeds without a provider and without putting a token in the log. The default transport throws,
      // which is correct for production and would fail these tests for the wrong reason.
      MAIL_TRANSPORT: 'console',
      // Link origins come from configuration, never the request Host header, so the routes refuse to
      // run without this.
      APP_BASE_URL: 'https://grimore.test',
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
  return { client, username, id: row.rows[0].id, sessionId: () => client.sessionId() };
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

/**
 * Grants a staff role by writing the column the route reads. The report route resolves roles from the
 * database rather than the session snapshot, so the grant takes effect without a fresh login -- which
 * is the point: revoking an organiser's role should lock them out at once, not at their next sign-in.
 */
async function grantRole(playerId, role) {
  await appClient.query('UPDATE players SET role = $1 WHERE id = $2', [role, playerId]);
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
  // Created before seedPod opens this test's season: registering a player also seeds a zeroed
  // player_stats row for whatever season is active, so making the organiser later would put a third
  // row in this season and the row-count assertion below would be measuring registration, not the
  // upsert. (That seeding is itself the season-two collision recorded in the schema-gap doc.)
  const organiser = await newPlayer('l2');
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

  // A reported pod is closed to the players who sat at it, so whoever lost cannot quietly rewrite it.
  const bySeated = await a.client(`/api/pairings/report/${podId}`, {
    method: 'POST',
    body: {
      results: [
        { player_id: a.id, kills: 9, placed_first: 1, placed_draw: 0 },
        { player_id: b.id, kills: 0, placed_first: 0, placed_draw: 0 },
      ],
    },
  });
  assert.equal(bySeated.status, 409, `a seated player re-reporting: ${JSON.stringify(bySeated.body)}`);

  // An organiser may still correct it. Nothing in either codebase can reopen a pod -- `completed` is
  // only ever set to 1 -- so refusing outright would leave a typo in the standings all season.
  //
  // The correction also exercises the upsert: it must update in place, not raise a duplicate-key
  // error and not double the row count, which is the whole point of an upsert over a bare INSERT.
  await grantRole(organiser.id, 'scorekeeper');
  const again = await organiser.client(`/api/pairings/report/${podId}`, {
    method: 'POST',
    body: {
      results: [
        { player_id: a.id, kills: 5, placed_first: 1, placed_draw: 0 },
        { player_id: b.id, kills: 0, placed_first: 0, placed_draw: 0 },
      ],
    },
  });
  assert.equal(again.status, 200, `organiser correction: ${JSON.stringify(again.body)}`);
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

  // The route read the season as `WHERE is_active = 1`, so once a season closed its pods could no
  // longer be corrected at all -- and while another season was open, a correction paid out THAT
  // season's points and rebuilt THAT season's board. It reads the pod's own season now.
  await appClient.query('UPDATE seasons SET is_active = 0 WHERE id = $1', [seasonId]);
  const closed = await organiser.client(`/api/pairings/report/${podId}`, {
    method: 'POST',
    body: {
      results: [
        { player_id: a.id, kills: 7, placed_first: 1, placed_draw: 0 },
        { player_id: b.id, kills: 0, placed_first: 0, placed_draw: 0 },
      ],
    },
  });
  assert.equal(closed.status, 200, `correcting a closed season's pod: ${JSON.stringify(closed.body)}`);
  const closedRows = await appClient.query(
    'SELECT total_kills FROM player_stats WHERE season_id = $1 AND player_id = $2',
    [seasonId, a.id],
  );
  assert.equal(
    Number(closedRows.rows[0].total_kills),
    7,
    "the correction must score the pod's own season, not whichever one happens to be active",
  );
});

test('a score report refuses anyone not seated at the pod or running the event', { skip }, async () => {
  const a = await newPlayer('k3');
  const b = await newPlayer('l3');
  const outsider = await newPlayer('m3');
  const deckA = await seedDeck(a.id, 'Report Auth Deck A');
  const deckB = await seedDeck(b.id, 'Report Auth Deck B');
  const { podId } = await seedPod([
    { playerId: a.id, deckId: deckA },
    { playerId: b.id, deckId: deckB },
  ]);
  const report = (client, results) =>
    client(`/api/pairings/report/${podId}`, { method: 'POST', body: { results } });
  const good = [
    { player_id: a.id, kills: 1, placed_first: 1, placed_draw: 0 },
    { player_id: b.id, kills: 0, placed_first: 0, placed_draw: 0 },
  ];

  // This route had no authentication of any kind. Anyone who could reach the server could post
  // arbitrary results for any pod in any season, award themselves points and rewrite the standings.
  const anon = await report(makeClient(), good);
  assert.equal(anon.status, 401, `anonymous report: ${JSON.stringify(anon.body)}`);

  // Signed in, but not at this table and not running the event.
  const stranger = await report(outsider.client, good);
  assert.equal(stranger.status, 403, `outsider report: ${JSON.stringify(stranger.body)}`);

  const untouched = await appClient.query('SELECT completed FROM pods WHERE id = $1', [podId]);
  assert.equal(Number(untouched.rows[0].completed), 0, 'a refused report must write nothing');

  // A report may only name players who are actually at this table...
  const foreign = await report(a.client, [
    { player_id: a.id, kills: 0, placed_first: 1, placed_draw: 0 },
    { player_id: outsider.id, kills: 0, placed_first: 0, placed_draw: 0 },
  ]);
  assert.equal(foreign.status, 400, `foreign player in results: ${JSON.stringify(foreign.body)}`);

  // ...and may not describe a game that cannot have happened.
  const twoWinners = await report(a.client, [
    { player_id: a.id, kills: 0, placed_first: 1, placed_draw: 0 },
    { player_id: b.id, kills: 0, placed_first: 1, placed_draw: 0 },
  ]);
  assert.equal(twoWinners.status, 400, `two winners: ${JSON.stringify(twoWinners.body)}`);
  const winAndDraw = await report(a.client, [
    { player_id: a.id, kills: 0, placed_first: 1, placed_draw: 0 },
    { player_id: b.id, kills: 0, placed_first: 0, placed_draw: 1 },
  ]);
  assert.equal(winAndDraw.status, 400, `a winner and a draw: ${JSON.stringify(winAndDraw.body)}`);
  const badKills = await report(a.client, [{ player_id: a.id, kills: 'lots', placed_first: 1 }]);
  assert.equal(badKills.status, 400, `non-numeric kills: ${JSON.stringify(badKills.body)}`);

  // A report must cover the whole table. Without this, one player could report only themselves as the
  // winner -- which completes the pod, leaves everyone else on zero, and, because a reported pod is
  // closed to the players, cannot then be corrected by the rest of the table.
  const partial = await report(a.client, [{ player_id: a.id, kills: 2, placed_first: 1, placed_draw: 0 }]);
  assert.equal(partial.status, 400, `a one-seat report: ${JSON.stringify(partial.body)}`);
  const twice = await report(a.client, [
    { player_id: a.id, kills: 0, placed_first: 1, placed_draw: 0 },
    { player_id: a.id, kills: 0, placed_first: 0, placed_draw: 0 },
  ]);
  assert.equal(twice.status, 400, `the same player named twice: ${JSON.stringify(twice.body)}`);

  // The dashboard's self-report form posts a bare { kills, placedFirst, placedDraw } with no results
  // array at all, which used to reach `for (let r of results)` on undefined and answer 500.
  const shapeless = await a.client(`/api/pairings/report/${podId}`, {
    method: 'POST',
    body: { kills: 1, placedFirst: 1, placedDraw: 0 },
  });
  assert.equal(shapeless.status, 400, `no results array: ${JSON.stringify(shapeless.body)}`);

  const stillUntouched = await appClient.query('SELECT completed FROM pods WHERE id = $1', [podId]);
  assert.equal(Number(stillUntouched.rows[0].completed), 0, 'no rejected report may complete the pod');

  // A player seated at the pod may report it.
  assert.equal((await report(a.client, good)).status, 200);

  // And the outsider who was refused above can report it once given a role -- read from the database,
  // so no fresh login is needed -- including correcting a pod that has already been reported.
  await grantRole(outsider.id, 'judge');
  const corrected = await report(outsider.client, [
    { player_id: a.id, kills: 0, placed_first: 0, placed_draw: 0 },
    { player_id: b.id, kills: 4, placed_first: 1, placed_draw: 0 },
  ]);
  assert.equal(corrected.status, 200, `organiser correction: ${JSON.stringify(corrected.body)}`);
  const seats = await appClient.query(
    'SELECT player_id, kills, placed_first FROM pod_results WHERE pod_id = $1',
    [podId],
  );
  const winner = seats.rows.find((r) => Number(r.placed_first) === 1);
  assert.equal(winner.player_id, b.id, 'the correction must move the win');
  assert.equal(Number(winner.kills), 4);
});

// ---------------------------------------------------------------------------------------------
// The price cache. `INSERT OR REPLACE` with nothing to upsert against on Postgres, so this write
// has never landed there. Migration 0013 deduplicates the table and adds UNIQUE (LOWER(card_name)),
// the expression every reader already joins on.
// ---------------------------------------------------------------------------------------------

test('repricing a card feeds the shared price cache', { skip }, async () => {
  const p = await newPlayer('m');
  const deckId = await seedDeck(p.id, 'Reprice Deck');
  await appClient.query(
    'INSERT INTO deck_cards (deck_id, card_name, quantity, cheapest_card_price) VALUES ($1, $2, 1, $3)',
    [deckId, 'Cultivate', 0.42],
  );

  const res = await p.client('/api/decks/reprice-card', {
    method: 'POST',
    body: { deckId, cardName: 'Cultivate' },
  });
  assert.equal(res.status, 200, `reprice returned ${res.status}: ${JSON.stringify(res.body)}`);

  const { rows } = await appClient.query(
    'SELECT card_name, price, cached_at FROM card_price_cache WHERE LOWER(card_name) = LOWER($1)',
    ['Cultivate'],
  );
  assert.equal(rows.length, 1, `expected one cache row: ${JSON.stringify(rows)}`);
  assert.ok(Number(rows[0].price) > 0, 'a price must actually be cached');
  assert.ok(rows[0].cached_at, 'cached_at is the Postgres column; last_updated does not exist here');
});

test('repricing the same card again updates the cache row in place', { skip }, async () => {
  const p = await newPlayer('n');
  const deckId = await seedDeck(p.id, 'Reprice Twice Deck');
  await appClient.query(
    'INSERT INTO deck_cards (deck_id, card_name, quantity, cheapest_card_price) VALUES ($1, $2, 1, $3)',
    [deckId, 'Rampant Growth', 1.11],
  );
  await p.client('/api/decks/reprice-card', {
    method: 'POST',
    body: { deckId, cardName: 'Rampant Growth' },
  });

  // Case differs on purpose, and it exercises two things at once. The cache's conflict target is
  // LOWER(card_name), so this must collide with the row above rather than insert a second one -- a
  // duplicate is what makes the readers' LEFT JOIN fan out. And the route's own deck_cards lookup
  // used to be an exact `card_name = ?` match, so a mis-cased call found nothing, fell back to the
  // 0.10 default, and wrote that into the shared cache for every user.
  await appClient.query('UPDATE deck_cards SET cheapest_card_price = 2.22 WHERE deck_id = $1', [deckId]);
  const res = await p.client('/api/decks/reprice-card', {
    method: 'POST',
    body: { deckId, cardName: 'rampant growth' },
  });
  assert.equal(res.status, 200, `second reprice: ${JSON.stringify(res.body)}`);

  const { rows } = await appClient.query(
    'SELECT price FROM card_price_cache WHERE LOWER(card_name) = LOWER($1)',
    ['Rampant Growth'],
  );
  assert.equal(rows.length, 1, 'the second reprice must not create a second cache row');
  assert.equal(Number(rows[0].price), 2.22, 'the newer price must overwrite');
});

test('migration 0013 leaves card_price_cache with a usable upsert target', { skip }, async () => {
  // The migration's own job, asserted against the schema the server is actually running on: a
  // statement whose conflict target is the expression index resolves. Before 0013 this raised
  // "there is no unique or exclusion constraint matching the ON CONFLICT specification".
  await appClient.query(
    `INSERT INTO card_price_cache (card_name, price, cached_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (LOWER(card_name)) DO UPDATE SET price = EXCLUDED.price`,
    ['Migration Probe Card', 1.23],
  );
  await appClient.query(
    `INSERT INTO card_price_cache (card_name, price, cached_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (LOWER(card_name)) DO UPDATE SET price = EXCLUDED.price`,
    ['MIGRATION PROBE CARD', 4.56],
  );
  const { rows } = await appClient.query(
    'SELECT price FROM card_price_cache WHERE LOWER(card_name) = $1',
    ['migration probe card'],
  );
  assert.equal(rows.length, 1, 'the unique index must be case-insensitive');
  assert.equal(Number(rows[0].price), 4.56);
});

// ---------------------------------------------------------------------------------------------
// Password recovery on the legacy server.
//
// These routes have existed all along and have never worked: `password_resets` was created by no
// migration and by neither dialect of `db.js`, so every request raised into its own catch. The table
// arrives with migration 0014, which this suite applies, so this is the first time the flow runs.
//
// MAIL_TRANSPORT=console is set for the spawned server, so a send is a log line rather than a throw.
// The token is read from the database, not from a response or a log -- which is the point: the response
// does not carry it, and the console transport deliberately withholds the body.
// ---------------------------------------------------------------------------------------------

/** The plaintext token for a pending reset cannot be recovered, so mint the hash the same way. */
function hashResetToken(token) {
  return require('node:crypto').createHash('sha256').update(token, 'utf8').digest('hex');
}

test('requesting a reset stores a hashed, player-keyed token', { skip }, async () => {
  const p = await newPlayer('o');
  const res = await p.client('/api/auth/forgot-password', {
    method: 'POST',
    body: { usernameOrEmail: p.username },
  });
  assert.equal(res.status, 200, `forgot-password returned ${res.status}: ${JSON.stringify(res.body)}`);

  const { rows } = await appClient.query(
    'SELECT player_id, token_hash, consumed_at, expires_at FROM password_resets WHERE player_id = $1',
    [p.id],
  );
  assert.equal(rows.length, 1, 'exactly one pending reset');
  // Keyed on the immutable id. The legacy row stored the username, which this app lets people change.
  assert.equal(rows[0].player_id, p.id);
  // Stored as a hash. The legacy row held the token as issued, so reading the table was enough to take
  // over any account with a reset pending.
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  assert.equal(rows[0].consumed_at, null);
  assert.ok(rows[0].expires_at > new Date(), 'not already expired');

  // And the response carries nothing redeemable. Legacy attached the whole link whenever NODE_ENV was
  // not exactly "production", which this server is not.
  assert.doesNotMatch(JSON.stringify(res.body), /token=/);
  assert.equal(res.body.devResetLink, undefined);
});

test('the reset response is identical for an account that does not exist', { skip }, async () => {
  const p = await newPlayer('p');
  const known = await p.client('/api/auth/forgot-password', {
    method: 'POST',
    body: { usernameOrEmail: p.username },
  });
  const unknown = await p.client('/api/auth/forgot-password', {
    method: 'POST',
    body: { usernameOrEmail: 'definitely_no_such_account' },
  });
  assert.equal(unknown.status, known.status);
  assert.deepEqual(unknown.body, known.body);
});

test('redeeming a reset sets the password and consumes the token', { skip }, async () => {
  const p = await newPlayer('q');
  await p.client('/api/auth/forgot-password', { method: 'POST', body: { usernameOrEmail: p.username } });

  // The plaintext never leaves the mail, so mint a token and install its hash directly. This is testing
  // redemption, not delivery.
  const token = require('node:crypto').randomBytes(32).toString('base64url');
  await appClient.query('UPDATE password_resets SET token_hash = $1 WHERE player_id = $2', [
    hashResetToken(token),
    p.id,
  ]);

  const newPassword = 'quiet-library-morning-88';
  const res = await p.client('/api/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword },
  });
  assert.equal(res.status, 200, `reset returned ${res.status}: ${JSON.stringify(res.body)}`);

  const { rows } = await appClient.query('SELECT consumed_at FROM password_resets WHERE player_id = $1', [p.id]);
  assert.ok(rows[0].consumed_at, 'the token must be marked consumed, not deleted');

  // The new password works and the old one does not.
  const fresh = makeClient();
  const good = await fresh('/api/auth/login', {
    method: 'POST',
    body: { username: p.username, password: newPassword },
  });
  assert.equal(good.status, 200, `login with the new password: ${JSON.stringify(good.body)}`);
  const old = await makeClient()('/api/auth/login', {
    method: 'POST',
    body: { username: p.username, password: 'Sufficiently-Long-Pass-9' },
  });
  assert.notEqual(old.status, 200, 'the old password must stop working');

  // A second use is refused.
  const again = await p.client('/api/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword: 'another-good-passphrase-1' },
  });
  assert.equal(again.status, 400, 'a consumed token must not be redeemable');
});

test('a reset survives a username change between issue and redemption', { skip }, async () => {
  // The legacy row keyed on username and redeemed with `WHERE lower(username) = lower(?)`, so a rename
  // in between matched nobody -- or, if someone took the freed username, a different account entirely.
  const p = await newPlayer('r');
  await p.client('/api/auth/forgot-password', { method: 'POST', body: { usernameOrEmail: p.username } });
  const token = require('node:crypto').randomBytes(32).toString('base64url');
  await appClient.query('UPDATE password_resets SET token_hash = $1 WHERE player_id = $2', [
    hashResetToken(token),
    p.id,
  ]);

  const renamed = `${p.username}x`.slice(0, 20);
  await appClient.query('UPDATE players SET username = $1 WHERE id = $2', [renamed, p.id]);

  const newPassword = 'quiet-library-evening-91';
  const res = await p.client('/api/auth/reset-password', { method: 'POST', body: { token, newPassword } });
  assert.equal(res.status, 200, `reset after rename: ${JSON.stringify(res.body)}`);
  const login = await makeClient()('/api/auth/login', {
    method: 'POST',
    body: { username: renamed, password: newPassword },
  });
  assert.equal(login.status, 200, 'the renamed account must be able to sign in');
});

test('the password policy is enforced on register and on reset', { skip }, async () => {
  // Legacy's policy was `length >= 8` and nothing else.
  const client = makeClient();
  const weak = await client('/api/auth/register', {
    method: 'POST',
    body: {
      username: `pol_${Math.random().toString(36).slice(2, 8)}`,
      password: 'password',
      storeNickname: 'Policy',
      email: `pol_${Math.random().toString(36).slice(2, 8)}@example.test`,
    },
  });
  assert.equal(weak.status, 400, 'a blocklisted password must be refused on register');
  assert.match(weak.body.error, /commonly used/i);

  const sequential = await makeClient()('/api/auth/register', {
    method: 'POST',
    body: {
      username: `pol2_${Math.random().toString(36).slice(2, 8)}`,
      password: '12345678',
      storeNickname: 'Policy',
      email: `pol2_${Math.random().toString(36).slice(2, 8)}@example.test`,
    },
  });
  assert.equal(sequential.status, 400, '12345678 cleared the old length-only policy');
});

test('logging in issues a new session id', { skip }, async () => {
  // Legacy wrote the identity onto whatever session the client arrived with, which is session fixation:
  // an attacker who can plant a session cookie holds an authenticated session once the victim logs in.
  const p = await newPlayer('s');
  const before = p.sessionId();
  assert.ok(before, 'a session cookie should exist after logging in');

  const again = await p.client('/api/auth/login', {
    method: 'POST',
    body: { username: p.username, password: 'Sufficiently-Long-Pass-9' },
  });
  assert.equal(again.status, 200);
  assert.notEqual(p.sessionId(), before, 'the session id must change when an identity is established');
});

test('a password reset signs out a session held elsewhere', { skip }, async () => {
  // The property a reset exists to provide: the reason someone resets a password is that another person
  // is in their account. Legacy wrote `sessions_valid_from` but nothing read it, so the write did nothing
  // -- and a comment in the reset route claimed otherwise, which is worse than no comment.
  const p = await newPlayer('t');

  // A second, independent session on the same account. This is what a stolen cookie is.
  const elsewhere = makeClient();
  const signedIn = await elsewhere('/api/auth/login', {
    method: 'POST',
    body: { username: p.username, password: 'Sufficiently-Long-Pass-9' },
  });
  assert.equal(signedIn.status, 200, `second session login: ${JSON.stringify(signedIn.body)}`);
  assert.equal((await elsewhere('/api/auth/me')).body.loggedIn, true, 'the second session starts authenticated');

  await p.client('/api/auth/forgot-password', { method: 'POST', body: { usernameOrEmail: p.username } });
  const token = require('node:crypto').randomBytes(32).toString('base64url');
  await appClient.query('UPDATE password_resets SET token_hash = $1 WHERE player_id = $2 AND consumed_at IS NULL', [
    hashResetToken(token),
    p.id,
  ]);
  const reset = await makeClient()('/api/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword: 'quiet-library-midnight-7' },
  });
  assert.equal(reset.status, 200, `reset: ${JSON.stringify(reset.body)}`);

  // 200 with loggedIn false, not a 500: the guard regenerates rather than destroying, because
  // express-session nulls req.session on destroy and the handlers read it unguarded.
  const after = await elsewhere('/api/auth/me');
  assert.equal(after.status, 200);
  assert.equal(after.body.loggedIn, false, 'the other session must be signed out by the reset');
});

test('a session epoch check does not sign out unrelated accounts', { skip }, async () => {
  const victim = await newPlayer('u');
  const bystander = await newPlayer('v');
  assert.equal((await bystander.client('/api/auth/me')).body.loggedIn, true);

  await victim.client('/api/auth/forgot-password', { method: 'POST', body: { usernameOrEmail: victim.username } });
  const token = require('node:crypto').randomBytes(32).toString('base64url');
  await appClient.query('UPDATE password_resets SET token_hash = $1 WHERE player_id = $2 AND consumed_at IS NULL', [
    hashResetToken(token),
    victim.id,
  ]);
  await makeClient()('/api/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword: 'quiet-library-noon-3' },
  });

  // The mark is per player. An implementation that bumped a global epoch would sign out the whole site on
  // every password change.
  assert.equal(
    (await bystander.client('/api/auth/me')).body.loggedIn,
    true,
    'an unrelated account must keep its session',
  );
});

test('the recovery link targets the path that always handles a token', { skip }, async () => {
  // Why the link is `/?resetToken=` and not `/reset-password?token=`.
  //
  // `/` always serves the legacy page, which loads `app.js` -- the script that reads the token out of the
  // query string. That is the invariant, and it is what this asserts.
  //
  // `/reset-password` matches no route, so what it serves depends on whether `apps/web` has been built:
  // with a build present the catch-all returns the React shell, whose BrowserRouter has
  // basename="/react" and therefore matches nothing at that path; without one it falls back to the
  // legacy page. Either way the link must not depend on it, and the first version of this test asserted
  // the built-tree behaviour unconditionally -- which passed locally, where I had built apps/web, and
  // failed in CI, where the legacy-postgres job installs with npm and never runs the web build.
  //
  // So the negative half runs only when the build it describes is actually present. A path whose served
  // document varies with an unrelated build step is exactly the wrong thing to put in an email.
  const p = await newPlayer('w');

  const landing = await p.client('/?resetToken=probe');
  assert.equal(landing.status, 200, 'the reset landing page must be served');
  assert.equal(typeof landing.body, 'string', 'expected an HTML document');
  assert.match(landing.body, /app\.js/, 'the legacy page must load app.js, which reads the token');

  const webBuilt = existsSync(join(ROOT, 'apps', 'web', 'dist', 'index.html'));
  const wrongPath = await p.client('/reset-password?token=probe');
  assert.equal(wrongPath.status, 200, 'it 200s either way, which is why this was easy to miss');
  if (webBuilt) {
    assert.doesNotMatch(
      wrongPath.body,
      /app\.js/,
      'with apps/web built, this path serves the React shell, which cannot handle a token at that basename',
    );
  }
});

test('email verification works end to end on the legacy server', { skip }, async () => {
  const p = await newPlayer('x');
  const requested = await p.client('/api/auth/verify-email/request', { method: 'POST', body: {} });
  assert.equal(requested.status, 200, `verify request: ${JSON.stringify(requested.body)}`);

  const pending = await appClient.query(
    'SELECT id, email, token_hash FROM email_verifications WHERE player_id = $1',
    [p.id],
  );
  assert.equal(pending.rows.length, 1, 'one pending verification');
  assert.match(pending.rows[0].token_hash, /^[0-9a-f]{64}$/, 'stored as a hash, not as issued');

  const token = require('node:crypto').randomBytes(32).toString('base64url');
  await appClient.query('UPDATE email_verifications SET token_hash = $1 WHERE id = $2', [
    hashResetToken(token),
    pending.rows[0].id,
  ]);

  const before = await appClient.query('SELECT email_verified_at FROM players WHERE id = $1', [p.id]);
  assert.equal(before.rows[0].email_verified_at, null);

  const confirmed = await p.client('/api/auth/verify-email/confirm', { method: 'POST', body: { token } });
  assert.equal(confirmed.status, 200, `confirm: ${JSON.stringify(confirmed.body)}`);
  const after = await appClient.query('SELECT email_verified_at FROM players WHERE id = $1', [p.id]);
  assert.ok(after.rows[0].email_verified_at, 'the address must be marked verified');

  // Single use.
  const replay = await p.client('/api/auth/verify-email/confirm', { method: 'POST', body: { token } });
  assert.equal(replay.status, 400, 'a consumed verification token must not be redeemable');
});

test('a verification token does not verify an address changed since it was issued', { skip }, async () => {
  const p = await newPlayer('y');
  await p.client('/api/auth/verify-email/request', { method: 'POST', body: {} });
  const row = await appClient.query('SELECT id FROM email_verifications WHERE player_id = $1', [p.id]);
  const token = require('node:crypto').randomBytes(32).toString('base64url');
  await appClient.query('UPDATE email_verifications SET token_hash = $1 WHERE id = $2', [
    hashResetToken(token),
    row.rows[0].id,
  ]);

  await appClient.query('UPDATE players SET email = $1 WHERE id = $2', [`moved_${p.username}@example.test`, p.id]);

  const res = await p.client('/api/auth/verify-email/confirm', { method: 'POST', body: { token } });
  assert.equal(res.status, 400, 'the token proves the old address, and nothing about the new one');
  const after = await appClient.query('SELECT email_verified_at FROM players WHERE id = $1', [p.id]);
  assert.equal(after.rows[0].email_verified_at, null);
});

test('signing out everywhere ends other sessions and the calling one', { skip }, async () => {
  const p = await newPlayer('z');
  const elsewhere = makeClient();
  const signedIn = await elsewhere('/api/auth/login', {
    method: 'POST',
    body: { username: p.username, password: 'Sufficiently-Long-Pass-9' },
  });
  assert.equal(signedIn.status, 200);
  assert.equal((await elsewhere('/api/auth/me')).body.loggedIn, true);

  const out = await p.client('/api/auth/sign-out-everywhere', { method: 'POST', body: {} });
  assert.equal(out.status, 200, `sign-out-everywhere: ${JSON.stringify(out.body)}`);

  assert.equal((await elsewhere('/api/auth/me')).body.loggedIn, false, 'the other session must end');
  // Including the caller: someone who suspects a compromise may be on the compromised device.
  assert.equal((await p.client('/api/auth/me')).body.loggedIn, false, 'the calling session must end too');
});

// ---------------------------------------------------------------------------------------------
// Affiliate attribution. Not a write path, but this is the only harness that boots server.js, and
// the rule it enforces is a product requirement rather than a schema one: CLAUDE.md says every
// purchase link must carry xJoE0d. The route defaulted to 'grimore', which is not a real affiliate
// id, so an unset TCGPLAYER_AFFILIATE_ID silently earned nothing on every buy link in the app --
// and it is unset on the VM. The harness sets no affiliate env vars, so this exercises the default.
// ---------------------------------------------------------------------------------------------

test('the affiliate config serves the documented id with no env var set', { skip }, async () => {
  const res = await makeClient()('/api/config/affiliates');
  assert.equal(res.status, 200);
  assert.equal(
    res.body.tcgplayerAffiliateId,
    'xJoE0d',
    'an unset TCGPLAYER_AFFILIATE_ID must still attribute purchase links',
  );
  // There is no Card Kingdom affiliate id to fall back to. 'grimore' produced a link that looked
  // attributed and was not; null lets the client leave it unattributed honestly.
  assert.equal(res.body.cardKingdomAffiliateId, null);
});
