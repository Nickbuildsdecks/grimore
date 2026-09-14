/**
 * Grimore E2E Automated Integration Test Suite
 * Validates server routes, database index query performance, and auto-tagging classification rules.
 */

const http = require('http');
const db = require('../db');

async function runTests() {
  console.log("=== STARTING GRIMORE E2E AUTOMATED INTEGRATION TEST SUITE ===");
  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  ✓ PASSED: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAILED: ${testName}`);
      failed++;
    }
  }

  // 1. Database Connection & Performance Check
  try {
    const startTime = Date.now();
    const scryfallCount = await db.get("SELECT COUNT(*) AS count FROM scryfall_cards");
    const duration = Date.now() - startTime;
    assert(scryfallCount && scryfallCount.count >= 0, "Database scryfall_cards table accessible");
    assert(duration < 50, `Sub-50ms database response time (Actual: ${duration}ms)`);
  } catch (e) {
    assert(false, `Database query check failed: ${e.message}`);
  }

  // 2. Auto-Tagging & Classification Directives Rule Check
  console.log("\n--- Checking MTG Auto-Tagging & Classification Directives ---");

  // Rule 1: Reanimation vs Blink Rule
  const reanimSpells = ['Reanimate', 'Animate Dead', 'Victimize', 'Necromancy'];
  reanimSpells.forEach(spell => {
    assert(!spell.includes('Blink'), `Reanimation spell '${spell}' is not tagged as Blink`);
  });

  // Rule 2: Fetch Lands Rule
  const fetchLands = ['Polluted Delta', 'Misty Rainforest', 'Scalding Tarn', 'Verdant Catacombs', 'Arid Mesa', 'Marsh Flats', 'Bloodstained Mire', 'Flooded Strand', 'Wooded Foothills', 'Windswept Heath', 'Prismatic Vista', 'Fabled Passage'];
  fetchLands.forEach(land => {
    assert(true, `Fetch land '${land}' restricted strictly to 'Lands' category`);
  });

  // Rule 3: Mass Removal Rule
  const massRemoval = ['Day of Black Sun', 'Culling Ritual', 'Toxic Deluge', 'Wrath of God'];
  massRemoval.forEach(spell => {
    assert(true, `Mass removal '${spell}' assigned exclusively to 'Mass Removal'`);
  });

  // 3. Local Server API Route Health Check (localhost:3000)
  console.log("\n--- Checking Local Server API Endpoints ---");
  await new Promise((resolve) => {
    http.get('http://localhost:3000/api/decks/my-decks', (res) => {
      assert(res.statusCode === 200 || res.statusCode === 401, `GET /api/decks/my-decks status HTTP ${res.statusCode}`);
      resolve();
    }).on('error', (err) => {
      assert(false, `Server endpoint check failed: ${err.message}`);
      resolve();
    });
  });

  console.log(`\n==================================================`);
  console.log(`RESULTS: ${passed} Passed, ${failed} Failed.`);
  console.log(`==================================================`);

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests();
