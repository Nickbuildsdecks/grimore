import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { io as connect, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import type { PodErrorEvent, PodStateEvent } from '@grimore/shared';
import { createRealtime, type Realtime } from './io.js';
import type { AckResult } from './handlers.js';
import { TokenBucket } from './ratelimit.js';
import { generateCode, toEngineFormat, maxSeatsFor } from './pod.js';
import { unpackView, type PackedView } from '@grimore/rules-engine';
import { POD_CODE_REGEX } from '@grimore/shared';

const REDIS_URL = process.env.REDIS_URL;

describe('ratelimit (pure)', () => {
  it('allows a burst then refills at the configured rate', () => {
    const b = new TokenBucket({ rate: 10, burst: 5 }, 0);
    for (let i = 0; i < 5; i++) expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.take(100)).toBe(true); // 0.1s * 10/s = 1 token
    expect(b.take(100)).toBe(false);
    expect(b.take(10_000)).toBe(true);
    expect(b.remaining).toBe(4);
  });
});

describe('pod helpers (pure)', () => {
  it('generates WORD-WORD-NN codes', () => {
    for (let i = 0; i < 50; i++) expect(generateCode()).toMatch(POD_CODE_REGEX);
  });
  it('maps shared formats onto engine formats', () => {
    expect(toEngineFormat('commander')).toBe('pod');
    expect(toEngineFormat('modern')).toBe('modern');
    expect(maxSeatsFor('commander')).toBe(4);
    expect(maxSeatsFor('standard')).toBe(2);
  });
});

type Client = Socket;

function emitAck(socket: Client, event: string, payload: unknown): Promise<AckResult> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), 5000);
    socket.emit(event, payload, (res: AckResult) => {
      clearTimeout(t);
      resolve(res);
    });
  });
}

function waitFor<T>(socket: Client, event: string, pred: (p: T) => boolean = () => true, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, ms);
    const handler = (p: T) => {
      if (!pred(p)) return;
      clearTimeout(t);
      socket.off(event, handler);
      resolve(p);
    };
    socket.on(event, handler);
  });
}

function okAck(res: AckResult): Extract<AckResult, { ok: true }> {
  if (!res.ok) throw new Error(`ack failed: ${res.error.code} ${res.error.message}`);
  return res;
}

