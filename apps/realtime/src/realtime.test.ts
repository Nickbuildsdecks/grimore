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
  /**
   * Every time the server's own seats could not move, across every test in this file.
   *
   * A pod left waiting on a seat the server plays is a dead table — nobody on the clock, no move
   * offered, and the only thing on screen whichever error happened last — and it is invisible from
   * the outside, which is how one went unexplained for a debugging session. Collected here so the
   * whole-game tests below can assert it never happened, rather than trusting a log line.
   */
  const stalls: { code: string; reason: string }[] = [];

  beforeAll(async () => {
    rt = await createRealtime({
      redisUrl: REDIS_URL!,
      allowedOrigins: [],
      log: pino({ level: 'silent' }),
      store: {
        keyPrefix: `test:${Date.now().toString(36)}:${process.pid}`,
        onBotStall: (info) => stalls.push(info),
      },
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
    /*
      And the refusal says *when*, which is the only way a client can tell two things apart that
      arrive as the same code: a play the table had already moved past, which is nobody's fault
      and must not raise a banner, and a play the table offered at the current version, which is a
      disagreement between the table and the engine and must. The client's own last-seen version
      cannot settle it — a broadcast can carry the rendered view past the last ack, and then it
      reads the wrong way round.
    */
    expect(res.ok === false && res.error.stateVersion).toBe(state.stateVersion);
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
      // Its own code, not `illegal_action`: the action was fine, the game ended under it.
      expect(dead).toMatchObject({ ok: false, error: { code: 'game_finished' } });

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
        /*
          Backs off on `rate_limited` exactly as the browser client does: a solo game is a burst of
          actions from one socket, which is precisely what the limiter is there to shape.

          The wait grows with each attempt, which the fixed 120ms version did not. This test plays
          a whole game — several hundred actions — through a limiter that allows twenty a second,
          and when the suite runs beside five other packages' tests the window moves slowly enough
          that eight equal waits can all land inside it. It failed once that way, passed alone, and
          a flake in the test that proves a person can play a game on their own is worse than the
          second it costs to back off properly.
        */
        let ack = await emitAck(solo, 'pod:action', { action, expectedVersion: version });
        for (let retry = 0; retry < 10 && !ack.ok && ack.error.code === 'rate_limited'; retry += 1) {
          await new Promise((r) => setTimeout(r, 120 * (retry + 1)));
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
      /*
        Why the loop stopped, for the assertion below.

        This test failed once in a parallel run and passed every time it was run alone, which is
        the least useful kind of failure: "expected false to be true" says nothing about whether
        the game ran out of moves, stalled on a prompt this loop cannot answer, or lost priority.
        So the loop records its own exit and the assertion prints it.
      */
      let stopped = 'the move cap';
      let moves = 0;
      /*
        The cap, measured rather than guessed — which is D87's rule, and this is the constant that
        had been breaking it.

        Every pod seeds its shuffle from an id carrying a timestamp, so each run of this test is a
        different game; and the client below casts nothing, so the game is the bot grinding a
        do-nothing opponent from twenty to zero. Played out over 200 random shuffles with the same
        two decks and this same loop: **median 137 moves, p90 216, p99 307, longest 488 — and one
        game in two hundred over 400.** The old cap was 400, which is why this test failed once in
        a parallel run and then passed twelve times in a row: nothing was flaky but the shuffle.

        1200 is two and a half times the worst of those two hundred games, and still catches what
        the cap is for — a genuine stall hits it with the game nowhere near finished, and the
        assertion below prints the turn and step it stopped on.
      */
      for (let move = 0; move < 1200 && !view.finished; move++) {
        moves = move + 1;
        const you = view.automation?.you;
        if (you === undefined || you === null) {
          stopped = 'the view stopped reporting this seat';
          break;
        }
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
          if (hand.length === 0) {
            stopped = 'a discard was owed with an empty hand';
            break;
          }
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
        // The damage assignment order (CR 509.2). Left as the engine offered it, which is what
        // this client is for: it only ever does what the table hands it.
        if (you.mustDeclare === 'order') {
          view = await act({ type: 'auto:order', orders: you.mustOrder.map((ask) => ({ ...ask })) });
          continue;
        }
        if (!you.hasPriority) {
          stopped = `nobody held priority at ${view.automation?.step} on turn ${view.turn}`;
          break;
        }
        const land = you.plays.find((p) => p.kind === 'land');
        view = land === undefined ? await act({ type: 'auto:pass' }) : await act({ type: 'auto:playLand', card: land.card });
      }

      // Says what happened when it did not finish, rather than only that it did not.
      expect(
        view.finished,
        `stopped after ${moves} moves on turn ${view.turn} at ${view.automation?.step}: ${stopped}`,
      ).toBe(true);
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
      /*
        And the server's seat was never left with nothing to do.

        A whole game is several hundred chances for `runBots` to take one of its four silent ways
        out, each of which leaves the pod waiting on a seat nobody will move. Asserted here rather
        than trusted to a log line, because the symptom — a table where nobody is on the clock —
        reads to a player as the server having lost their move, and reads to a browser suite as
        an idle timeout four seconds later with nothing to go on.
      */
      expect(stalls, JSON.stringify(stalls)).toEqual([]);

      // One more action, now that there is a winner. It is refused — and refused as its own thing
      // rather than as an illegal action, which is the whole point: a client sends the pass that
      // ends a game and the pass queued behind it, and the second one must not land as a red error
      // over "Nick wins". The browser client swallows exactly this code.
      // Against the newest version the table has broadcast, not the last ack's: the point of this
      // assertion is the engine's answer, and sending a version behind would ask the store's
      // concurrency check instead, which answers first and says something else.
      const latest = saw.reduce((top, e) => Math.max(top, e.stateVersion), version);
      // Backing off on `rate_limited` like every other send in this test: a whole game is several
      // hundred actions from one socket, and this one arrives at the end of that burst. It failed
      // that way once in six runs, reading `rate_limited` where the engine's answer was wanted.
      let afterwards = await emitAck(solo, 'pod:action', {
        action: { type: 'auto:pass' }, expectedVersion: latest,
      });
      for (let retry = 0; retry < 10 && !afterwards.ok && afterwards.error.code === 'rate_limited'; retry += 1) {
        await new Promise((r) => setTimeout(r, 120 * (retry + 1)));
        afterwards = await emitAck(solo, 'pod:action', {
          action: { type: 'auto:pass' }, expectedVersion: latest,
        });
      }
      expect(afterwards).toMatchObject({ ok: false, error: { code: 'game_finished' } });
    }, 60_000);

    /**
     * One person, a four-player Commander pod, three different opponents.
     *
     * The server has always been able to seat three bots; what it could not do was give them
     * different decks, so a solo pod was the same deck three times and every opponent drew the
     * same cards. The test is not that the game plays — the test above covers that — but that the
     * pod the lobby now offers actually arrives: four seats, forty life, and three decks that are
     * not each other.
     */
    it('seats three bots on their own decks for a one-person Commander pod', async () => {
      const solo = await client('Solo');
      const botDecks = ['tidal-mind', 'rot-harvest', 'forge-alliance'];
      okAck(await emitAck(solo, 'pod:create', {
        name: 'Solo pod', format: 'commander', visibility: 'private', bots: 3, botDecks,
      }));
      const dealt = waitFor<PodStateEvent>(solo, 'pod:state', (s) => s.state !== null);
      okAck(await emitAck(solo, 'pod:ready', { ready: true }));
      const first = await dealt;

      expect(first.pod.seats).toHaveLength(4);
      expect(first.pod.seats.filter((s) => s.bot)).toHaveLength(3);
      const view = viewOf(first);
      // Each bot took the deck it was given, in seat order, rather than all three taking the
      // caller's single `botDeck` fallback.
      expect(view.seats.slice(1).map((s) => s.deckId)).toEqual(botDecks);
      // It is a Commander pod, so everybody is on forty and the commanders are in the command
      // zone, including the three the server is playing.
      for (const seat of view.seats) expect(seat.life).toBe(40);
      for (let seat = 1; seat < 4; seat += 1) {
        expect(view.zones[`${seat}:command`] ?? []).toHaveLength(1);
      }
    }, 30_000);

    /**
     * A third person watching, which is a different kind of client: no seat, no moves, no hands.
     *
     * The spectator view has existed since redaction went in and nothing could ask for one. The
     * property worth testing is the one that matters — a watcher is a *third party*, and the
     * redaction that keeps two players honest has to keep a watcher honest too.
     */
    it('lets somebody watch a game in progress without seeing either hand', async () => {
      const { a, b, state } = await seatedPair();
      // Deal both decks so there are hands to hide and a board to see.
      let version = state.stateVersion;
      for (const [seat, deckId] of [[0, 'ember-rush'], [1, 'tidal-mind']] as const) {
        version = okAck(await emitAck(a, 'pod:action', {
          action: { type: 'deck:load', seat, deckId }, expectedVersion: version,
        })).stateVersion!;
      }
      version = okAck(await emitAck(a, 'pod:action', {
        action: { type: 'game:start', firstSeat: 0 }, expectedVersion: version,
      })).stateVersion!;

      const watcher = await client('Watcher');
      const first = waitFor<PodStateEvent>(watcher, 'pod:state', (e) => e.state !== null);
      okAck(await emitAck(watcher, 'pod:watch', { code: state.pod.code }));
      const seen = await first;

      // It is the spectator view: no seat, no legal moves, and the table's public zones.
      const view = viewOf(seen);
      expect(view.seat).toBeNull();
      expect(view.automation?.you ?? null).toBeNull();
      expect(seen.pod.seats).toHaveLength(2);

      // And neither hand is readable, which is the whole point of a third party.
      for (const seat of [0, 1] as const) {
        const hand = view.zones[`${seat}:hand`] ?? [];
        expect(hand.length).toBe(7);
        for (const id of hand) expect(view.cards[id]?.card).toBeUndefined();
        expect(view.zones[`${seat}:library`]).toBeUndefined();
      }

      // A watcher cannot do anything: every handler that changes the table wants a seat.
      const tried = await emitAck(watcher, 'pod:action', {
        action: { type: 'life:adjust', seat: 0, delta: -5 }, expectedVersion: seen.stateVersion,
      });
      expect(tried).toMatchObject({ ok: false, error: { code: 'not_in_pod' } });
      expect(await emitAck(watcher, 'pod:ready', { ready: true })).toMatchObject({ ok: false });

      // It keeps up: the next thing the players do reaches the watcher too.
      const next = waitFor<PodStateEvent>(watcher, 'pod:state', (e) => e.stateVersion > seen.stateVersion);
      okAck(await emitAck(b, 'pod:action', {
        action: { type: 'life:adjust', seat: 1, delta: -3 }, expectedVersion: seen.stateVersion,
      }));
      expect(viewOf(await next).seats[1]!.life).toBe(37);
    }, 20_000);

    it('refuses to watch a table that does not exist', async () => {
      const watcher = await client('Watcher');
      expect(await emitAck(watcher, 'pod:watch', { code: 'nobody-home-12' }))
        .toMatchObject({ ok: false, error: { code: 'not_found' } });
    });

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

    /*
      Taking back the last thing that happened.

      The misclick is the one failure at a real table that nothing here could recover from — an
      unscripted card has Move by hand, a dropped phone reclaims its seat, a stuck game has never
      happened — and it is also the easiest, because the engine is an immutable reducer and the
      previous state is simply the previous state.
    */
    it('lets the host take back the last move, and shows everybody the table it went back to', async () => {
      const { a, b, state } = await seatedPair();
      const played = waitFor<PodStateEvent>(b, 'pod:state', (s) => s.stateVersion > state.stateVersion);
      okAck(await emitAck(a, 'pod:action', {
        action: { type: 'life:adjust', seat: 0, delta: -7 }, expectedVersion: state.stateVersion,
      }));
      const after = await played;
      expect(viewOf(after).seats[0]!.life).toBe(33);

      // The host puts it back. Both sockets are told, at a *new* version — an undo is something
      // that happened, not a rewind of the version counter, which is what keeps every client's
      // optimistic concurrency honest.
      const undone = waitFor<PodStateEvent>(b, 'pod:state', (s) => s.stateVersion > after.stateVersion);
      okAck(await emitAck(a, 'pod:undo', {}));
      const back = await undone;
      expect(viewOf(back).seats[0]!.life).toBe(40);
      expect(back.stateVersion).toBeGreaterThan(after.stateVersion);

      // One step, and only one: a second press has nothing to take back.
      expect(await emitAck(a, 'pod:undo', {}))
        .toMatchObject({ ok: false, error: { code: 'nothing_to_undo' } });
    }, 20_000);

    it('tells the whole table that a move was taken back', async () => {
      const { a, b, state } = await seatedPair();
      const played = waitFor<PodStateEvent>(b, 'pod:state', (s) => s.stateVersion > state.stateVersion);
      okAck(await emitAck(a, 'pod:action', {
        action: { type: 'life:adjust', seat: 0, delta: -4 }, expectedVersion: state.stateVersion,
      }));
      await played;
      // The other player hears about it, which is the whole reason it is announced: an undo
      // nobody can see is indistinguishable from the server losing a move.
      const told = waitFor<{ name: string; text: string }>(b, 'pod:chat', (m) => /took back/.test(m.text));
      okAck(await emitAck(a, 'pod:undo', {}));
      const message = await told;
      expect(message.name).toBe('Table');
    }, 20_000);

    it('says on the pod whether there is anything to take back', async () => {
      const { a, b, state } = await seatedPair();
      // Nothing yet, so the table has nothing to show a host.
      expect(state.pod.undoable).toBe(false);
      const played = waitFor<PodStateEvent>(b, 'pod:state', (s) => s.stateVersion > state.stateVersion);
      okAck(await emitAck(a, 'pod:action', {
        action: { type: 'life:adjust', seat: 0, delta: -1 }, expectedVersion: state.stateVersion,
      }));
      expect((await played).pod.undoable).toBe(true);
      const undone = waitFor<PodStateEvent>(b, 'pod:state', (s) => s.pod.undoable === false);
      okAck(await emitAck(a, 'pod:undo', {}));
      await undone;
    }, 20_000);

    it('and nobody but the host may', async () => {
      const { a, b, state } = await seatedPair();
      const played = waitFor<PodStateEvent>(b, 'pod:state', (s) => s.stateVersion > state.stateVersion);
      okAck(await emitAck(a, 'pod:action', {
        action: { type: 'life:adjust', seat: 0, delta: -2 }, expectedVersion: state.stateVersion,
      }));
      await played;
      expect(await emitAck(b, 'pod:undo', {}))
        .toMatchObject({ ok: false, error: { code: 'not_host' } });
    }, 20_000);

    it('has nothing to take back before anybody has done anything', async () => {
      const { a } = await seatedPair();
      expect(await emitAck(a, 'pod:undo', {}))
        .toMatchObject({ ok: false, error: { code: 'nothing_to_undo' } });
    }, 20_000);
  });

});
