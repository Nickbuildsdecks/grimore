// Executable safety tests for the destructive maintenance scripts (added 2026-08-12).
//
// These scripts can delete production rows, so "it parses" is not enough — we run each one
// against a MOCK db module and assert the safety guarantees hold at runtime:
//   * destructive actions require --confirm (dry-run / refusal otherwise),
//   * deletes only ever target explicit, parameterized IDs,
//   * NO script issues a LIKE / substring / timestamp-prefix delete (the audit's data-loss class),
//   * reconcile never deletes anything.
//
// Pure Node, no external deps. Each script is copied into a temp dir alongside a stub db.js
// that records every SQL call, then executed as a subprocess with controlled args.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

// A stub db.js that logs each operation as `DBCALL {json}` on stdout and returns plausible rows.
const STUB_DB = `
function emit(kind, sql, params) {
  console.log('DBCALL ' + JSON.stringify({ kind, sql: (sql || '').replace(/\\s+/g, ' ').trim(), params: params || null }));
}
module.exports = {
  initDb: async () => { emit('initDb'); },
  run: async (sql, params) => { emit('run', sql, params); return { changes: 0, id: 1 }; },
  query: async (sql, params) => {
    emit('query', sql, params);
    if (/FROM decks WHERE player_id/i.test(sql)) return [{ id: 'd_stub1', deck_name: 'Stub', player_id: (params && params[0]) || 'p_x' }];
    if (/FROM decks WHERE id IN/i.test(sql)) return [{ id: (params && params[0]) || 'd_x', deck_name: 'Stub', player_id: 'p_x', is_public: 0 }];
    if (/FROM deck_cards|deck_likes|deck_stats/i.test(sql)) return [];
    return [];
  },
  get: async (sql, params) => {
    emit('get', sql, params);
    if (/FROM players WHERE id/i.test(sql)) return { id: (params && params[0]) || 'p_x', username: 'stub', email: 'stub@example.com', google_id: 'g_stub' };
    return null;
  },
};
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grimore-maint-'));
  fs.mkdirSync(path.join(dir, 'execution'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'db.js'), STUB_DB);
  const copy = (relFrom, relTo) => fs.copyFileSync(path.join(REPO, relFrom), path.join(dir, relTo));
  copy('execution/cleanup_live_test_decks.js', 'execution/cleanup_live_test_decks.js');
  copy('execution/purge_live_test_decks_exact.js', 'execution/purge_live_test_decks_exact.js');
  copy('execution/reconcile_google_account.js', 'execution/reconcile_google_account.js');
  copy('cleanup_test_db.js', 'cleanup_test_db.js');
  return dir;
}

// Run a script; returns { code, out }. execFileSync throws on non-zero exit — capture either way.
function run(dir, scriptRel, args) {
  try {
    const out = execFileSync(process.execPath, [path.join(dir, scriptRel), ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function dbCalls(out) {
  return out.split('\n').filter(l => l.startsWith('DBCALL ')).map(l => JSON.parse(l.slice(7)));
}
const deletes = calls => calls.filter(c => c.kind === 'run' && /DELETE/i.test(c.sql));
const updates = calls => calls.filter(c => c.kind === 'run' && /UPDATE/i.test(c.sql));
// Word-boundary match so the `deck_likes` table name is not mistaken for a LIKE operator.
const anyLike = calls => calls.some(c => /\bLIKE\s/i.test(c.sql || ''));

test('no maintenance script ever issues a LIKE / substring delete (global safety net)', () => {
  const dir = setup();
  const runs = [
    run(dir, 'execution/cleanup_live_test_decks.js', ['--deck', 'd_1', '--player', 'p_1', '--confirm']),
    run(dir, 'execution/purge_live_test_decks_exact.js', ['--deck', 'd_1', '--confirm']),
    run(dir, 'cleanup_test_db.js', []),
    run(dir, 'execution/reconcile_google_account.js', ['--player', 'p_1', '--merge-to', 'p_admin', '--confirm']),
  ];
  for (const r of runs) assert.equal(anyLike(dbCalls(r.out)), false, 'a script issued a LIKE query');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanup_live_test_decks: refuses without --confirm, deletes only explicit parameterized IDs', () => {
  const dir = setup();

  const none = run(dir, 'execution/cleanup_live_test_decks.js', []);
  assert.equal(none.code, 0);
  assert.equal(deletes(dbCalls(none.out)).length, 0, 'no-arg run must not delete');

  const dry = run(dir, 'execution/cleanup_live_test_decks.js', ['--deck', 'd_1', '--deck', 'd_2']);
  assert.equal(dry.code, 1, 'missing --confirm must exit non-zero');
  assert.equal(deletes(dbCalls(dry.out)).length, 0, 'dry run must not delete');

  const go = run(dir, 'execution/cleanup_live_test_decks.js', ['--deck', 'd_1', '--player', 'p_1', '--confirm']);
  assert.equal(go.code, 0);
  const del = deletes(dbCalls(go.out));
  assert.ok(del.length > 0, 'confirmed run should delete');
  for (const d of del) {
    assert.ok(d.sql.includes('?'), `delete must be parameterized: ${d.sql}`);
    assert.ok(Array.isArray(d.params) && d.params.length > 0, 'delete must pass params');
  }
  const flatParams = del.flatMap(d => d.params);
  assert.ok(flatParams.includes('d_1'), 'deck id passed through');
  assert.ok(flatParams.includes('p_1'), 'player id passed through');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('purge_live_test_decks_exact: dry-run shows targets but does not delete; --confirm deletes parameterized', () => {
  const dir = setup();

  const dry = run(dir, 'execution/purge_live_test_decks_exact.js', ['--deck', 'd_1']);
  assert.equal(dry.code, 1, 'missing --confirm must exit non-zero');
  assert.equal(deletes(dbCalls(dry.out)).length, 0, 'dry run must not delete');

  const go = run(dir, 'execution/purge_live_test_decks_exact.js', ['--deck', 'd_1', '--confirm']);
  assert.equal(go.code, 0);
  const del = deletes(dbCalls(go.out));
  assert.ok(del.length > 0, 'confirmed run should delete');
  for (const d of del) {
    assert.ok(d.sql.includes('?'), `delete must be parameterized: ${d.sql}`);
    assert.ok((d.params || []).includes('d_1'), 'explicit id passed through');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanup_test_db (root) is neutralized — performs no DB operations at all', () => {
  const dir = setup();
  const r = run(dir, 'cleanup_test_db.js', []);
  assert.equal(r.code, 0);
  const calls = dbCalls(r.out);
  assert.equal(calls.length, 0, 'neutralized script must issue zero DB calls');
  assert.match(r.out, /deprecated/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reconcile_google_account: snapshot-only by default, reassigns only with --confirm, never deletes', () => {
  const dir = setup();

  const snap = run(dir, 'execution/reconcile_google_account.js', ['--player', 'p_1']);
  assert.equal(snap.code, 0);
  const snapCalls = dbCalls(snap.out);
  assert.equal(updates(snapCalls).length, 0, 'snapshot-only run must not update');
  assert.equal(deletes(snapCalls).length, 0, 'reconcile must never delete');
  assert.match(snap.out, /snapshot written/i);

  const dry = run(dir, 'execution/reconcile_google_account.js', ['--player', 'p_1', '--merge-to', 'p_admin']);
  assert.equal(dry.code, 1, 'merge without --confirm must exit non-zero');
  assert.equal(updates(dbCalls(dry.out)).length, 0, 'merge dry run must not update');

  const go = run(dir, 'execution/reconcile_google_account.js', ['--player', 'p_1', '--merge-to', 'p_admin', '--confirm']);
  assert.equal(go.code, 0);
  const goCalls = dbCalls(go.out);
  assert.ok(updates(goCalls).length > 0, 'confirmed merge should reassign decks');
  assert.equal(deletes(goCalls).length, 0, 'reconcile must never delete, even on merge');
  for (const u of updates(goCalls)) assert.ok(u.sql.includes('?'), 'reassign must be parameterized');
  fs.rmSync(dir, { recursive: true, force: true });
});