describe.skipIf(!REDIS_URL)('realtime gateway (requires REDIS_URL)', () => {
  let rt: Realtime;
  let url: string;
  const clients: Client[] = [];

  beforeAll(async () => {
    rt = await createRealtime({
      redisUrl: REDIS_URL!,
      allowedOrigins: [],
      log: pino({ level: 'silent' }),
      store: { keyPrefix: `test:${Date.now().toString(36)}:${process.pid}` },
      rateLimit: { rate: 20, burst: 40 },
    });
    await new Promise<void>((resolve) => rt.httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = rt.httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.disconnect();
  });

  afterAll(async () => {
    await rt.store.flushPrefix();
    await rt.close();
  });

  async function client(name: string): Promise<Client> {
    const s = connect(url, { transports: ['websocket'], forceNew: true, auth: { name }, reconnection: false });
    clients.push(s);
    await waitFor(s, 'connect');
    return s;
  }

  /** Two players seated and readied: returns sockets, code, tokens and the latest state version. */
  async function seatedPair() {
    const a = await client('Alice');
    const b = await client('Bob');
    const created = okAck(await emitAck(a, 'pod:create', { name: 'Test Pod', format: 'commander', visibility: 'private' }));
    const code = created.code!;
    const bothSeated = waitFor<PodStateEvent>(a, 'pod:state', (s) => s.pod.seats.length === 2);
    const joined = okAck(await emitAck(b, 'pod:join', { code, name: 'Bob' }));
    await bothSeated;
    const dealt = waitFor<PodStateEvent>(b, 'pod:state', (s) => s.pod.status === 'in_progress');
    okAck(await emitAck(a, 'pod:ready', { ready: true }));
    okAck(await emitAck(b, 'pod:ready', { ready: true }));
    const state = await dealt;
    return { a, b, code, aToken: created.seatToken!, bToken: joined.seatToken!, state };
  }

  // The allow list is the one piece of configuration that silently stops a browser connecting, so
  // both of its states are pinned: unset means any origin, set means only those.
  it('accepts a browser on any origin when no allow list is configured', async () => {
    const s = connect(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { name: 'Browser' },
      extraHeaders: { Origin: 'http://some-other-host:1234' },
    });
    clients.push(s);
    await waitFor(s, 'connect');
    expect(s.connected).toBe(true);
  });

  // The other direction, which is the one that matters for security: a configured allow list has to
  // actually refuse everything else. Needs its own server because the allow list is fixed at start.
  it('refuses a browser from an origin outside a configured allow list', async () => {
    const guarded = await createRealtime({
      redisUrl: REDIS_URL!,
      allowedOrigins: ['https://grimore.gg'],
      log: pino({ level: 'silent' }),
      store: { keyPrefix: `test-origin:${Date.now().toString(36)}:${process.pid}` },
    });
    await new Promise<void>((resolve) => guarded.httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = guarded.httpServer.address() as AddressInfo;
    const guardedUrl = `http://127.0.0.1:${port}`;

    const attempt = (origin: string): Promise<string> =>
      new Promise((resolve) => {
        const s = connect(guardedUrl, {
          transports: ['websocket'],
          forceNew: true,
          reconnection: false,
          auth: { name: 'Browser' },
          extraHeaders: { Origin: origin },
        });
        const finish = (outcome: string) => {
          s.close();
          resolve(outcome);
        };
        s.on('connect', () => finish('connected'));
        s.on('connect_error', () => finish('refused'));
        setTimeout(() => finish('timeout'), 4000);
      });

    try {
      expect(await attempt('https://evil.example')).toBe('refused');
      expect(await attempt('https://grimore.gg')).toBe('connected');
    } finally {
      await guarded.store.flushPrefix();
      await guarded.close();
    }
  });

  it('serves /healthz', async () => {
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', checks: { redis: 'ok' } });
  });

  it('create + join: both clients receive pod:state with both seats', async () => {
    const a = await client('Alice');
    const b = await client('Bob');
    const created = okAck(await emitAck(a, 'pod:create', { name: 'Lobby', format: 'commander', visibility: 'public' }));
    expect(created.code).toMatch(POD_CODE_REGEX);
    expect(created.seatToken).toMatch(/^[0-9a-f]{32}$/);
    expect(created.seat).toBe(0);

    const aSees = waitFor<PodStateEvent>(a, 'pod:state', (s) => s.pod.seats.length === 2);
    const bSees = waitFor<PodStateEvent>(b, 'pod:state', (s) => s.pod.seats.length === 2);
    const joined = okAck(await emitAck(b, 'pod:join', { code: created.code!.toLowerCase(), name: 'Bob' }));
    expect(joined.seat).toBe(1);
    const [sa, sb] = await Promise.all([aSees, bSees]);
    expect(sa.stateVersion).toBe(sb.stateVersion);
    expect(sa.pod.code).toBe(created.code);
    expect(sa.pod.hostPlayerId).toBe(created.playerId);
    expect(sa.pod.seats.map((s) => s.name)).toEqual(['Alice', 'Bob']);
    expect(sa.state).toBeNull();

    // Public lobby shows up in pod:list for a third client.
    const c = await client('Carol');
    const list = waitFor<{ pods: { code: string; seatCount: number }[] }>(c, 'pod:list');
    okAck(await emitAck(c, 'pod:list', {}));
    const { pods } = await list;
    expect(pods.find((p) => p.code === created.code)?.seatCount).toBe(2);
  });

  it('life:adjust from seat 0 reaches seat 1 with stateVersion incremented', async () => {
    const { a, b, state } = await seatedPair();
    expect(state.state).not.toBeNull();
    const next = waitFor<PodStateEvent>(b, 'pod:state', (s) => s.stateVersion > state.stateVersion);
    okAck(
      await emitAck(a, 'pod:action', {
        action: { type: 'life:adjust', by: 0, seat: 0, delta: -3 },
        expectedVersion: state.stateVersion,
      }),
    );
    const seen = await next;
    expect(seen.stateVersion).toBe(state.stateVersion + 1);
    const game = seen.state as { seats: { life: number }[]; stateVersion: number };
    expect(game.seats[0]!.life).toBe(37);
    expect(game.seats[1]!.life).toBe(40);
    expect(game.stateVersion).toBe(1);
  });

  it('a stale expectedVersion yields pod:error version_conflict', async () => {
    const { a, state } = await seatedPair();
    const err = waitFor<PodErrorEvent>(a, 'pod:error');
    const res = await emitAck(a, 'pod:action', {
      action: { type: 'life:adjust', by: 0, seat: 0, delta: 1 },
      expectedVersion: state.stateVersion - 1,
    });
    expect(res.ok).toBe(false);
    expect((await err).code).toBe('version_conflict');
    // Pod untouched.
    const snap = await rt.store.get(state.pod.code);
    expect(snap?.stateVersion).toBe(state.stateVersion);
  });

  it('rejects an illegal action without advancing the version', async () => {
    const { b, state } = await seatedPair();
    const res = await emitAck(b, 'pod:action', {
      action: { type: 'life:adjust', by: 1, seat: 0, delta: -5 }, // Bob may not edit Alice's life
      expectedVersion: state.stateVersion,
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'illegal_action' } });
    expect((await rt.store.get(state.pod.code))?.stateVersion).toBe(state.stateVersion);
  });

  it('rejects an oversized chat payload and relays a normal one', async () => {
    const { a, b } = await seatedPair();
    const res = await emitAck(a, 'pod:chat', { text: 'x'.repeat(600) });
    expect(res).toMatchObject({ ok: false, error: { code: 'bad_payload' } });

    const chat = waitFor<{ name: string; text: string; seat: number | null }>(b, 'pod:chat');
    okAck(await emitAck(a, 'pod:chat', { text: 'gg' }));
    expect(await chat).toMatchObject({ name: 'Alice', text: 'gg', seat: 0 });
  });

  it('rejects malformed payloads with bad_payload', async () => {
    const a = await client('Alice');
    const res = await emitAck(a, 'pod:join', { code: 'nope', name: '' });
    expect(res).toMatchObject({ ok: false, error: { code: 'bad_payload' } });
    const res2 = await emitAck(a, 'pod:ready', { ready: true });
    expect(res2).toMatchObject({ ok: false, error: { code: 'not_in_pod' } });
  });

  it('trips the rate limiter on a burst', async () => {
    const a = await client('Spammer');
    const results = await Promise.all(Array.from({ length: 60 }, () => emitAck(a, 'pod:list', {})));
    const limited = results.filter((r) => !r.ok && r.error.code === 'rate_limited');
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(40);
    expect(limited.length).toBeGreaterThan(0);
  });

  it('lets a dropped client reclaim its seat with the seat token', async () => {
    const { a, b, code, bToken, state } = await seatedPair();
    const bobGone = waitFor<PodStateEvent>(a, 'pod:state', (s) => s.pod.seats[1]?.connected === false);
    b.disconnect();
    const gone = await bobGone;
    expect(gone.pod.seats).toHaveLength(2);
    expect(gone.pod.status).toBe('in_progress');

    const bobBack = waitFor<PodStateEvent>(a, 'pod:state', (s) => s.pod.seats[1]?.connected === true);
    const b2 = await client('Bob');
    const rejoined = okAck(await emitAck(b2, 'pod:join', { code, name: 'Bob', seatToken: bToken }));
    expect(rejoined.seat).toBe(1);
    expect(rejoined.playerId).toBe(state.pod.seats[1]!.playerId);
    const back = await bobBack;
    // The game is untouched by the reconnect. Asserted field by field rather than by comparing the
    // two payloads: each socket now receives the state as *its own seat* may see it, so Bob's view
    // and Alice's view of the same game are legitimately different objects (different `seat`, and
    // each one's own hand). Comparing them for equality only ever passed because every client used
    // to be sent the identical raw game state, hands and library order included.
    const before = state.state as { stateVersion: number; turn: number; seats: { life: number }[] };
    const after = back.state as { stateVersion: number; turn: number; seats: { life: number }[] };
    expect(after.stateVersion).toBe(before.stateVersion);
    expect(after.turn).toBe(before.turn);
    expect(after.seats.map((s) => s.life)).toEqual(before.seats.map((s) => s.life));

    // The reclaimed seat can act.
    const acted = waitFor<PodStateEvent>(a, 'pod:state', (s) => s.stateVersion > back.stateVersion);
    okAck(
      await emitAck(b2, 'pod:action', {
        action: { type: 'life:adjust', by: 1, seat: 1, delta: -2 },
        expectedVersion: back.stateVersion,
      }),
    );
    const g = (await acted).state as { seats: { life: number }[] };
    expect(g.seats[1]!.life).toBe(38);
  });

  it('concurrent joins get distinct seats and the pod fills at capacity (CAS retry path)', async () => {
    const a = await client('Alice');
    const created = okAck(await emitAck(a, 'pod:create', { name: 'Race', format: 'commander', visibility: 'private' }));
    const others = await Promise.all(['B', 'C', 'D', 'E'].map((n) => client(n)));
    const results = await Promise.all(others.map((s, i) => emitAck(s, 'pod:join', { code: created.code!, name: `P${i}` })));
    const seats = results.filter((r) => r.ok).map((r) => (r as { seat?: number }).seat);
    expect(seats.sort()).toEqual([1, 2, 3]);
    expect(results.filter((r) => !r.ok).map((r) => (r as { error: PodErrorEvent }).error.code)).toEqual(['pod_full']);
    const snap = await rt.store.get(created.code!);
    expect(snap?.pod.seats).toHaveLength(4);
    expect(snap?.stateVersion).toBe(3);
  });

  it('host leaving migrates the host and the pod is deleted when empty', async () => {
    const { a, b, code, state } = await seatedPair();
    const migrated = waitFor<PodStateEvent>(b, 'pod:state', (s) => s.pod.seats.length === 1);
    okAck(await emitAck(a, 'pod:leave', {}));
    const m = await migrated;
    expect(m.pod.hostPlayerId).toBe(state.pod.seats[1]!.playerId);
    // Alice conceded on leaving a dealt table, so the 1v1 finished with Bob winning.
    expect(m.pod.status).toBe('finished');
    expect((m.state as { winnerSeat: number }).winnerSeat).toBe(1);
    okAck(await emitAck(b, 'pod:leave', {}));
    expect(await rt.store.get(code)).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // A whole game of Magic, over sockets, with two clients.
  //
  // The engine's own suite proves the rules; this proves the thing players actually touch: that two
  // separate connections can run a game from shuffled decks to a winner, and that neither of them
  // is ever sent the other's hand. The second half of that is the part a client cannot be trusted
  // to do for itself, so it is asserted against every state payload the socket received, not just
  // the final one.
  // ───────────────────────────────────────────────────────────────────────────────────────────────

  interface View {
    seat: number | null;
    turn: number;
    started: boolean;
    finished: boolean;
    winnerSeat: number | null;
    seats: {
      life: number;
      handCount: number;
      libraryCount: number;
      battlefieldCount: number;
      graveyardCount: number;
      deckId: string | null;
    }[];
    cards: Record<string, { id: string; zone: string; zoneSeat: number; tapped: boolean; card?: { name: string } }>;
    zones: Record<string, string[]>;
    automation: {
      awaiting: { kind: string; seats: number[] } | null;
      you: {
        hasPriority: boolean;
        mustDiscard: number;
        mustDeclare: 'attackers' | 'blockers' | null;
        mustSettleHand: boolean;
        attackers: string[];
        plays: { kind: string; card: string; name: string }[];
      } | null;
    } | null;
  }
  /**
   * The view as a client holds it.
   *
   * The server sends the wire form — each card definition said once, the boring fields left out —
   * so this unpacks it exactly as `apps/web` does. Every redaction assertion below keeps its
   * meaning: a card a seat may not identify has no definition on the wire, so it has none here.
   */
  const viewOf = (e: PodStateEvent): View => {
    // A lobby payload carries no game yet, and callers below already handle that.
    const wire = e.state as unknown as PackedView | null;
    return (wire === null ? null : unpackView(wire)) as unknown as View;
  };
  /** The raw wire payload, for the claims that are about the wire rather than about the client. */
  const wireOf = (e: PodStateEvent): PackedView => e.state as unknown as PackedView;

  describe('a whole game over the wire', () => {
    it('two clients play from shuffled decks to a winner, and never see each other\u2019s hand', async () => {
      const nick = await client('Nick');
      const friend = await client('Friend');

      // Every state payload each socket is ever sent, so redaction can be checked over the whole
      // game rather than at one convenient moment.
      const nickSaw: PodStateEvent[] = [];
      const friendSaw: PodStateEvent[] = [];
      nick.on('pod:state', (e: PodStateEvent) => nickSaw.push(e));
      friend.on('pod:state', (e: PodStateEvent) => friendSaw.push(e));

      const created = okAck(await emitAck(nick, 'pod:create', { name: 'Kitchen Table', format: 'modern', visibility: 'private' }));
      const code = created.code!;
      const bothSeated = waitFor<PodStateEvent>(nick, 'pod:state', (s) => s.pod.seats.length === 2);
      okAck(await emitAck(friend, 'pod:join', { code, name: 'Friend' }));
      await bothSeated;

      // Ready up deals the table: the game exists but has not started, which is the window the
      // lobby uses to pick decks.
      okAck(await emitAck(nick, 'pod:ready', { ready: true }));
      const tableDealt = waitFor<PodStateEvent>(nick, 'pod:state', (s) => s.state !== null);
      const dealt = okAck(await emitAck(friend, 'pod:ready', { ready: true }));
      let version = dealt.stateVersion!;
      // The ack returns before the broadcast lands, so the deal has to be waited for rather than
      // assumed: reading the last captured payload here would read the one from before the deal.
      await tableDealt;
      expect(viewOf(nickSaw.at(-1)!).started).toBe(false);

      /**
       * Waits until a socket's captured payloads satisfy a predicate.
       *
       * The acting socket's own broadcast is awaited by `act`, but the *other* socket's copy
       * arrives independently. Reading its last payload straight after an action is a race that
       * only shows up when the machine is busy, so anything asserted about the non-acting side
       * waits for it instead.
       */
      const until = async (saw: PodStateEvent[], pred: (v: View) => boolean, ms = 5000): Promise<View> => {
        const deadline = Date.now() + ms;
        for (;;) {
          const last = saw.at(-1);
          const view = last === undefined ? null : viewOf(last);
          if (view !== null && pred(view)) return view;
          if (Date.now() > deadline) throw new Error('timed out waiting for the other client to catch up');
          await new Promise((r) => setTimeout(r, 25));
        }
      };

      /**
       * Sends one action and returns the view the acting socket then holds.
       *
       * Keyed on the version rather than on how many payloads have arrived, because the ack and the
       * broadcast are separate events and either can land first.
       */
      const act = async (socket: Client, action: Record<string, unknown>): Promise<View> => {
        const saw = socket === nick ? nickSaw : friendSaw;
        const res = okAck(await emitAck(socket, 'pod:action', { action, expectedVersion: version }));
        version = res.stateVersion!;
        if (!saw.some((e) => e.stateVersion >= version)) {
          await waitFor<PodStateEvent>(socket, 'pod:state', (s) => s.stateVersion >= version);
        }
        return viewOf(saw.at(-1)!);
      };

      await act(nick, { type: 'deck:load', seat: 0, deckId: 'ember-rush' });
      let v = await act(friend, { type: 'deck:load', seat: 1, deckId: 'verdant-guard' });
      expect(v.seats[0]!.deckId).toBe('ember-rush');
      expect(v.seats[1]!.deckId).toBe('verdant-guard');
      expect(v.seats[0]!.libraryCount).toBe(61);

      v = await act(nick, { type: 'game:start', firstSeat: 0 });
      expect(v.started).toBe(true);
      expect(v.seats[0]!.handCount).toBe(7);
      expect(v.seats[1]!.handCount).toBe(7);

      // ── Redaction, at the moment both hands exist ──────────────────────────────────────────────
      // Nick sent game:start, so Friend's copy arrives on its own schedule: waited for, not assumed.
      const nickView = viewOf(nickSaw.at(-1)!);
      const friendView = await until(friendSaw, (view) => view.started);
      expect(nickView.seat).toBe(0);
      expect(friendView.seat).toBe(1);

      const handOf = (view: View, seat: number): string[] => view.zones[`${seat}:hand`] ?? [];
      // Nick knows his own seven and none of Friend's.
      expect(handOf(nickView, 0)).toHaveLength(7);
      for (const id of handOf(nickView, 0)) expect(nickView.cards[id]!.card).toBeDefined();
      for (const id of handOf(nickView, 1)) expect(nickView.cards[id]!.card).toBeUndefined();
      // And the reverse, from the other connection.
      for (const id of handOf(friendView, 1)) expect(friendView.cards[id]!.card).toBeDefined();
      for (const id of handOf(friendView, 0)) expect(friendView.cards[id]!.card).toBeUndefined();
      // Neither library's order is on the wire at all, including one's own.
      expect(nickView.zones['0:library']).toBeUndefined();
      expect(nickView.zones['1:library']).toBeUndefined();
      expect(nickView.seats[0]!.libraryCount).toBe(54);

      // Friend mulligans and bottoms one.
      v = await act(friend, { type: 'mulligan', seat: 1 });
      expect(v.seats[1]!.handCount).toBe(7);
      const toBottom = handOf(v, 1)[0]!;
      v = await act(friend, { type: 'card:move', card: toBottom, toZone: 'library', position: 'bottom' });
      expect(v.seats[1]!.handCount).toBe(6);

      // ── Four turns each ───────────────────────────────────────────────────────────────────────
      for (let turn = 0; turn < 8; turn++) {
        const seat = turn % 2;
        const socket = seat === 0 ? nick : friend;
        await act(socket, { type: 'turn:untapAll', seat });
        if (turn > 0) await act(socket, { type: 'zone:draw', seat, count: 1 });
        const mine = viewOf((seat === 0 ? nickSaw : friendSaw).at(-1)!);
        const card = handOf(mine, seat)[0];
        if (card !== undefined) {
          await act(socket, { type: 'card:move', card, toZone: 'battlefield' });
          await act(socket, { type: 'card:tap', card, tapped: true });
        }
        v = await act(socket, { type: 'turn:pass' });
      }
      expect(v.turn).toBeGreaterThan(1);
      expect(v.seats[0]!.battlefieldCount).toBeGreaterThan(0);
      expect(v.seats[1]!.battlefieldCount).toBeGreaterThan(0);

      // A creature trades; a token squad arrives; combat is recorded as life.
      const board = Object.values(viewOf(nickSaw.at(-1)!).cards).filter((c) => c.zone === 'battlefield' && c.zoneSeat === 0);
      expect(board.length).toBeGreaterThan(0);
      v = await act(nick, { type: 'card:move', card: board[0]!.id, toZone: 'graveyard' });
      expect(v.seats[0]!.graveyardCount).toBe(1);
      v = await act(nick, {
        type: 'token:create',
        seat: 0,
        count: 3,
        card: { name: 'Goblin', typeLine: 'Token Creature \u2014 Goblin', manaCost: '', cmc: 0, power: '1', toughness: '1', oracleText: '', colors: ['R'] },
      });
      expect(v.seats[0]!.battlefieldCount).toBeGreaterThanOrEqual(3);

      v = await act(nick, { type: 'life:adjust', seat: 0, delta: -4 });
      expect(v.seats[0]!.life).toBe(16);
      v = await act(friend, { type: 'life:adjust', seat: 1, delta: -20 });

      // ── The game ends, both clients agree, and it refuses further play ────────────────────────
      expect(v.finished).toBe(true);
      expect(v.winnerSeat).toBe(0);
      const nickFinal = await until(nickSaw, (view) => view.finished);
      expect(nickFinal.winnerSeat).toBe(0);

      const dead = await emitAck(nick, 'pod:action', { action: { type: 'zone:draw', seat: 0, count: 1 }, expectedVersion: version });
      expect(dead).toMatchObject({ ok: false, error: { code: 'illegal_action' } });

      // ── Redaction held for the entire game, not just at the checkpoint above ──────────────────
      // Every card Friend ever held in hand, by id, from Friend's own payloads.
      // Lobby payloads carry no game yet, so a null state here is correct and not a gap in cover.
      const friendHandIds = new Set<string>();
      for (const e of friendSaw) {
        const fv = viewOf(e);
        if (fv === null) continue;
        for (const id of fv.zones['1:hand'] ?? []) friendHandIds.add(id);
      }
      expect(friendHandIds.size).toBeGreaterThan(7);
      // Nick was never told what any of them were while they were in that hand.
      let checked = 0;
      for (const e of nickSaw) {
        const nv = viewOf(e);
        if (nv === null) continue;
        for (const id of nv.zones['1:hand'] ?? []) {
          expect(nv.cards[id]!.card).toBeUndefined();
          // And on the wire, not only after unpacking. The packed form shares one definition
          // between every card that has it, so a leak here would be a hidden card carrying a key
          // into that shared table — which is the only way the dedup could give something away.
          expect(wireOf(e).cards[id]!.def).toBeUndefined();
          checked++;
        }
        // Nor was any library ever shipped to him.
        expect(nv.zones['0:library']).toBeUndefined();
        expect(nv.zones['1:library']).toBeUndefined();
      }
      expect(checked).toBeGreaterThan(20);
      // Nothing in the shared definition table that no visible card needed. With dedup by content
      // this is the second way a leak could happen: a definition shipped because a *hidden* card
      // wanted it, readable by anybody who got the payload.
      for (const e of nickSaw) {
        const wire = wireOf(e);
        if (wire === null) continue;
        const wanted = new Set(Object.values(wire.cards).map((c) => c.def).filter((k) => k !== undefined));
        expect(Object.keys(wire.defs).sort()).toEqual([...wanted].sort());
      }
    }, 30_000);

    it('refuses to let one client act for the other seat', async () => {
      // Deliberately the client that is *not* the host: the host may act for any seat by design, so
      // it is the wrong client to test the permission with. `b` joined, so `a` holds the table.
      const { b, state } = await seatedPair();
      // The server stamps `by` from the socket's own seat, so a forged `by` cannot take effect: the
      // action is attributed to the sender and the engine then refuses it.
      const res = await emitAck(b, 'pod:action', {
        action: { type: 'life:adjust', by: 0, seat: 0, delta: -5 },
        expectedVersion: state.stateVersion,
      });
      expect(res).toMatchObject({ ok: false, error: { code: 'illegal_action' } });
      expect(!res.ok && res.error.message).toMatch(/may not modify/);
    });

    it('lets the host act for any seat, which is how a table fixes a misclick', async () => {
      const { a, state } = await seatedPair();
      okAck(await emitAck(a, 'pod:action', {
        action: { type: 'life:adjust', seat: 1, delta: -3 },
        expectedVersion: state.stateVersion,
      }));
    });

    /**
     * One person, one table, a whole game.
     *
     * The thing being tested is not the rules — the engine's own suite covers those — but that the
     * server plays its seat *inside* the mutation that provoked it. A bot that replied in a
     * separate write would show the player their own move, then a gap, then the answer, and would
     * race another action against a state it had not finished moving in.
     */
    it('plays a whole game on its own against the server', async () => {
      const solo = await client('Solo');
      const saw: PodStateEvent[] = [];
      solo.on('pod:state', (e: PodStateEvent) => saw.push(e));

      const created = okAck(await emitAck(solo, 'pod:create', {
        name: 'Just me', format: 'modern', visibility: 'private', bots: 1, botDeck: 'tidal-mind',
      }));
      // Readying up is enough to deal the table: the server's seat is ready from the moment it
      // sits down, because there is nobody for it to wait for.
      const dealt = waitFor<PodStateEvent>(solo, 'pod:state', (s) => s.state !== null);
      let version = okAck(await emitAck(solo, 'pod:ready', { ready: true })).stateVersion!;
      const first = await dealt;
      expect(first.pod.seats).toHaveLength(2);
      expect(first.pod.seats[1]!.bot).toBe(true);
      // And it already has a deck, so nobody has to pick one for it.
      expect(viewOf(first).seats[1]!.deckId).toBe('tidal-mind');
      expect(viewOf(first).seats[1]!.libraryCount).toBe(61);

      const act = async (action: Record<string, unknown>): Promise<View> => {
        // Backs off on `rate_limited` exactly as the browser client does: a solo game is a burst
        // of actions from one socket, which is precisely what the limiter is there to shape.
        let ack = await emitAck(solo, 'pod:action', { action, expectedVersion: version });
        for (let retry = 0; retry < 8 && !ack.ok && ack.error.code === 'rate_limited'; retry += 1) {
          await new Promise((r) => setTimeout(r, 120));
          ack = await emitAck(solo, 'pod:action', { action, expectedVersion: version });
        }
        const res = okAck(ack);
        version = res.stateVersion!;
        if (!saw.some((e) => e.stateVersion >= version)) {
          await waitFor<PodStateEvent>(solo, 'pod:state', (s) => s.stateVersion >= version);
        }
        return viewOf(saw.at(-1)!);
      };

      await act({ type: 'deck:load', seat: 0, deckId: 'ember-rush' });
      await act({ type: 'game:start', firstSeat: 0 });
      let view = await act({ type: 'auto:start', firstSeat: 0 });

      // The server settled its own opening hand in the same action, so the only seat still
      // deciding is the person's.
      expect(view.automation).not.toBeNull();
      expect(view.automation!.awaiting).toEqual({ kind: 'mulligan', seats: [0] });

      view = await act({ type: 'auto:keep' });
      // With both hands settled the game has begun, and the server has already taken any turn of
      // its own that came first.
      expect(view.automation!.awaiting).toBeNull();
      expect(view.turn).toBeGreaterThanOrEqual(1);

      // Play it out by only ever doing what the table offers.
      const decisions: string[] = [];
      for (let move = 0; move < 400 && !view.finished; move++) {
        const you = view.automation?.you;
        if (you === undefined || you === null) break;
        // A card that stopped mid-resolution to ask comes before everything, including priority:
        // the spell is already resolving and nothing else is legal until it is answered. Without
        // this the game stops dead the first time this seat casts a tutor or a looting spell —
        // which is what a real client has to handle too.
        if (you.mustDecide !== null) {
          const ask = you.mustDecide;
          decisions.push(ask.prompt);
          view = await act({ type: 'auto:decide', cards: ask.candidates.slice(0, ask.min) });
          continue;
        }
        if (you.mustDiscard > 0) {
          const hand = view.zones['0:hand'] ?? [];
          if (hand.length === 0) break;
          view = await act({ type: 'auto:discard', card: hand[0]! });
          continue;
        }
        if (you.mustDeclare === 'attackers') {
          view = await act({ type: 'auto:attack', attackers: you.attackers.map((a) => ({ attacker: a, defender: 1 })) });
          continue;
        }
        if (you.mustDeclare === 'blockers') {
          view = await act({ type: 'auto:block', blocks: [] });
          continue;
        }
        if (!you.hasPriority) break;
        const land = you.plays.find((p) => p.kind === 'land');
        view = land === undefined ? await act({ type: 'auto:pass' }) : await act({ type: 'auto:playLand', card: land.card });
      }

      expect(view.finished).toBe(true);
      expect(view.winnerSeat).not.toBeNull();
      // The server played a real game: it has a board, a graveyard and a life total that moved.
      const theirs = view.seats[1]!;
      expect(theirs.libraryCount).toBeLessThan(54);
      expect(view.turn).toBeGreaterThan(4);
      // And the person never saw the server's hand, nor either library's order.
      for (const id of view.zones['1:hand'] ?? []) expect(view.cards[id]!.card).toBeUndefined();
      expect(view.zones['1:library']).toBeUndefined();
      expect(view.zones['0:library']).toBeUndefined();
      // Whatever questions came up over the wire were answered over the wire, and none was left
      // outstanding at the end — a game that ends mid-resolution has not ended.
      expect(view.automation!.awaiting).toBeNull();
    }, 60_000);

    it('closes a table when the last person leaves, rather than leaving the server playing alone', async () => {
      const solo = await client('Solo');
      const created = okAck(await emitAck(solo, 'pod:create', {
        name: 'Just me', format: 'modern', visibility: 'private', bots: 1,
      }));
      okAck(await emitAck(solo, 'pod:leave', {}));
      // The code is gone: rejoining it finds nothing.
      const rejoin = await emitAck(solo, 'pod:join', { code: created.code!, name: 'Solo' });
      expect(rejoin).toMatchObject({ ok: false });
    });

    it('reports a stale expectedVersion as a conflict without touching the game', async () => {
      const { a, b, state } = await seatedPair();
      const next = waitFor<PodStateEvent>(b, 'pod:state', (s) => s.stateVersion > state.stateVersion);
      okAck(await emitAck(a, 'pod:action', { action: { type: 'life:adjust', seat: 0, delta: -1 }, expectedVersion: state.stateVersion }));
      const after = await next;
      const stale = await emitAck(b, 'pod:action', { action: { type: 'life:adjust', seat: 1, delta: -1 }, expectedVersion: state.stateVersion });
      expect(stale).toMatchObject({ ok: false, error: { code: 'version_conflict' } });
      // The losing client re-sends against the version it now holds and succeeds.
      okAck(await emitAck(b, 'pod:action', { action: { type: 'life:adjust', seat: 1, delta: -1 }, expectedVersion: after.stateVersion }));
    });
  });

});
