import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv, DRAFT_SEATS, DRAFT_PACKS } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const PASSWORD = 'correct-horse-battery';

describe.skipIf(!DATABASE_URL || !REDIS_URL)('sandbox + draft (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_sandbox_test_${Date.now()}`;
  let alice: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;
  const PACK_SIZE = 3;

  async function signup(username: string) {
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/register').send({
      username, password: PASSWORD, storeNickname: username, email: `${username}@example.com`,
    })).status).toBe(201);
    await agent.post('/api/auth/login').send({ username, password: PASSWORD });
    return agent;
  }

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    ctx = await createContext(parseEnv({
      NODE_ENV: 'test', DATABASE_URL: u.toString(), REDIS_URL, SESSION_SECRET: 'test-secret', LOG_LEVEL: 'silent',
    }));
    await runMigrations(ctx.pool);
    app = createApp(ctx);
    // Enough cards for 8 seats x 3 per pack x 3 packs, plus named cards the parser tests use.
    const values: string[] = [];
    const params: unknown[] = [];
    const push = (id: string, name: string, rarity: string, price: number, type = 'Creature', oracle = '', mana = '{1}') => {
      const i = params.length;
      params.push(id, name, rarity, price, type, oracle, mana);
      values.push(`($${i + 1},$${i + 2},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},1)`);
    };
    push('aaaa0000-0000-4000-8000-000000000001', 'Sol Ring', 'uncommon', 1.25, 'Artifact', '{T}: Add {C}{C}.', '{1}');
    push('bbbb0000-0000-4000-8000-000000000002', 'Lightning Bolt', 'common', 2.5, 'Instant', '3 damage.', '{R}');
    push('cccc0000-0000-4000-8000-000000000003', 'Krenko, Mob Boss', 'rare', 5, 'Legendary Creature — Goblin', 'Make goblins.', '{2}{R}{R}');
    for (let i = 0; i < 100; i++) {
      push(`dddd0000-0000-4000-8000-${String(i).padStart(12, '0')}`, `Filler Card ${i}`, i % 10 === 0 ? 'rare' : 'common', 0.2, 'Creature');
    }
    await ctx.pool.query(
      `INSERT INTO scryfall_cards (id, name, card_name, rarity, price, type_line, oracle_text, mana_cost, cmc) VALUES ${values.join(',')}`,
      params,
    );
    alice = await signup('alice_draft');
    bob = await signup('bob_draft');
  });

  afterAll(async () => {
    await closeContext(ctx);
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  it('serves the replay list and one replay by id', async () => {
    const all = await request(app).get('/api/sandbox/replays');
    expect(all.status).toBe(200);
    expect(all.body.replays.length).toBeGreaterThan(0);
    const one = await request(app).get(`/api/sandbox/replays/${all.body.replays[0].id}`);
    expect(one.body.replay.youtubeId).toBeTruthy();
    expect((await request(app).get('/api/sandbox/replays/nope')).status).toBe(404);
  });

  it('serves the AI meta decks', async () => {
    const r = await request(app).get('/api/sandbox/ai-meta-decks');
    expect(r.status).toBe(200);
    expect(r.body.decks.length).toBeGreaterThan(0);
    expect(r.body.decks[0].commander).toBeTruthy();
  });

  it('parses a decklist in one query, resolving names against the card table', async () => {
    const r = await request(app).post('/api/sandbox/parse-deck').send({
      deckText: [
        '// My deck',
        'Deck:',
        '1 Krenko, Mob Boss *CMDR*',
        '4x lightning bolt',
        '1 Sol Ring (C21) 263',
        '',
        '# comment',
      ].join('\n'),
    });
    expect(r.status).toBe(200);
    expect(r.body.cards).toHaveLength(3);
    const krenko = r.body.cards.find((c: { name: string }) => c.name === 'Krenko, Mob Boss');
    expect(krenko.isCommander).toBe(true);
    expect(krenko.qty).toBe(1);
    // The card table's official spelling wins over the list's casing.
    const bolt = r.body.cards.find((c: { qty: number }) => c.qty === 4);
    expect(bolt.name).toBe('Lightning Bolt');
    expect(bolt.oracleText).toBe('3 damage.');
    // Set codes and collector numbers are stripped.
    expect(r.body.cards.some((c: { name: string }) => c.name === 'Sol Ring')).toBe(true);
    expect(r.body.totalCards).toBe(6);
  });

  it('flags a name the card table does not know instead of inventing a Spell', async () => {
    const r = await request(app).post('/api/sandbox/parse-deck').send({ deckText: '1 Some Unreleased Card' });
    expect(r.body.cards[0].unresolved).toBe(true);
    expect(r.body.unresolved).toEqual(['Some Unreleased Card']);
  });

  it('rejects an empty or unreadable list', async () => {
    expect((await request(app).post('/api/sandbox/parse-deck').send({ deckText: '' })).status).toBe(400);
    expect((await request(app).post('/api/sandbox/parse-deck').send({ deckText: '// only a comment' })).status).toBe(400);
  });

  let draftId: string;

  it('requires a session to draft', async () => {
    expect((await request(app).post('/api/draft/create').send({ packSize: PACK_SIZE })).status).toBe(401);
    expect((await request(app).get('/api/draft/draft_x')).status).toBe(401);
  });

  it('creates a draft with eight seats and deals a pack to each', async () => {
    const r = await alice.post('/api/draft/create').send({ packSize: PACK_SIZE, setName: 'TST' });
    expect(r.status).toBe(201);
    draftId = r.body.draftId;
    expect(r.body.session.seats).toHaveLength(DRAFT_SEATS);
    expect(r.body.session.currentPack).toHaveLength(PACK_SIZE);
    expect(r.body.session.packNumber).toBe(1);
    expect(r.body.session.status).toBe('active');
    // Only the human's own pack is visible; other seats expose a count, not their cards.
    expect(r.body.session.seats[1].isBot).toBe(true);
    expect(r.body.session.seats[1]).not.toHaveProperty('pack');
  });

  it("hides a draft from anyone but its creator — legacy let any id holder pick", async () => {
    expect((await bob.get(`/api/draft/${draftId}`)).status).toBe(404);
    expect((await bob.post(`/api/draft/${draftId}/pick`).send({ cardIndex: 0 })).status).toBe(404);
    expect((await alice.get(`/api/draft/${draftId}`)).status).toBe(200);
  });

  it('survives a restart, because the session is in Redis and not a module Map', async () => {
    // A second app instance over the same Redis sees the same draft; legacy's Map did not.
    const second = createApp(ctx);
    const agent = request.agent(second);
    await agent.post('/api/auth/login').send({ username: 'alice_draft', password: PASSWORD });
    expect((await agent.get(`/api/draft/${draftId}`)).status).toBe(200);
  });

  it('shrinks every seat\'s pack on a pick, not just the human\'s', async () => {
    const before = await alice.get(`/api/draft/${draftId}`);
    expect(before.body.currentPack).toHaveLength(PACK_SIZE);
    const r = await alice.post(`/api/draft/${draftId}/pick`).send({ cardIndex: 0 });
    expect(r.status).toBe(200);
    expect(r.body.draftedPool).toHaveLength(1);
    // Packs rotate, so the human now holds a neighbour's pack — one card lighter, because that seat
    // picked too. Legacy never removed a bot's pick from its pack.
    expect(r.body.currentPack).toHaveLength(PACK_SIZE - 1);
    // Every bot drafted exactly one card as well.
    expect(r.body.seats.every((s: { picked: number }) => s.picked === 1)).toBe(true);
  });

  it('rejects a pick outside the pack', async () => {
    expect((await alice.post(`/api/draft/${draftId}/pick`).send({ cardIndex: 99 })).status).toBe(400);
    expect((await alice.post(`/api/draft/${draftId}/pick`).send({ cardIndex: 50 })).status).toBe(400);
  });

  it('opens the next pack only when the packs are exhausted, and finishes after three', async () => {
    // Drive the whole draft: packSize picks per round, DRAFT_PACKS rounds.
    let last = await alice.get(`/api/draft/${draftId}`);
    let guard = 0;
    while (last.body.status === 'active' && guard++ < 50) {
      const r = await alice.post(`/api/draft/${draftId}/pick`).send({ cardIndex: 0 });
      expect(r.status).toBe(200);
      last = { body: r.body } as typeof last;
    }
    expect(last.body.status).toBe('completed');
    expect(last.body.packNumber).toBe(DRAFT_PACKS);
    // Legacy checked the human's pack AFTER rotating, so it advanced the pack number on the wrong
    // signal; a correct draft ends with exactly packSize picks per round.
    expect(last.body.draftedPool).toHaveLength(PACK_SIZE * DRAFT_PACKS);
  });

  it('refuses a pick once the draft has finished', async () => {
    const r = await alice.post(`/api/draft/${draftId}/pick`).send({ cardIndex: 0 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DRAFT_COMPLETE');
  });

  it('404s an unknown or expired draft', async () => {
    expect((await alice.get('/api/draft/draft_gone')).status).toBe(404);
  });
});
