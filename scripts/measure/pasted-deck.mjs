/**
 * What is a pasted deck of real cards worth at the table — with the card table, and without it?
 *
 * The question the project is for, asked of the product rather than of the compiler: "no matter what
 * deck we upload, it enforces the rules". Compiler coverage (`compilable.mjs`) answers how much
 * printed text this engine reads; `corpus-decks.mjs` answers whether two decks of arbitrary real
 * cards play to a finish. Neither answers what a **player** gets, because that depends on whether
 * anything in `apps/realtime` looks the names up at all — and until D459 nothing did.
 *
 * So this runs a real pasted list through the real `PodStore`, twice, over the same Redis and the
 * same card table:
 *
 *  * **no card table** — a store with no card library, which is what this app was before D459 and
 *    what it still is wherever `DATABASE_URL` is unset;
 *  * **card table** — the Postgres-backed library, against whatever `scryfall_cards` holds.
 *
 * ## What it prints, and how to read the three numbers
 *
 * - **cardboard** is the server's own ack: names nothing could make playable. These cards cannot be
 *   cast at all; a player moves them by hand, as at a kitchen table.
 * - **unplayable** is the same thing read off the dealt game (`view.manual`, reason
 *   `no-printed-data`). It should agree with cardboard, and the two being printed separately is how
 *   a disagreement between the ack and the deal would show up.
 * - **partly flagged** is `view.manual` with reason `text-not-automated`: the engine **casts and
 *   plays** these, and some printed line of theirs does nothing yet, which the table badges (D362,
 *   D363). This number going *up* is the measurement working — those cards were cardboard before.
 *
 * The rest — distinct names minus unplayable minus partly flagged — is the deck the engine runs end
 * to end with nothing flagged at all.
 *
 * ## The deck
 *
 * Drawn from the card table itself, so it is a list a person could actually paste: Commander-legal,
 * single-face, mana value 5 or less, non-land, ordered by `md5(id)` so the same table gives the same
 * deck every run. Plus 35 Forest, which come from the pool either way and are not part of the
 * question.
 *
 * ## Usage
 *
 *   DATABASE_URL=postgres://… REDIS_URL=redis://… node scripts/measure/pasted-deck.mjs [SIZE=99]
 *
 * It writes two pods under a `pasted-deck:` key prefix and leaves them to expire by TTL.
 */
import pg from 'pg';
import { createClient } from 'redis';
import { viewFor } from '../lib/engine.mjs';
import { provenanceLine } from '../lib/provenance.mjs';
import { PodStore, makePlayerId } from '../../apps/realtime/dist/pod.js';
import { createCardLibrary } from '../../apps/realtime/dist/cardLibrary.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const SIZE = Number(process.env.SIZE ?? 99);
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required: the point of this harness is the card table.');
  process.exit(2);
}

console.log(provenanceLine({ SIZE, REDIS_URL }));

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const picked = await db.query(
  `SELECT name FROM scryfall_cards
   WHERE (legalities::jsonb)->>'commander' = 'legal'
     AND layout = 'normal'
     AND COALESCE(type_line, '') NOT ILIKE '%land%'
     AND COALESCE(cmc, 0) <= 5
   ORDER BY md5(id)
   LIMIT $1`,
  [SIZE],
);
await db.end();
const names = picked.rows.map((r) => r.name);
if (names.length === 0) {
  console.error('the card table is empty: load it with scripts/corpus/to-postgres.mjs first.');
  process.exit(1);
}
const text = ['Deck', '35 Forest', ...names.map((n) => `1 ${n}`)].join('\n');

const redis = createClient({ url: REDIS_URL });
await redis.connect();

async function run(label, cards) {
  const store = new PodStore(redis, {
    keyPrefix: `pasted-deck:${label.replace(/\W+/g, '-')}:${Date.now().toString(36)}`,
    ...(cards === null ? {} : { cards }),
  });
  const host = await store.create(
    { format: 'commander', visibility: 'private', name: 'Pasted deck', bots: 1 },
    { id: makePlayerId('Measurer'), name: 'Measurer' },
  );
  const code = host.pod.code;
  const t0 = Date.now();
  const { summary } = await store.setDeck(code, host.playerId, { text });
  const pasteMs = Date.now() - t0;
  /*
    And the same paste again, because the first one is the expensive one and saying only its cost
    would overstate what a table pays. A paste fetches the rows (one query) and compiles each name
    (`compileCard`, memoised per row). The second time, both are already in hand.
  */
  const t1 = Date.now();
  await store.setDeck(code, host.playerId, { text });
  const repasteMs = Date.now() - t1;
  const dealt = await store.ready(code, host.playerId, true);
  const loaded = await store.applyAction(
    code, host.playerId, { type: 'deck:load', seat: 0, deckId: 'custom:0' }, dealt.stateVersion,
  );
  const started = await store.applyAction(
    code, host.playerId, { type: 'game:start' }, loaded.stateVersion,
  );
  const auto = await store.applyAction(
    code, host.playerId, { type: 'auto:start' }, started.stateVersion,
  );
  const manual = viewFor(auto.state, 0).manual;
  const unplayable = manual.filter((m) => m.reason === 'no-printed-data');
  const flagged = manual.filter((m) => m.reason === 'text-not-automated');
  const distinct = names.length + 1;
  console.log(
    `${label.padEnd(14)} cardboard=${String(summary.unknownCount).padStart(3)}` +
    `  unplayable=${String(unplayable.length).padStart(3)}` +
    `  partly flagged=${String(flagged.length).padStart(3)}` +
    `  fully automated=${String(distinct - unplayable.length - flagged.length).padStart(3)}` +
    `  of ${distinct} distinct   paste=${pasteMs}ms (again: ${repasteMs}ms)`,
  );
  return { unplayable, flagged };
}

await run('no card table', null);
const cards = createCardLibrary({
  databaseUrl: DATABASE_URL,
  log: { warn: (obj, msg) => console.warn(`! ${msg}`, obj) },
});
const after = await run('card table', cards);
await cards.close();
await redis.quit();

console.log(`\nDeck: 35 Forest + ${names.length} distinct Commander-legal spells of mana value <= 5.`);
if (after.unplayable.length > 0) {
  console.log(`\nStill unplayable (${after.unplayable.length}):`);
  for (const card of after.unplayable.slice(0, 10)) console.log(`  ${card.name}: ${card.detail}`);
}
if (after.flagged.length > 0) {
  console.log(`\nCast and played, with a line to apply by hand (${after.flagged.length}, first 10):`);
  for (const card of after.flagged.slice(0, 10)) console.log(`  ${card.name}: ${card.detail}`);
}
