import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { createCardLibrary } from './cardLibrary.js';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * The card lookup, against the real migrated schema.
 *
 * A temporary database with migrations run into it, rather than whatever is in the development one:
 * the corpus is loaded by hand (`scripts/corpus/to-postgres.mjs`), so a test that read the
 * development database would pass here and fail on a fresh checkout — and would be asserting
 * against 33,847 rows nobody chose. Three rows, written by this file, are enough to say what the
 * lookup does.
 *
 * The rows are printed cards quoted from the corpus. Wall of Omens and Elvish Mystic are not in the
 * 348-card hand-written pool, which is the whole point of them: a name the pool has would be
 * resolved by `customDeck` before this lookup was consulted at all.
 */
const CARDS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Wall of Omens',
    type_line: 'Creature — Wall',
    oracle_text: 'Defender\nWhen Wall of Omens enters, draw a card.',
    mana_cost: '{1}{W}',
    cmc: 2,
    colors: '["W"]',
    power: '0',
    toughness: '4',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Elvish Mystic',
    type_line: 'Creature — Elf Druid',
    oracle_text: '{T}: Add {G}.',
    mana_cost: '{G}',
    cmc: 1,
    colors: '["G"]',
    power: '1',
    toughness: '1',
  },
];

describe.skipIf(!DATABASE_URL)('the card lookup (requires DATABASE_URL)', () => {
  const dbName = `grimore_cardlib_test_${Date.now()}`;
  let url: string;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    url = u.toString();
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const { runMigrations } = await import('@grimore/db');
    await runMigrations(pool);
    for (const card of CARDS) {
      await pool.query(
        `INSERT INTO scryfall_cards
           (id, name, card_name, set_code, type_line, oracle_text, mana_cost, cmc, colors,
            power, toughness, layout, last_updated)
         VALUES ($1, $2, $2, 'FORGE', $3, $4, $5, $6, $7, $8, $9, 'normal', CURRENT_TIMESTAMP)`,
        [card.id, card.name, card.type_line, card.oracle_text, card.mana_cost, card.cmc,
          card.colors, card.power, card.toughness],
      );
    }
    await pool.end();
  }, 60_000);

  afterAll(async () => {
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  const library = () => createCardLibrary({ databaseUrl: url, log: pino({ level: 'silent' }) });

  it('answers for a name it has warmed, and not before', async () => {
    const cards = library();
    try {
      // Before the warm, nothing — which is what makes the warm in `PodStore.mutate` load-bearing
      // rather than an optimisation.
      expect(cards.rowFor('Wall of Omens')).toBeUndefined();
      await cards.warm(['Wall of Omens']);
      const row = cards.rowFor('Wall of Omens');
      expect(row?.name).toBe('Wall of Omens');
      expect(row?.type_line).toBe('Creature — Wall');
      expect(row?.oracle_text).toBe('Defender\nWhen Wall of Omens enters, draw a card.');
      expect(row?.power).toBe('0');
      expect(row?.toughness).toBe('4');
    } finally {
      await cards.close();
    }
  });

  it('matches a name however it was typed', async () => {
    // `customDeck` indexes the pool case- and space-insensitively, and a pasted list is typed by a
    // person. A lookup that only matched the exact spelling would send `  elvish mystic ` to
    // cardboard while the pool would have found it.
    const cards = library();
    try {
      await cards.warm(['  elVISH mystic  ']);
      expect(cards.rowFor('Elvish Mystic')?.name).toBe('Elvish Mystic');
      expect(cards.rowFor('ELVISH MYSTIC')?.name).toBe('Elvish Mystic');
    } finally {
      await cards.close();
    }
  });

  it('remembers a name the table does not have, and does not ask again', async () => {
    /*
      A miss is cached as well as a hit, because a player who types `Lightnng Bolt` would otherwise
      have that name queried again on every move for the rest of the game.

      Asserted by its consequence rather than by counting queries, and the first draft of this test
      is why. It read `pg_stat_database`'s transaction counter either side of a second warm, which
      looked like a direct measurement and was not: the break run removed the negative caching
      altogether and this test still passed, because those statistics are snapshotted per
      transaction and the counter had not moved yet. A measurement that cannot tell the two cases
      apart is worse than no measurement, because it reads like evidence.

      So: the row is inserted **after** the miss is remembered, and the same library still answers
      undefined. That is the cost of negative caching stated as a test — a card arriving in the
      table later is not picked up until the process restarts — and a fresh library proves the row
      really is there.
    */
    const cards = library();
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await cards.warm(['Latecomer Wall']);
      expect(cards.rowFor('Latecomer Wall')).toBeUndefined();
      await pool.query(
        `INSERT INTO scryfall_cards (id, name, card_name, set_code, type_line, oracle_text,
           mana_cost, cmc, power, toughness, layout, last_updated)
         VALUES ('cccccccc-0000-4000-8000-000000000003', 'Latecomer Wall', 'Latecomer Wall',
                 'FORGE', 'Creature — Wall', 'Defender', '{1}{W}', 2, '0', '4', 'normal',
                 CURRENT_TIMESTAMP)`,
      );
      await cards.warm(['Latecomer Wall']);
      expect(cards.rowFor('Latecomer Wall')).toBeUndefined();

      const fresh = library();
      try {
        await fresh.warm(['Latecomer Wall']);
        expect(fresh.rowFor('Latecomer Wall')?.type_line).toBe('Creature — Wall');
      } finally {
        await fresh.close();
      }
    } finally {
      await pool.query("DELETE FROM scryfall_cards WHERE name = 'Latecomer Wall'");
      await pool.end();
      await cards.close();
    }
  });

  it('answers with one row for a name the table holds twice', async () => {
    /*
      `scryfall_cards` is keyed by **printing**, so a real Scryfall import holds a row per printing
      and a lookup by name returns several. Without the de-duplication an arbitrary one would win —
      differently on different nodes, since nothing orders them — which is the fan-out D23 and D24
      both found elsewhere in this product, arriving here as two tables disagreeing about a card.

      Two rows for one name, with different text, and the lower id wins everywhere.
    */
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      for (const [id, text] of [
        ['aaaaaaaa-0000-4000-8000-000000000001', 'Defender\nWhen Reprinted Wall enters, draw a card.'],
        ['bbbbbbbb-0000-4000-8000-000000000002', 'Defender'],
      ] as const) {
        await pool.query(
          `INSERT INTO scryfall_cards (id, name, card_name, set_code, type_line, oracle_text,
             mana_cost, cmc, power, toughness, layout, last_updated)
           VALUES ($1, 'Reprinted Wall', 'Reprinted Wall', 'FORGE', 'Creature — Wall', $2,
                   '{1}{W}', 2, '0', '4', 'normal', CURRENT_TIMESTAMP)`,
          [id, text],
        );
      }
      const cards = library();
      try {
        await cards.warm(['Reprinted Wall']);
        const row = cards.rowFor('Reprinted Wall');
        expect(row?.oracle_text).toBe('Defender\nWhen Reprinted Wall enters, draw a card.');
      } finally {
        await cards.close();
      }
    } finally {
      await pool.query("DELETE FROM scryfall_cards WHERE name = 'Reprinted Wall'");
      await pool.end();
    }
  });

  it('forgets everything rather than growing without a bound', async () => {
    // The cap is a clear, not an eviction order: what a clear costs is one query per list still in
    // play. Asserted on a cap of one, because the real 20,000 would take 20,000 rows to reach.
    const cards = createCardLibrary({ databaseUrl: url, log: pino({ level: 'silent' }), maxNames: 1 });
    try {
      await cards.warm(['Wall of Omens']);
      expect(cards.rowFor('Wall of Omens')?.name).toBe('Wall of Omens');
      await cards.warm(['Elvish Mystic']);
      expect(cards.rowFor('Elvish Mystic')?.name).toBe('Elvish Mystic');
      expect(cards.rowFor('Wall of Omens')).toBeUndefined();
    } finally {
      await cards.close();
    }
  });

  it('survives a card table that is not there, and asks again next time', async () => {
    /*
      The failure mode that matters most, because the alternative is a table nobody can play. A
      lookup that cannot reach the database reports it and resolves: those names stay unresolved,
      which makes them cardboard — the behaviour this app had before it read the card table at all.

      And the names are **not** cached as misses, so a database that comes back is picked up. That
      distinction is the reason hits and misses are cached separately: a five-second outage must not
      turn a deck to cardboard for the rest of the game.
    */
    const dead = new URL(url);
    dead.pathname = '/grimore_no_such_database';
    const warnings: string[] = [];
    const cards = createCardLibrary({
      databaseUrl: dead.toString(),
      log: { warn: (_obj, msg) => void warnings.push(msg) },
    });
    try {
      await expect(cards.warm(['Wall of Omens'])).resolves.toBeUndefined();
      expect(cards.rowFor('Wall of Omens')).toBeUndefined();
      expect(warnings).toEqual(['card lookup failed; pasted names stay unread']);
      // Asked again rather than remembered as a miss.
      await cards.warm(['Wall of Omens']);
      expect(warnings).toHaveLength(2);
    } finally {
      await cards.close().catch(() => {});
    }
  });
});
