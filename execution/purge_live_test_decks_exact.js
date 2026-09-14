// Grimore test-debris purge — SAFE REWRITE (2026-08-12).
//
// DANGER (previous version): this script deleted decks by NAME SUBSTRING and TIMESTAMP
// PREFIX with no confirmation and string-interpolated IDs:
//   deck_name LIKE '%Test%' / '%test%' / 'Cloned%' / '%Delete%' / 'Quick Import%' /
//   '%Gemini%'  OR  id LIKE 'd_1786%'
// Against the live database that matches real users' decks — "Greatest Hits", "Contest
// Winner", "Izzet Testudo", every deck created in the Aug 2026 launch window, etc. — and
// wiped them irrecoverably. This is the exact data-loss class flagged Critical in the audit.
//
// This version NEVER guesses. It deletes only the exact deck IDs you pass on the command
// line, uses parameterized queries, and refuses to do anything without --confirm. For the
// common case, prefer execution/cleanup_live_test_decks.js (which also handles players).
//
// Usage:
//   node execution/purge_live_test_decks_exact.js --deck d_123 --deck d_456          (dry run)
//   node execution/purge_live_test_decks_exact.js --deck d_123 --deck d_456 --confirm (delete)
//
let db;
try {
  db = require('./db');
} catch (e) {
  db = require('../db');
}

function parseArgs(argv) {
  const deckIds = [];
  let confirm = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') confirm = true;
    else if (a === '--deck') { if (argv[i + 1]) deckIds.push(argv[++i]); }
  }
  return { deckIds, confirm };
}

function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(',');
}

async function purgeExact() {
  const { deckIds, confirm } = parseArgs(process.argv);

  if (deckIds.length === 0) {
    console.log("No deck IDs provided. Nothing to do.");
    console.log("Usage: node execution/purge_live_test_decks_exact.js --deck <id> [--deck <id> ...] --confirm");
    process.exit(0);
  }

  await db.initDb();

  // Show exactly what would be affected before touching anything.
  const ph = placeholders(deckIds.length);
  const targets = await db.query(
    `SELECT id, deck_name, player_id, is_public FROM decks WHERE id IN (${ph})`,
    deckIds
  );
  console.log(`=== Purge (explicit IDs only) — ${targets.length} of ${deckIds.length} requested deck(s) found ===`);
  targets.forEach(d => console.log(` - [${d.id}] "${d.deck_name}" (Owner: ${d.player_id}, Public: ${d.is_public})`));

  if (!confirm) {
    console.log("Refusing to delete without --confirm. Re-run with --confirm to proceed.");
    process.exit(1);
  }

  if (deckIds.length > 0) {
    await db.run(`DELETE FROM deck_stats WHERE deck_id IN (${ph})`, deckIds);
    await db.run(`DELETE FROM deck_likes WHERE deck_id IN (${ph})`, deckIds);
    await db.run(`DELETE FROM deck_cards WHERE deck_id IN (${ph})`, deckIds);
    await db.run(`DELETE FROM decks WHERE id IN (${ph})`, deckIds);
    console.log(`Deleted ${deckIds.length} deck(s) by explicit id.`);
  }

  console.log("=== Purge Complete ===");
}

purgeExact().catch(console.error);
