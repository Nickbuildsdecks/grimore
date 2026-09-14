import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { parseEnv } from '@grimore/shared';
import { runMigrations } from '@grimore/db';
import { createApp, createContext, closeContext, type AppContext } from './app.js';
import { podSizes } from './routes/league.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const PASSWORD = 'correct-horse-battery';

describe('podSizes', () => {
  it('never seats a table outside 3-5, and never leaves anyone out', () => {
    for (let n = 3; n <= 40; n++) {
      const sizes = podSizes(n, '3');
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(n);
      for (const s of sizes) {
        expect(s).toBeGreaterThanOrEqual(3);
        expect(s).toBeLessThanOrEqual(5);
      }
    }
  });

  it('cannot pair fewer than three players', () => {
    expect(podSizes(0, '3')).toEqual([]);
    expect(podSizes(2, '3')).toEqual([]);
  });

  it('prefers four-player tables', () => {
    expect(podSizes(4, '3')).toEqual([4]);
    expect(podSizes(8, '3')).toEqual([4, 4]);
    // 6 cannot be two fours, so it splits into legal tables rather than seating a 2.
    expect(podSizes(6, '3')).toEqual([3, 3]);
    expect(podSizes(9, '3')).toEqual([4, 5]);
  });
});

describe.skipIf(!DATABASE_URL || !REDIS_URL)('league routes (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_league_test_${Date.now()}`;
  const players: { agent: ReturnType<typeof request.agent>; id: string; name: string }[] = [];
  let admin: ReturnType<typeof request.agent>;
  let adminId: string;
  let seasonId: string;

  async function signup(username: string) {
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/register').send({
      username, password: PASSWORD, storeNickname: username, email: `${username}@example.com`,
    })).status).toBe(201);
    const login = await agent.post('/api/auth/login').send({ username, password: PASSWORD });
    return { agent, id: login.body.user.id as string, name: username };
  }

  beforeAll(async () => {
    const dbAdmin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await dbAdmin.query(`CREATE DATABASE ${dbName}`);
    await dbAdmin.end();
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    ctx = await createContext(parseEnv({
      NODE_ENV: 'test', DATABASE_URL: u.toString(), REDIS_URL, SESSION_SECRET: 'test-secret', LOG_LEVEL: 'silent',
    }));
    await runMigrations(ctx.pool);
    app = createApp(ctx);

    const a = await signup('organizer');
    admin = a.agent;
    adminId = a.id;
    await ctx.pool.query(`UPDATE players SET is_admin = 1, role = 'admin' WHERE id = $1`, [adminId]);
    for (let i = 0; i < 6; i++) players.push(await signup(`player_${i}`));
    // Each player registers a deck to check in with.
    for (const p of players) {
      const deck = await p.agent.post('/api/decks/builder-save').send({
        deck_name: `${p.name} deck`, is_public: true,
        cards: [{ card_name: 'Krenko, Mob Boss', is_commander: true, cheapest_card_price: 2.5 }],
      });
      (p as unknown as { deckId: string }).deckId = deck.body.deckId;
    }
  });

  afterAll(async () => {
    await closeContext(ctx);
    const dbAdmin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await dbAdmin.query(`DROP DATABASE ${dbName}`);
    await dbAdmin.end();
  });

  const deckOf = (p: (typeof players)[number]) => (p as unknown as { deckId: string }).deckId;

  it('reports no active season rather than an empty body', async () => {
    const r = await request(app).get('/api/seasons/active');
    expect(r.status).toBe(200);
    expect(r.body).toBeNull(); // legacy returned undefined, which serialises to an unreadable body
    expect((await request(app).get('/api/leaderboards/season')).body).toEqual([]);
  });

  it('only an admin can create a season', async () => {
    expect((await request(app).post('/api/seasons').send({ name: 'S1' })).status).toBe(401);
    const asPlayer = await players[0].agent.post('/api/seasons').send({ name: 'S1' });
    expect(asPlayer.status).toBe(403);
    expect(asPlayer.body.error.code).toBe('FORBIDDEN');
  });

  it('creates a season with the rule columns the baseline never had', async () => {
    const r = await admin.post('/api/seasons').send({
      name: 'Season One', points_win: 5, points_draw: 1, points_entry: 1, points_kill: 1,
      budget_limit: 100, banlist: ['Sol Ring'], max_rares: 10, remainder_pref: '3',
    });
    expect(r.status).toBe(201);
    seasonId = r.body.seasonId;
    const active = await request(app).get('/api/seasons/active');
    expect(active.body.name).toBe('Season One');
    // budget_limit, banlist and max_rares do not exist in the baseline; 0009 adds them.
    expect(active.body.budget_limit).toBe(100);
    expect(active.body.banlist).toEqual(['Sol Ring']);
    expect(active.body.max_rares).toBe(10);
    // Every existing player gets a standings row for the new season.
    const rows = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM player_stats WHERE season_id = $1', [seasonId]);
    expect(rows.rows[0].n).toBe(players.length + 1);
  });

  it('creating a second season deactivates the first, atomically', async () => {
    const second = await admin.post('/api/seasons').send({ name: 'Season Two' });
    expect(second.status).toBe(201);
    const actives = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM seasons WHERE is_active = 1');
    // 0009 adds a unique index so two active seasons cannot coexist even by accident.
    expect(actives.rows[0].n).toBe(1);
    expect((await request(app).get('/api/seasons/active')).body.name).toBe('Season Two');
    expect((await request(app).get('/api/seasons')).body).toHaveLength(2);

    // Back to Season One for the rest of the suite.
    await ctx.pool.query('UPDATE seasons SET is_active = 0');
    await ctx.pool.query('UPDATE seasons SET is_active = 1 WHERE id = $1', [seasonId]);
  });

  it('edits only the rules that were sent', async () => {
    const r = await admin.post('/api/seasons/rules').send({ points_kill: 2 });
    expect(r.status).toBe(200);
    expect(r.body.season.points_kill).toBe(2);
    // Legacy wrote all eleven columns, so an omitted field was reset.
    expect(r.body.season.name).toBe('Season One');
    expect(r.body.season.banlist).toEqual(['Sol Ring']);
    expect((await players[0].agent.post('/api/seasons/rules').send({ points_kill: 99 })).status).toBe(403);
  });

  it('checks a player in with their own deck, and refuses someone else\'s', async () => {
    const r = await players[0].agent.post('/api/roster/checkin').send({ deckId: deckOf(players[0]) });
    expect(r.status).toBe(200);
    const status = await players[0].agent.get('/api/roster/status');
    expect(status.body).toEqual({ checkedIn: true, deckId: deckOf(players[0]) });

    // Legacy accepted any deck id at all, including another player's.
    const stolen = await players[1].agent.post('/api/roster/checkin').send({ deckId: deckOf(players[0]) });
    expect(stolen.status).toBe(400);
    expect((await players[1].agent.post('/api/roster/checkin').send({ deckId: 'd_nope' })).status).toBe(400);
  });

  it('checking in twice replaces the entry rather than duplicating it', async () => {
    await players[0].agent.post('/api/roster/checkin').send({ deckId: deckOf(players[0]) });
    const rows = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM active_roster WHERE player_id = $1', [players[0].id]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('checks out, and lists the roster with deck detail', async () => {
    expect((await players[0].agent.post('/api/roster/checkout')).status).toBe(200);
    expect((await players[0].agent.get('/api/roster/status')).body.checkedIn).toBe(false);

    for (const p of players) await p.agent.post('/api/roster/checkin').send({ deckId: deckOf(p) });
    const list = await request(app).get('/api/roster/list');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(6);
    expect(list.body[0].deck_name).toBe('player_0 deck');
    expect(list.body[0].store_nickname).toBe('player_0');
  });

  it('an organizer can check a player in and out; a player cannot', async () => {
    expect((await players[1].agent.post('/api/roster/admin-checkout').send({ playerId: players[0].id })).status).toBe(403);
    expect((await admin.post('/api/roster/admin-checkout').send({ playerId: players[0].id })).status).toBe(200);
    expect((await admin.post('/api/roster/admin-checkout').send({ playerId: players[0].id })).status).toBe(404);
    expect((await admin.post('/api/roster/admin-checkin').send({ playerId: players[0].id, deckId: deckOf(players[0]) })).status).toBe(200);
    expect((await admin.post('/api/roster/admin-checkin').send({ playerId: 'p_ghost' })).status).toBe(404);
  });

  let podIds: string[] = [];

  it('refuses to pair without enough players, and requires an organizer', async () => {
    expect((await players[0].agent.post('/api/pairings/generate').send({ roundNum: 1 })).status).toBe(403);
    for (const p of players.slice(2)) await p.agent.post('/api/roster/checkout');
    const tooFew = await admin.post('/api/pairings/generate').send({ roundNum: 1 });
    expect(tooFew.status).toBe(400);
    expect(tooFew.body.error.code).toBe('TOO_FEW_PLAYERS');
    for (const p of players) await p.agent.post('/api/roster/checkin').send({ deckId: deckOf(p) });
  });

  it('pairs a round into legal pods and notifies every seated player', async () => {
    const r = await admin.post('/api/pairings/generate').send({ roundNum: 1 });
    expect(r.status).toBe(201);
    expect(r.body.pods).toHaveLength(2); // 6 players -> [3, 3]
    podIds = r.body.pods.map((p: { id: string }) => p.id);

    const seats = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM pod_results');
    expect(seats.rows[0].n).toBe(6);
    // notifications.id is a serial and `type` is NOT NULL: legacy supplied a text id and no type, so
    // every pairing notification raised.
    const notes = await ctx.pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE title = 'Round pairings posted'`);
    expect(notes.rows[0].n).toBe(6);
  });

  it('refuses to pair the same round twice (legacy silently doubled it)', async () => {
    const again = await admin.post('/api/pairings/generate').send({ roundNum: 1 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ROUND_EXISTS');
    const pods = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM pods WHERE round_num = 1');
    expect(pods.rows[0].n).toBe(2);
  });

  it('serves a round with its seats resolved', async () => {
    const r = await request(app).get('/api/pairings/round/1');
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    expect(r.body[0].players).toHaveLength(3);
    expect(r.body[0].players[0].store_nickname).toBeTruthy();
    expect(r.body[0].players[0].deck_name).toContain('deck');
    expect(r.body[0].completed).toBe(false);
    expect((await request(app).get('/api/pairings/round/9')).body).toEqual([]);
  });

  it('REFUSES AN UNAUTHENTICATED SCORE REPORT — legacy had no auth on this route at all', async () => {
    const seats = await ctx.pool.query('SELECT player_id FROM pod_results WHERE pod_id = $1', [podIds[0]]);
    const results = seats.rows.map((s, i) => ({ player_id: s.player_id, kills: 0, placed_first: i === 0, placed_draw: false }));
    // Anyone who could reach the server could post arbitrary results for any pod.
    const anon = await request(app).post(`/api/pairings/report/${podIds[0]}`).send({ results });
    expect(anon.status).toBe(401);

    // A player seated at a DIFFERENT pod is not an organizer and cannot report this one.
    const otherPodSeats = await ctx.pool.query('SELECT player_id FROM pod_results WHERE pod_id = $1', [podIds[1]]);
    const outsider = players.find((p) => p.id === otherPodSeats.rows[0].player_id)!;
    expect((await outsider.agent.post(`/api/pairings/report/${podIds[0]}`).send({ results })).status).toBe(403);
  });

  it('rejects an impossible result before it can reach the standings', async () => {
    const seats = await ctx.pool.query('SELECT player_id FROM pod_results WHERE pod_id = $1 ORDER BY player_id', [podIds[0]]);
    const ids = seats.rows.map((s) => s.player_id as string);
    const reporter = players.find((p) => p.id === ids[0])!;
    const send = (results: unknown) => reporter.agent.post(`/api/pairings/report/${podIds[0]}`).send({ results });

    // Two winners.
    expect((await send(ids.map((id) => ({ player_id: id, kills: 0, placed_first: true })))).status).toBe(400);
    // A winner and a draw at once.
    expect((await send([
      { player_id: ids[0], kills: 0, placed_first: true },
      { player_id: ids[1], kills: 0, placed_draw: true },
      { player_id: ids[2], kills: 0 },
    ])).status).toBe(400);
    // A player who is not at this table.
    expect((await send([
      { player_id: ids[0], kills: 0, placed_first: true },
      { player_id: ids[1], kills: 0 },
      { player_id: 'p_stranger', kills: 0 },
    ])).status).toBe(400);
  });

  it('scores a pod and rebuilds the standings', async () => {
    const seats = await ctx.pool.query('SELECT player_id, deck_id FROM pod_results WHERE pod_id = $1 ORDER BY player_id', [podIds[0]]);
    const ids = seats.rows.map((s) => s.player_id as string);
    const reporter = players.find((p) => p.id === ids[0])!;
    const r = await reporter.agent.post(`/api/pairings/report/${podIds[0]}`).send({
      results: [
        { player_id: ids[0], kills: 2, placed_first: true },
        { player_id: ids[1], kills: 1, placed_first: false },
        { player_id: ids[2], kills: 0, placed_first: false },
      ],
    });
    expect(r.status).toBe(200);

    // entry 1 + win 5 + 2 kills * 2 = 10; second place: entry 1 + 1 kill * 2 = 3; third: entry 1.
    const board = await request(app).get('/api/leaderboards/season');
    const winner = board.body.find((s: { player_id: string }) => s.player_id === ids[0]);
    expect(winner.total_points).toBe(10);
    expect(winner.total_wins).toBe(1);
    expect(winner.total_kills).toBe(2);
    expect(board.body.find((s: { player_id: string }) => s.player_id === ids[1]).total_points).toBe(3);
    expect(board.body.find((s: { player_id: string }) => s.player_id === ids[2]).total_points).toBe(1);
    // Highest points first.
    expect(board.body[0].player_id).toBe(ids[0]);

    const decks = await request(app).get('/api/leaderboards/decks');
    expect(decks.body[0].total_points).toBe(10);
    expect(decks.body[0].deck_name).toBeTruthy();
  });

  it('refuses a second report for the same pod', async () => {
    const seats = await ctx.pool.query('SELECT player_id FROM pod_results WHERE pod_id = $1 ORDER BY player_id', [podIds[0]]);
    const ids = seats.rows.map((s) => s.player_id as string);
    const reporter = players.find((p) => p.id === ids[0])!;
    const again = await reporter.agent.post(`/api/pairings/report/${podIds[0]}`).send({
      results: ids.map((id) => ({ player_id: id, kills: 9, placed_first: false })),
    });
    expect(again.status).toBe(409);
    // The standings are untouched by the rejected report.
    const board = await request(app).get('/api/leaderboards/season');
    expect(board.body.find((s: { player_id: string }) => s.player_id === ids[0]).total_points).toBe(10);
  });

  it('an organizer may report a pod they did not play in', async () => {
    const seats = await ctx.pool.query('SELECT player_id FROM pod_results WHERE pod_id = $1 ORDER BY player_id', [podIds[1]]);
    const ids = seats.rows.map((s) => s.player_id as string);
    const r = await admin.post(`/api/pairings/report/${podIds[1]}`).send({
      results: ids.map((id, i) => ({ player_id: id, kills: 0, placed_draw: i < 3 })),
    });
    expect(r.status).toBe(200);
    // A draw pays entry + draw = 1 + 1 = 2 to everyone.
    const board = await request(app).get('/api/leaderboards/season');
    expect(board.body.find((s: { player_id: string }) => s.player_id === ids[0]).total_points).toBe(2);
  });

  it('keeps standings separate per season', async () => {
    // player_stats was keyed on player_id alone, so a second season overwrote the first.
    const other = await ctx.pool.query(`SELECT id FROM seasons WHERE name = 'Season Two'`);
    const otherId = other.rows[0].id;
    const board = await request(app).get(`/api/leaderboards/season?seasonId=${otherId}`);
    expect(board.body.every((s: { total_points: number }) => s.total_points === 0)).toBe(true);
    const one = await request(app).get(`/api/leaderboards/season?seasonId=${seasonId}`);
    expect(one.body.some((s: { total_points: number }) => s.total_points === 10)).toBe(true);
  });

  it('end-round reports unreported pods and can clear the roster', async () => {
    expect((await players[0].agent.post('/api/pairings/end-round').send({})).status).toBe(403);
    // Legacy's end-round returned success without doing anything at all.
    const keep = await admin.post('/api/pairings/end-round').send({ keepRoster: true });
    expect(keep.body).toMatchObject({ success: true, unreportedPods: 0, rosterCleared: false });
    expect((await request(app).get('/api/roster/list')).body).toHaveLength(6);

    const clear = await admin.post('/api/pairings/end-round').send({ keepRoster: false });
    expect(clear.body.rosterCleared).toBe(true);
    expect((await request(app).get('/api/roster/list')).body).toEqual([]);
  });

  it('lets a player register for a season, and 404s an unknown one', async () => {
    const other = await ctx.pool.query(`SELECT id FROM seasons WHERE name = 'Season Two'`);
    expect((await players[0].agent.post(`/api/seasons/${other.rows[0].id}/register`)).status).toBe(200);
    expect((await players[0].agent.post('/api/seasons/season_nope/register')).status).toBe(404);
    expect((await request(app).post(`/api/seasons/${other.rows[0].id}/register`)).status).toBe(401);
  });

  it('closes check-in when the season says so', async () => {
    await admin.post('/api/seasons/rules').send({ checkin_enabled: false });
    const r = await players[0].agent.post('/api/roster/checkin').send({ deckId: deckOf(players[0]) });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CHECKIN_CLOSED');
    await admin.post('/api/seasons/rules').send({ checkin_enabled: true });
  });
});

describe('classifyArchetype', () => {
  it('reads the archetype out of the deck name, defaulting to Other', async () => {
    const { classifyArchetype } = await import('@grimore/shared');
    expect(classifyArchetype('Azorius Control')).toBe('Control');
    expect(classifyArchetype('goblin STOMPY')).toBe('Aggro');
    expect(classifyArchetype('Storm Brew')).toBe('Combo');
    expect(classifyArchetype('Elves!')).toBe('Tribal');
    expect(classifyArchetype('Hatebears')).toBe('Stax');
    expect(classifyArchetype('Krenko Goodstuff')).toBe('Other');
    expect(classifyArchetype(null)).toBe('Other');
  });
});

describe.skipIf(!DATABASE_URL || !REDIS_URL)('league analytics + admin (requires DATABASE_URL + REDIS_URL)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;
  const dbName = `grimore_analytics_test_${Date.now()}`;
  let admin: ReturnType<typeof request.agent>;
  let adminId: string;
  let second: ReturnType<typeof request.agent>;
  let secondId: string;
  let player: ReturnType<typeof request.agent>;
  let playerId: string;
  let seasonId: string;

  async function signup(username: string) {
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/register').send({
      username, password: PASSWORD, storeNickname: username, email: `${username}@example.com`,
    })).status).toBe(201);
    const login = await agent.post('/api/auth/login').send({ username, password: PASSWORD });
    return { agent, id: login.body.user.id as string };
  }

  beforeAll(async () => {
    const dbAdmin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await dbAdmin.query(`CREATE DATABASE ${dbName}`);
    await dbAdmin.end();
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    ctx = await createContext(parseEnv({
      NODE_ENV: 'test', DATABASE_URL: u.toString(), REDIS_URL, SESSION_SECRET: 'test-secret', LOG_LEVEL: 'silent',
    }));
    await runMigrations(ctx.pool);
    app = createApp(ctx);

    ({ agent: admin, id: adminId } = await signup('boss'));
    ({ agent: second, id: secondId } = await signup('deputy'));
    ({ agent: player, id: playerId } = await signup('regular'));
    await ctx.pool.query(`UPDATE players SET is_admin = 1, role = 'admin' WHERE id = $1`, [adminId]);

    seasonId = 'season_analytics';
    await ctx.pool.query(
      `INSERT INTO seasons (id, name, is_active, points_win, points_draw, points_entry, points_kill)
       VALUES ($1, 'Analytics', 1, 5, 1, 1, 1)`,
      [seasonId],
    );
    // Three decks with archetype-bearing names and different legality verdicts.
    const decks: [string, string, string, number, number][] = [
      ['d_ctrl', adminId, 'Azorius Control', 250, 1],
      ['d_aggro', secondId, 'Goblin Aggro', 40, 1],
      ['d_combo', playerId, 'Storm Combo', 900, 0],
    ];
    for (const [id, owner, name, price, legal] of decks) {
      await ctx.pool.query(
        `INSERT INTO decks (id, player_id, moxfield_url, deck_name, cheapest_total_price, is_public, is_legal)
         VALUES ($1, $2, $3, $4, $5, 1, $6)`,
        [id, owner, 'visual-' + id, name, price, legal],
      );
      await ctx.pool.query('INSERT INTO deck_stats (deck_id, season_id) VALUES ($1, $2)', [id, seasonId]);
    }
  });

  afterAll(async () => {
    await closeContext(ctx);
    const dbAdmin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await dbAdmin.query(`DROP DATABASE ${dbName}`);
    await dbAdmin.end();
  });

  it('reports the season meta from the stored legality verdict, not a hard-coded price', async () => {
    const r = await request(app).get(`/api/seasons/${seasonId}/meta`);
    expect(r.status).toBe(200);
    expect(r.body.totalDecks).toBe(3);
    // (250 + 40 + 900) / 3
    expect(r.body.averagePrice).toBeCloseTo(396.67, 2);
    // Legacy called a deck legal if it cost under $100, ignoring the season's banlist, rarity, colour
    // and budget rules. Two of three decks carry is_legal = 1, including a $250 one.
    expect(r.body.legalityRate).toBeCloseTo(66.7, 1);
    expect(r.body.breakdown.map((b: { name: string }) => b.name).sort()).toEqual(['Aggro', 'Combo', 'Control']);
    expect(r.body.breakdown[0].percentage).toBeCloseTo(33.3, 1);
  });

  it('distinguishes an empty season from one where everything is illegal', async () => {
    const r = await request(app).get('/api/seasons/season_empty/meta');
    expect(r.status).toBe(200);
    // Legacy divided by `length || 1`, so an empty season reported 0% legality and a 0.00 average --
    // the same numbers as a season full of illegal free decks.
    expect(r.body).toMatchObject({ totalDecks: 0, averagePrice: 0, legalityRate: 0, breakdown: [] });
  });

  it('builds an archetype matchup matrix with win rates already computed', async () => {
    await ctx.pool.query(
      `INSERT INTO pods (id, season_id, round_num, pod_label, completed) VALUES ('pod_m', $1, 1, 1, 1)`,
      [seasonId],
    );
    await ctx.pool.query(
      `INSERT INTO pod_results (pod_id, player_id, deck_id, placed_first) VALUES
        ('pod_m', $1, 'd_ctrl', 1), ('pod_m', $2, 'd_aggro', 0), ('pod_m', $3, 'd_combo', 0)`,
      [adminId, secondId, playerId],
    );
    const r = await request(app).get(`/api/seasons/${seasonId}/matrix`);
    expect(r.status).toBe(200);
    expect(r.body.archetypes).toContain('Control');
    // Control beat both others, so it is 100% against each of them.
    expect(r.body.matrix.Control.Aggro).toMatchObject({ wins: 1, total: 1, winRate: 100 });
    expect(r.body.matrix.Aggro.Control).toMatchObject({ wins: 0, total: 1, winRate: 0 });
    // Legacy returned raw wins/total and left the division (and the divide-by-zero guard) to callers.
    expect(r.body.matrix.Control.Stax).toMatchObject({ wins: 0, total: 0, winRate: 0 });
  });

  it('excludes unreported pods from the matrix', async () => {
    await ctx.pool.query(
      `INSERT INTO pods (id, season_id, round_num, pod_label, completed) VALUES ('pod_open', $1, 2, 1, 0)`,
      [seasonId],
    );
    await ctx.pool.query(
      `INSERT INTO pod_results (pod_id, player_id, deck_id, placed_first) VALUES
        ('pod_open', $1, 'd_aggro', 1), ('pod_open', $2, 'd_combo', 0)`,
      [secondId, playerId],
    );
    const r = await request(app).get(`/api/seasons/${seasonId}/matrix`);
    // Still only the one completed pod's pairings.
    expect(r.body.matrix.Aggro.Combo.total).toBe(1);
  });

  it('surfaces the caller\'s open pod even when a later round exists without them', async () => {
    const r = await second.get('/api/players/active-match');
    expect(r.status).toBe(200);
    expect(r.body.hasActiveMatch).toBe(true);
    // Legacy took MAX(round_num) and looked for the player in it, so a player who sat out the newest
    // round saw "no active match" while their own unreported pod was still open.
    expect(r.body.podId).toBe('pod_open');
    expect(r.body.completed).toBe(false);
    expect(r.body.players).toHaveLength(2);
    expect(r.body.scoring.pointsWin).toBe(5);

    // The admin only ever played the completed pod, so that is what they see.
    const done = await admin.get('/api/players/active-match');
    expect(done.body.podId).toBe('pod_m');
    expect(done.body.completed).toBe(true);
  });

  it('reports no match for a player with no pods, and 401s anonymously', async () => {
    const { agent } = await signup('bystander');
    expect((await agent.get('/api/players/active-match')).body.hasActiveMatch).toBe(false);
    expect((await request(app).get('/api/players/active-match')).status).toBe(401);
  });

  it('lists players for an admin only', async () => {
    expect((await request(app).get('/api/players/list')).status).toBe(401);
    expect((await player.get('/api/players/list')).status).toBe(403);
    const r = await admin.get('/api/players/list');
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThanOrEqual(4);
    expect(r.body[0]).toHaveProperty('role');
    // Password hashes must not appear in an admin listing.
    expect(r.body[0]).not.toHaveProperty('password_hash');
  });

  it('changes a role, and refuses an invalid one', async () => {
    expect((await admin.post(`/api/players/${playerId}/role`).send({ role: 'judge' })).status).toBe(200);
    const row = await ctx.pool.query('SELECT role, is_admin FROM players WHERE id = $1', [playerId]);
    expect(row.rows[0]).toMatchObject({ role: 'judge', is_admin: 0 });
    expect((await admin.post(`/api/players/${playerId}/role`).send({ role: 'overlord' })).status).toBe(400);
    expect((await admin.post('/api/players/p_ghost/role').send({ role: 'judge' })).status).toBe(404);
    expect((await player.post(`/api/players/${adminId}/role`).send({ role: 'player' })).status).toBe(403);
  });

  it('REFUSES to remove the last administrator — legacy would lock everyone out permanently', async () => {
    // Demoting yourself as the only admin leaves no way back into any administrative function.
    const self = await admin.post(`/api/players/${adminId}/role`).send({ role: 'player' });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('LAST_ADMIN');

    // With a second admin in place, stepping down is allowed.
    expect((await admin.post(`/api/players/${secondId}/role`).send({ role: 'admin' })).status).toBe(200);
    expect((await second.post(`/api/players/${adminId}/role`).send({ role: 'player' })).status).toBe(200);
    // And now the remaining admin cannot demote themselves either.
    const last = await second.post(`/api/players/${secondId}/role`).send({ role: 'player' });
    expect(last.status).toBe(409);
    const admins = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM players WHERE is_admin = 1');
    expect(admins.rows[0].n).toBe(1);
  });
});
