// DEPRECATED / NEUTRALIZED (2026-08-12).
//
// The previous version ran, with no confirmation:
//   DELETE FROM decks   WHERE player_id LIKE 'p_1783%'
//   DELETE FROM players WHERE id        LIKE 'p_1783%'
// Deleting by timestamp-prefix matches real accounts and is exactly the data-loss class
// flagged Critical in the audit. This one-off is superseded by the safe, explicit-IDs-only
// tool and no longer performs any deletion.
//
// To remove specific test decks/players, use:
//   node execution/cleanup_live_test_decks.js --deck <id> [--player <id> ...] --confirm

console.log("cleanup_test_db.js is deprecated and performs no deletions.");
console.log("Use: node execution/cleanup_live_test_decks.js --deck <id> [--player <id> ...] --confirm");
process.exit(0);
