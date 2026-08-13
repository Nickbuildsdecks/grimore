// Grimore — leftover-account reconciliation (SAFE, reversible). Added 2026-08-12.
//
// Context: today's Google-auth fix detached a stale `google_id` from a player row that had
// been auto-created during an earlier sign-in, so that Google identity could be linked to
// p_admin. The stale row is now a dormant password-only account. This tool lets you deal with
// it safely and reversibly — it NEVER guesses which row, NEVER deletes by pattern, always
// snapshots to a JSON file before any mutation, and refuses to mutate without --confirm.
//
// Usage (always pass the explicit player id — find it with execution/inspect_live_decks.js):
//   node execution/reconcile_google_account.js --player p_123               (dry run: snapshot + report)
//   node execution/reconcile_google_account.js --player p_123 --merge-to p_admin --confirm
//   node execution/reconcile_google_account.js --restore snapshot-p_123-....json --confirm
//
// --merge-to <targetId> reassigns the stray account's decks (and their cards/likes/stats) to
// <targetId>, leaving the stray row itself in place but empty (dormant). Nothing is hard-deleted.
// --restore re-applies a snapshot's original ownership if you change your mind.
//
const fs = require('fs');
const path = require('path');
let db;
try { db = require('./db'); } catch (e) { db = require('../db'); }

function parseArgs(argv) {
  const out = { player: null, mergeTo: null, restore: null, confirm: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') out.confirm = true;
    else if (a === '--player') out.player = argv[++i];
    else if (a === '--merge-to') out.mergeTo = argv[++i];
    else if (a === '--restore') out.restore = argv[++i];
  }
  return out;
}

function stamp() {
  // Deterministic-ish filename without relying on Date in odd environments.
  return `${process.pid}-${process.hrtime.bigint()}`;
}

async function snapshotPlayer(playerId) {
  const player = await db.get('SELECT * FROM players WHERE id = ?', [playerId]);
  if (!player) return null;
  const decks = await db.query('SELECT * FROM decks WHERE player_id = ?', [playerId]);
  const deckIds = decks.map(d => d.id);
  let deckCards = [], deckLikes = [], deckStats = [];
  if (deckIds.length) {
    const ph = deckIds.map(() => '?').join(',');
    deckCards = await db.query(`SELECT * FROM deck_cards WHERE deck_id IN (${ph})`, deckIds);
    try { deckLikes = await db.query(`SELECT * FROM deck_likes WHERE deck_id IN (${ph})`, deckIds); } catch (e) {}
    try { deckStats = await db.query(`SELECT * FROM deck_stats WHERE deck_id IN (${ph})`, deckIds); } catch (e) {}
  }
  return { player, decks, deckCards, deckLikes, deckStats };
}

async function run() {
  const { player, mergeTo, restore, confirm } = parseArgs(process.argv);
  await db.initDb();

  if (restore) {
    const snap = JSON.parse(fs.readFileSync(restore, 'utf8'));
    console.log(`Restore from ${restore}: player ${snap.player.id}, ${snap.decks.length} deck(s).`);
    if (!confirm) { console.log('Dry run. Re-run with --confirm to restore original ownership.'); process.exit(1); }
    for (const d of snap.decks) {
      await db.run('UPDATE decks SET player_id = ? WHERE id = ?', [snap.player.id, d.id]);
    }
    console.log(`Restored ownership of ${snap.decks.length} deck(s) to ${snap.player.id}.`);
    process.exit(0);
  }

  if (!player) {
    console.log('Usage: node execution/reconcile_google_account.js --player <id> [--merge-to <targetId>] --confirm');
    process.exit(0);
  }

  const snap = await snapshotPlayer(player);
  if (!snap) { console.log(`No player found with id ${player}.`); process.exit(1); }

  const snapFile = path.join(__dirname, `snapshot-${player}-${stamp()}.json`);
  fs.writeFileSync(snapFile, JSON.stringify(snap, null, 2));
  console.log(`=== Reconcile ${player} ===`);
  console.log(`  username: ${snap.player.username}  email: ${snap.player.email}  google_id: ${snap.player.google_id}`);
  console.log(`  decks: ${snap.decks.length}  deck_cards: ${snap.deckCards.length}`);
  console.log(`  snapshot written: ${snapFile}`);

  if (!mergeTo) {
    console.log('No --merge-to target given. Snapshot + report only; no changes made.');
    process.exit(0);
  }

  const target = await db.get('SELECT id FROM players WHERE id = ?', [mergeTo]);
  if (!target) { console.log(`Merge target ${mergeTo} does not exist. Aborting.`); process.exit(1); }

  if (!confirm) {
    console.log(`Would reassign ${snap.decks.length} deck(s) from ${player} to ${mergeTo}. Re-run with --confirm.`);
    process.exit(1);
  }

  for (const d of snap.decks) {
    await db.run('UPDATE decks SET player_id = ? WHERE id = ?', [mergeTo, d.id]);
  }
  console.log(`Reassigned ${snap.decks.length} deck(s) to ${mergeTo}. Stray row ${player} left in place (dormant).`);
  console.log(`Undo with: node execution/reconcile_google_account.js --restore ${path.basename(snapFile)} --confirm`);
}

run().catch(e => { console.error(e); process.exit(1); });
