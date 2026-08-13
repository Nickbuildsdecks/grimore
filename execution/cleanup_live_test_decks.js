// Grimore test-debris cleaner — SAFE REWRITE.
//
// The previous version identified "test" data by timestamp prefix (id LIKE 'd_1786%')
// and name prefix (deck_name LIKE 'Test%', username LIKE 'Test%'). Those patterns match
// ALL decks/players created during the launch window and real users like "Testarossa" or
// decks like "Greatest Hits". Running it deleted live user data with no confirmation.
//
// This version NEVER guesses. It deletes only the exact deck/player IDs you pass on the
// command line, uses parameterized queries, and refuses to do anything without --confirm.
//
// Usage:
//   node execution/cleanup_live_test_decks.js --deck d_123 --deck d_456 --player p_789 --confirm
//
let db;
try {
  db = require('./db');
} catch (e) {
  db = require('../db');
}

function parseArgs(argv) {
  const deckIds = [];
  const playerIds = [];
  let confirm = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') confirm = true;
    else if (a === '--deck') { if (argv[i + 1]) deckIds.push(argv[++i]); }
    else if (a === '--player') { if (argv[i + 1]) playerIds.push(argv[++i]); }
  }
  return { deckIds, playerIds, confirm };
}

function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(',');
}

async function cleanupTestDebris() {
  const { deckIds, playerIds, confirm } = parseArgs(process.argv);

  if (deckIds.length === 0 && playerIds.length === 0) {
    console.log("No IDs provided. Nothing to do.");
    console.log("Usage: node execution/cleanup_live_test_decks.js --deck <id> [--player <id> ...] --confirm");
    process.exit(0);
  }

  if (!confirm) {
    console.log("Refusing to delete without --confirm. Would delete:");
    deckIds.forEach(id => console.log(`  deck   ${id}`));
    playerIds.forEach(id => console.log(`  player ${id}`));
    console.log("Re-run with --confirm to proceed.");
    process.exit(1);
  }

  await db.initDb();
  console.log("=== Grimore Test Debris Cleaner (explicit IDs only) ===");

  if (deckIds.length > 0) {
    const ph = placeholders(deckIds.length);
    await db.run(`DELETE FROM deck_likes WHERE deck_id IN (${ph})`, deckIds);
    await db.run(`DELETE FROM deck_cards WHERE deck_id IN (${ph})`, deckIds);
    await db.run(`DELETE FROM decks WHERE id IN (${ph})`, deckIds);
    console.log(`Deleted ${deckIds.length} deck(s) by explicit id.`);
  }

  if (playerIds.length > 0) {
    const ph = placeholders(playerIds.length);
    await db.run(`DELETE FROM deck_likes WHERE player_id IN (${ph})`, playerIds);
    await db.run(`DELETE FROM deck_cards WHERE deck_id IN (SELECT id FROM decks WHERE player_id IN (${ph}))`, playerIds);
    await db.run(`DELETE FROM decks WHERE player_id IN (${ph})`, playerIds);
    await db.run(`DELETE FROM players WHERE id IN (${ph})`, playerIds);
    console.log(`Deleted ${playerIds.length} player account(s) by explicit id.`);
  }

  console.log("=== Cleanup Complete ===");
}

cleanupTestDebris().catch(console.error);
