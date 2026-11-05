import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { io as connect, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import type { PodErrorEvent, PodStateEvent } from '@grimore/shared';
import { createRealtime, type Realtime } from './io.js';
import type { AckResult } from './handlers.js';
import { TokenBucket } from './ratelimit.js';
import { createClient, type RedisClientType } from 'redis';
import { withRolledFirstSeat, PodStore, makePlayerId, type PodSnapshot } from './pod.js';
import { generateCode, toEngineFormat, maxSeatsFor } from './pod.js';
import {
  unpackView, viewFor, type PackedView, type GameView, type CardDataRow,
} from '@grimore/rules-engine';
import type { CardLibrary } from './cardLibrary.js';
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

/**
 * The per-write bot budget and its continuation, driven against the store rather than a server.
 *
 * These two claims live here and not in the gateway suite above because they are **store-level**:
 * `applyAction` spends a budget of bot moves and `continueBots` carries the rest, and neither
 * needs a socket to be true. The first version of these tests stood up a second `createRealtime`
 * so it could have its own budget, and that instance's Redis clients, cluster adapter and HTTP
 * server were not fully released by `close()` — which starved the five-second `pod:state` waits in
 * whatever ran next. Measured, three arms of six runs:
 *
 *     with those tests, budget  25 -> 3/6 runs failed, 3 broadcast timeouts
 *     with those tests, budget 500 -> 5/6 runs failed, 8 broadcast timeouts
 *     without them,     budget  25 -> 0/6 runs failed, 0 broadcast timeouts
 *
 * The middle arm is worth keeping: bigger writes made it *worse*, which is evidence for the bound
 * and refuted my own hypothesis that the continuation was delaying broadcasts (D324).
 *
 * One client for the file, flushed and closed once, so there is nothing per-test to leak.
 */
describe.skipIf(!REDIS_URL)('the write budget, against the store (requires REDIS_URL)', () => {
  let redis: RedisClientType;

  beforeAll(async () => {
    redis = createClient({ url: REDIS_URL! });
    await redis.connect();
  });

  afterAll(async () => {
    await redis.quit();
  });

  /**
   * Drive the continuation to a standstill, the way the socket handler does after it acks.
   *
   * Throws rather than returning when the seats are still moving, because a silent give-up here
   * would leave the next assertion measuring a half-played turn.
   */
  async function settle(store: PodStore, code: string, from: PodSnapshot): Promise<PodSnapshot> {
    let latest = from;
    for (let round = 0; round < 2000; round += 1) {
      const next = await store.continueBots(code);
      if (next === null) return latest;
      latest = next;
    }
    throw new Error('the server seats were still moving after 2000 continuation rounds');
  }

  /** What seat 0 can see, straight from the store's own state — no wire, no packing. */
  const seen = (snap: PodSnapshot): GameView => viewFor(snap.state!, 0);

  /**
   * The only move this person ever makes: whatever the table is asking for, and a land if it is
   * offered. It never attacks — the point of this table is the server's three seats taking whole
   * turns while nobody interrupts them, which is the shape #298 came from.
   */
  function personMove(view: GameView, you: NonNullable<NonNullable<GameView['automation']>['you']>): Record<string, unknown> {
    if (you.mustDecide !== null) {
      return { type: 'auto:decide', cards: you.mustDecide.candidates.slice(0, you.mustDecide.min) };
    }
    // An owed discard with an empty hand would send `card: undefined`, so it falls through to a
    // pass the engine will refuse out loud rather than a malformed action it refuses obscurely.
    const hand = view.zones['0:hand'] ?? [];
    if (you.mustDiscard > 0 && hand.length > 0) return { type: 'auto:discard', card: hand[0]! };
    if (you.mustDeclare === 'attackers') return { type: 'auto:attack', attackers: [] };
    if (you.mustDeclare === 'blockers') return { type: 'auto:block', blocks: [] };
    if (you.mustDeclare === 'order') return { type: 'auto:order', orders: you.mustOrder.map((ask) => ({ ...ask })) };
    const land = you.plays.find((p) => p.kind === 'land');
    return land === undefined ? { type: 'auto:pass' } : { type: 'auto:playLand', card: land.card };
  }

  /** A four-bot pod, dealt and past its opening hand, which is where the budget actually binds. */
  async function podReadyToPlay(store: PodStore): Promise<{ code: string; playerId: string; at: PodSnapshot }> {
    const host = { playerId: makePlayerId(), name: 'Budget' };
    const joined = await store.create({
      format: 'commander', visibility: 'private', name: 'Budget pod',
      bots: 3, botDecks: ['tidal-mind', 'rot-harvest', 'forge-alliance'],
    }, host);
    const code = joined.pod.code;
    let at: PodSnapshot = await store.ready(code, host.playerId, true);
    /*
      A pod deals on ready, but the *game* still needs loading, starting and its opening hands
      settled before a move is legal. Without this every action came back `illegal_action`, the
      store made no writes at all, and a budget assertion passed having tested nothing.

      The standstill after each step matters just as much: under a budget of one the three server
      seats cannot settle their own mulligans inside the write that `auto:keep` provokes, so the
      game had not begun and the first move came back FORBIDDEN "you do not have priority" — the
      budget starving its own fixture.
    */
    for (const action of [
      { type: 'deck:load', seat: 0, deckId: 'ember-rush' },
      { type: 'game:start', firstSeat: 0 },
      { type: 'auto:start', firstSeat: 0 },
      { type: 'auto:keep' },
    ]) {
      at = await store.applyAction(code, host.playerId, action, at.stateVersion);
      at = await settle(store, code, at);
    }
    return { code, playerId: host.playerId, at };
  }

  it('spends at most its budget of server moves per write, and does not strand the table', async () => {
    /*
      The bound measured where it binds, against the writes that happened.

      **A four-bot pod on purpose.** Two earlier attempts used the solo duel and proved nothing:
      the largest write there wants three bot moves, measured, so the budget never bound and
      raising it sixteen-fold left the suite green. The 431-move write came from a four-seat pod
      with the person idle while three bots took whole turns, which is this table.

      The person here only ever does what the table offers and never attacks, which is exactly
      the shape that produced #298: the server playing three seats while nobody interrupts it.

      `toBe(1)` rather than `toBeLessThanOrEqual(1)` on purpose. Equality carries the bound *and*
      the proof that the bound was reached — a write that wanted more and was cut to one. A `<=`
      would pass on a table that never asked for a second move, which is the vacuous shape this
      session has now found seven times.
    */
    const writes: number[] = [];
    const stalled: string[] = [];
    const store = new PodStore(redis, {
      keyPrefix: `test:budget:${Date.now().toString(36)}:${process.pid}`,
      botMovesPerWrite: 1,
      // Every write reports — both the player's and the continuation's — which is the only way to
      // check the budget against what happened rather than against the constant meant to bound it.
      slowWriteMs: 0,
      onSlowWrite: ({ reason }) => {
        writes.push(Number(/and (\d+) server move/.exec(reason)?.[1] ?? -1));
      },
      onBotStall: ({ reason }) => stalled.push(reason),
    });
    try {
      const pod = await podReadyToPlay(store);
      let at = pod.at;
      let view = seen(at);
      const act = async (action: Record<string, unknown>): Promise<void> => {
        at = await store.applyAction(pod.code, pod.playerId, action, at.stateVersion);
        at = await settle(store, pod.code, at);
        view = seen(at);
      };

      let stopped = 'the move cap';
      let moves = 0;
      for (let move = 0; move < 24 && !view.finished; move += 1) {
        moves = move + 1;
        const you = view.automation?.you;
        if (you === undefined || you === null) {
          stopped = 'the view stopped reporting this seat';
          break;
        }
        if (you.mustDiscard > 0 && (view.zones['0:hand'] ?? []).length === 0) {
          stopped = 'a discard was owed with an empty hand';
          break;
        }
        /*
          This is the stranding assertion, and it is the one that caught the budget starving its
          own fixture. A table whose continuation chain gave up mid-turn comes back here with
          priority nowhere — which is exactly what a player sees as a dead table.
        */
        if (!you.hasPriority && you.mustDeclare === null && you.mustDecide === null && you.mustDiscard === 0) {
          stopped = `nobody held priority at ${view.automation?.step} on turn ${view.turn}`;
          break;
        }
        await act(personMove(view, you));
      }

      expect(stopped, `after ${moves} of the person's moves, on turn ${view.turn}`).toBe('the move cap');
      expect(writes.length, 'the store reported no writes at all').toBeGreaterThan(0);
      /*
        The instrument first, then the reading.

        `-1` is what the regex above pushes when a reason does not carry a move count — a reworded
        report, say. Without this the max assertion would read `-1 <= 1` as a pass and this test
        would go green having parsed nothing, which is the same failure as the rest of this file's
        history in a new coat.
      */
      expect(writes.includes(-1), `a write reported no move count: ${JSON.stringify(writes)}`).toBe(false);
      expect(Math.max(...writes), JSON.stringify(writes.slice(0, 24))).toBe(1);
      // And the table got somewhere: three bots took turns while the person did nothing.
      expect(view.turn, 'the pod never got past its first turn').toBeGreaterThan(1);
      /*
        And no server seat was left stuck, which is the other half of "bounding the write must not
        strand the table".

        This assertion was removed once, on the grounds that it could not fail: `runBots` reports
        "ran out with a seat still owed" only when its **guard** is spent, which a budget of one
        makes unreachable. That much is true and it is why the budget test cannot lean on *that*
        report — but it is not the only one. `runBots` also stalls for a seat `botAction` offered
        no move for, for a move the engine refused, and for a move that changed nothing, and all
        three fire inside the loop whatever the budget is. So the assertion can fail, it fails on
        exactly the condition this test is about, and deleting it cost real coverage for a day.
        See D327; the reasoning that removed it is the same over-generalisation that produced it.
      */
      expect(stalled, JSON.stringify(stalled)).toEqual([]);
    } finally {
      await store.flushPrefix();
    }
  }, 180_000);

  it('reports an abandoned continuation while a seat is still owed a move', async () => {
    /*
      The report that bounding the write displaced.

      `runBots` says "ran out with a seat still owed" only when its **guard** is spent, and the
      shipping budget is 25 against a guard of 500 — so `stopAt >= GUARD` is `25 >= 500`, always
      false, and that report became unreachable the moment the budget shipped. I did not notice
      until re-reading my own diff. The condition moved rather than vanished: the table is dead
      only if the continuation *chain* ends with a seat still owed, which only the caller driving
      that chain knows, so `reportBotStall` lets it say so through the callback a test can watch.

      The loop below mirrors `handlers.ts`' round cap with a cap of one. It is a mirror, not the
      handler itself — the real loop sits inside `pod:action` and only a socket reaches it, which
      is what the two tests D324 removed were trying to do before each of them leaked a server.
      `botContinuationRounds` stays injectable so the handler's own loop can be pinned later
      without standing up a second gateway.

      **It has to go looking for the moment.** The first version passed once and asserted the
      report: `continueBots` came straight back with nothing owed, because the one move the write
      spent handed priority back to the person, and the test failed having proved only that its own
      premise was wrong. A seat is owed real work when the *turn* has gone to the server's seats,
      so this plays the person's turn out until a capped chain actually hits its cap — and fails
      saying so if it never does.
    */
    const stalled: string[] = [];
    const store = new PodStore(redis, {
      keyPrefix: `test:cap:${Date.now().toString(36)}:${process.pid}`,
      botMovesPerWrite: 1,
      onBotStall: ({ reason }) => stalled.push(reason),
    });
    try {
      const pod = await podReadyToPlay(store);
      let at = pod.at;
      const cap = 1;
      let hitTheCap = false;
      let why = 'the person ran out of moves to make';

      for (let move = 0; move < 30 && !hitTheCap; move += 1) {
        const view = seen(at);
        const you = view.automation?.you;
        if (you === undefined || you === null) { why = 'the view stopped reporting this seat'; break; }
        if (!you.hasPriority && you.mustDeclare === null && you.mustDecide === null && you.mustDiscard === 0) {
          why = `nobody held priority at ${view.automation?.step} on turn ${view.turn}`;
          break;
        }
        at = await store.applyAction(pod.code, pod.playerId, personMove(view, you), at.stateVersion);
        // One batch, then give up, exactly as the handler's round cap does.
        let rounds = 0;
        for (; rounds < cap; rounds += 1) {
          const next = await store.continueBots(pod.code);
          if (next === null) break;
          at = next;
        }
        if (rounds === cap) {
          hitTheCap = true;
          store.reportBotStall(pod.code, `${cap} continuation rounds and the server's seats were still moving`);
        }
      }

      expect(hitTheCap, `the capped chain never hit its cap: ${why}`).toBe(true);
      expect(
        // Matched on the stable words rather than the punctuation: an earlier version of this used
        // a typographic apostrophe against a message emitting an ASCII one, and failed while
        // printing the very string it was looking for.
        stalled.some((r) => /continuation rounds/.test(r) && /still moving/.test(r)),
        `expected the cap report, got ${JSON.stringify(stalled)}`,
      ).toBe(true);
    } finally {
      await store.flushPrefix();
    }
  }, 180_000);
});

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
  /**
   * And the same for a person's move that bought nothing.
   *
   * `runBots` has always compared `stateVersion` before and after a bot's action; the human path
   * never did, so a table where pressing the only offered button changes nothing looked, from the
   * server, exactly like a table being played. Two browser pods stalled two hundred moves apiece
   * on that shape with not one line logged. Collected rather than merely logged for the same
   * reason `stalls` is: a whole game is several hundred chances for it, and an empty list at the
   * end is the claim worth making.
   */
  const noProgress: { code: string; reason: string }[] = [];

  beforeAll(async () => {
    rt = await createRealtime({
      redisUrl: REDIS_URL!,
      allowedOrigins: [],
      log: pino({ level: 'silent' }),
      store: {
        keyPrefix: `test:${Date.now().toString(36)}:${process.pid}`,
        onBotStall: (info) => stalls.push(info),
        onNoProgress: (info) => noProgress.push(info),
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

  /*
    The other direction, which is the one that matters for security: a configured allow list has to
    actually refuse everything else. Needs its own server because the allow list is fixed at start.

    ## Its timeouts, which were in the wrong order and failed CI once

    Each `attempt` below carries its own fallback so a handshake that never answers cannot hang the
    suite. Those fallbacks were **4000ms each**, two of them run in sequence, inside vitest's
    **5000ms** default — so the test could not pass if either attempt ever took its slow path, and
    8000ms of internal budget sat inside a 5000ms deadline.

    It passed anyway for months, because both handshakes normally answer in single-digit
    milliseconds. Then a loaded CI runner, on which the preceding test in this file took 9.5
    seconds, starved this one and it died with `Test timed out in 5000ms` — a message that says
    nothing about origins, allow lists or handshakes, and sent me looking for a regression in a diff
    that does not touch this app.

    So the two numbers are now in the right order: 2000ms per attempt, and an explicit 15000ms for
    the test. A fallback that is reachable *inside* the deadline fails with
    `expected 'timeout' to be 'refused'`, which names the problem; one that is only reachable past
    the deadline converts a specific failure into a generic one.
  */
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
        // Under this test's own deadline, so taking it reports 'timeout' against the assertion
        // rather than blowing up as a vitest timeout. See the docblock above.
        setTimeout(() => finish('timeout'), 2000);
      });

    try {
      expect(await attempt('https://evil.example')).toBe('refused');
      expect(await attempt('https://grimore.gg')).toBe('connected');
    } finally {
      await guarded.store.flushPrefix();
      await guarded.close();
    }
    // 15s, comfortably past the 2 x 2000ms of internal fallback plus a cold server start on a
    // loaded runner. Explicit rather than global: this is the one test in the file that boots a
    // second server, so it is the one that needs the room.
  }, 15000);

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

  it('and a table nobody asked to list stays off the list', async () => {
    /*
      The guarantee the lobby's own default rests on.

      `apps/web` creates a table as `private` unless its host presses **Open table**, and a shared
      server that listed every game anyway would show strangers each other's tables whatever the
      client did. So this is asserted from the server's side, where it is actually enforced: a
      public table and a private one made in the same breath, and only one of them comes back.
    */
    const host = await client('Dana');
    const seen = okAck(await emitAck(host, 'pod:create', {
      name: 'Listed', format: 'modern', visibility: 'public',
    }));
    const hidden = await client('Erin');
    const unseen = okAck(await emitAck(hidden, 'pod:create', {
      name: 'Unlisted', format: 'modern', visibility: 'private',
    }));

    const onlooker = await client('Frank');
    const list = waitFor<{ pods: { code: string }[] }>(onlooker, 'pod:list');
    okAck(await emitAck(onlooker, 'pod:list', {}));
    const codes = (await list).pods.map((p) => p.code);
    expect(codes).toContain(seen.code);
    expect(codes).not.toContain(unseen.code);
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

  it('marks a watcher’s chat as a watcher’s, and names them', async () => {
    /*
      A watcher could always talk — `pod:chat` asks only that the socket is in a pod — and that was
      the problem rather than the feature: with no name the line read "Player", which is what one
      of the two people playing is called, so a spectator's "I'm responding to that" arrived
      looking like an opponent's.

      The flag comes from the server because who is a spectator is the server's fact. The client
      could guess it from `seat === null` and would be a second answer to a question with one.
    */
    const { a, b, state } = await seatedPair();
    const watcher = await client('Nosy');
    okAck(await emitAck(watcher, 'pod:watch', { code: state.pod.code, name: 'Nosy' }));

    const heard = waitFor<{ name: string; text: string; seat: number | null; watching?: boolean }>(
      b, 'pod:chat',
    );
    okAck(await emitAck(watcher, 'pod:chat', { text: 'nice draw' }));
    expect(await heard).toMatchObject({
      name: 'Nosy', text: 'nice draw', seat: null, watching: true,
    });

    // And a seated player is not marked, which is the half that makes the label mean anything.
    const fromPlayer = waitFor<{ name: string; watching?: boolean }>(b, 'pod:chat');
    okAck(await emitAck(a, 'pod:chat', { text: 'thanks' }));
    const line = await fromPlayer;
    expect(line.name).toBe('Alice');
    expect(line.watching).toBeUndefined();
  }, 20_000);

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
      /*
        With both hands settled the game has begun, and the server has already taken any turn of
        its own that came first.

        Both of this test's `awaiting` assertions now say which one they are, because a failure of
        either reads identically in CI — "expected { kind: 'attackers', seats: [ 1 ] } to be null"
        — and the two mean opposite things: here it is the server not having finished the turn the
        roll gave it, and at the end of the game it is a finished table still asking a question.
        One occurrence of that message cost a session's worth of guessing which.
      */
      /*
        The stalls first, and that ordering is the point.

        `stalls` was only asserted at the *end* of this test, and every one of `runBots`' silent
        ways out happens here as easily as there: a server seat owed a move at declare-attackers
        whose move was refused, or offered none, or ran the five-hundred-move guard out, leaves the
        table exactly as this assertion finds it — `awaiting` holding the bot's question. So one
        stall in this window failed on the line below with "expected { kind: 'attackers', seats:
        [ 1 ] } to be null" and the stall's own reason, which says precisely what happened, was
        never printed at all. That is the shape of CI run 324 and the reason #178 stayed open.

        Asserted rather than merely reported, because a stall here is a real failure: the server
        has stopped playing its own turn and a person at this table would be looking at a board
        waiting for an opponent that is never going to move.
      */
      expect(stalls, `a server seat stalled before the first turn: ${JSON.stringify(stalls)}`)
        .toEqual([]);
      expect(
        view.automation!.awaiting,
        `just after both opening hands were settled (stalls: ${JSON.stringify(stalls)})`,
      ).toBeNull();
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
      // outstanding at the end — a game that ends mid-resolution has not ended. A combat
      // declaration is the one of those questions the engine derives rather than stores, which is
      // how it used to survive the end of a game; see `pendingDeclaration`.
      expect(
        view.automation!.awaiting,
        `once the game had a winner (stalls: ${JSON.stringify(stalls)})`,
      ).toBeNull();
      /*
        And the server's seat was never left with nothing to do.

        A whole game is several hundred chances for `runBots` to take one of its four silent ways
        out, each of which leaves the pod waiting on a seat nobody will move. Asserted here rather
        than trusted to a log line, because the symptom — a table where nobody is on the clock —
        reads to a player as the server having lost their move, and reads to a browser suite as
        an idle timeout four seconds later with nothing to go on.
      */
      expect(stalls, JSON.stringify(stalls)).toEqual([]);
      // And not one of those several hundred moves was accepted without changing anything, which
      // is the half of "the table kept moving" the server can see for itself.
      expect(noProgress, JSON.stringify(noProgress)).toEqual([]);

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
     * A deal offered across the wire, and answered inside the same write.
     *
     * The engine's own suite proves what a pact does; what this proves is that it travels. A pact
     * is the first action in this server that is neither a rules move nor a table affordance — it
     * is one player saying something to another — and the two things that could have gone wrong
     * are both about the server: `by` is stamped from the socket, so nobody can offer a deal in
     * somebody else's name, and the server's own seat answers in the write that provoked it rather
     * than leaving an offer hanging on a table nobody is holding.
     */
    it('carries a deal to the server\u2019s seat and brings back its answer', async () => {
      const solo = await client('Dealer');
      okAck(await emitAck(solo, 'pod:create', {
        name: 'Deals', format: 'commander', visibility: 'private', bots: 1, botDeck: 'tidal-mind',
      }));
      const dealt = waitFor<PodStateEvent>(solo, 'pod:state', (s) => s.state !== null);
      let version = okAck(await emitAck(solo, 'pod:ready', { ready: true })).stateVersion!;
      await dealt;

      solo.on('pod:state', (e: PodStateEvent) => { version = Math.max(version, e.stateVersion); });

      const act = async (action: Record<string, unknown>): Promise<PodStateEvent> => {
        // `from` is captured before the emit: the predicate runs when the event arrives, which is
        // after `version` has already moved on, so reading it there would never match.
        const from = version;
        const seen = waitFor<PodStateEvent>(solo, 'pod:state', (s) => s.stateVersion > from);
        /*
          `versionRef` in the browser client is written by the ack **and** by every `pod:state`
          broadcast (`apps/web/src/lib/table.ts`). This tracked the ack alone, which is a simpler
          client than the real one — and once a write bounds its bot moves and `continueBots`
          carries the rest (#298), the pod advances past the ack while the answer is still
          arriving, so the ack's version is one the pod has already left. Retried as `send` does.
        */
        let ack = await emitAck(solo, 'pod:action', { action, expectedVersion: version });
        for (let retry = 0; retry < 6 && !ack.ok && ack.error.code === 'version_conflict'; retry += 1) {
          await new Promise((r) => setTimeout(r, 40 * (retry + 1)));
          ack = await emitAck(solo, 'pod:action', { action, expectedVersion: version });
        }
        version = Math.max(version, okAck(ack).stateVersion!);
        return seen;
      };

      await act({ type: 'deck:load', seat: 0, deckId: 'ember-rush' });
      await act({ type: 'game:start', firstSeat: 0 });
      await act({ type: 'auto:start', firstSeat: 0 });
      await act({ type: 'auto:keep' });

      // The table offers the deals, per opponent, and this seat has one opponent.
      const before = viewOf(await act({ type: 'coin:flip' }));
      expect(before.automation?.you?.pacts.offer.map((o) => o.seat)).toEqual([1]);

      const after = viewOf(await act({ type: 'pact:offer', seat: 1, kind: 'truce-until-your-turn' }));
      // Offered and answered in one write: the server's seat does not leave a deal on the table.
      expect(after.pacts).toHaveLength(1);
      expect(after.pacts[0]).toMatchObject({ from: 0, to: 1, status: 'accepted' });
      expect(after.pacts[0]!.throughTurn).not.toBeNull();
      // And the words are in the log, where the table can read them back.
      expect(after.log.some((e) => e.message.includes('offers a deal'))).toBe(true);
      expect(after.log.some((e) => e.message.includes('agrees'))).toBe(true);
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

  /*
    A decklist somebody pasted in.

    The text goes over the wire and the **server** parses it, which is the only safe way round, so
    what is being checked here is that the server's reading is the one the table uses: the summary
    on the ack, the counts everybody can see, and a `deck:load custom` that deals the list rather
    than one of the built-in decks.
  */
  describe('a deck somebody pasted in', () => {
    it('reads the list, says what it read, and deals it', async () => {
      const { a, state } = await seatedPair();
      const text = [
        'Commander',
        '1 Tatyova, Benthic Druid',
        '',
        'Deck',
        '20 Forest (M21) 262',
        '19 Island',
        '4 Llanowar Elves',
        '4 Explore',
        '12 Nonsense Card',
        '',
        'Sideboard',
        '2 Negate',
      ].join('\n');

      const ack = okAck(await emitAck(a, 'pod:deck', { name: 'Mine', text }));
      expect(ack.deck).toMatchObject({
        total: 59, distinct: 5, sideboard: 2,
        unknown: ['Nonsense Card'], unknownCount: 1,
        commander: 'Tatyova, Benthic Druid',
      });

      // And the table sees the shape of it without seeing the cards.
      const seen = await waitFor<PodStateEvent>(a, 'pod:state', (s) => s.pod.seats[0]?.list !== undefined);
      expect(seen.pod.seats[0]!.list).toEqual({ name: 'Mine', total: 59, unknown: 1 });

      // Loading it puts those cards in that seat's library, cardboard and all. The version comes
      // from the paste's own ack: storing a list is a change to the table like any other.
      const loaded = okAck(await emitAck(a, 'pod:action', {
        action: { type: 'deck:load', seat: 0, deckId: 'custom:0' },
        expectedVersion: ack.stateVersion!,
      }));
      const after = await waitFor<PodStateEvent>(a, 'pod:state', (s) => s.stateVersion >= loaded.stateVersion!);
      const view = unpackView(after.state as unknown as PackedView);
      expect(view.seats.find((s) => s.index === 0)?.deckId).toBe('custom:0');
      // Fifty-nine in the library — a count rather than a list, because a library's order is
      // withheld from everyone including its owner — and the commander in the command zone.
      expect(view.seats.find((s) => s.index === 0)?.libraryCount).toBe(59);
      expect(view.zones['0:command']?.length).toBe(1);
    }, 20_000);

    /*
      The summary, the ack and the dealt deck all read the same list.

      Three places in `pod.ts` turn a stored pasted list into a deck: the summary every seat sees,
      the ack the player who pasted it gets, and the deck dealt into the game. They used to be
      three separate `customDeck({ ... })` literals and are now one helper, `deckFromPastedList`.

      This is the check that they still agree, and it is written against the three *observable*
      readings rather than against the helper, because a test of the helper would pass just as
      happily if one call site stopped using it. Two distinct unreadable names, so a count that
      came from somewhere else — the number of copies, the number of entries, one name instead of
      two — reads differently from the right one.
    */
    it('reads the same list into the summary, the ack and the dealt deck', async () => {
      const { a } = await seatedPair();
      const text = [
        'Commander',
        '1 Tatyova, Benthic Druid',
        '',
        'Deck',
        '30 Forest',
        '20 Island',
        '5 Nonsense Card',
        '4 Also Not A Card',
      ].join('\n');

      // (1) The ack, which is the reading the player who pasted it is given.
      const ack = okAck(await emitAck(a, 'pod:deck', { text }));
      expect(ack.deck).toMatchObject({ total: 59, unknownCount: 2 });
      expect(ack.deck!.unknown!.slice().sort()).toEqual(['Also Not A Card', 'Nonsense Card']);

      // (2) The summary, which is the reading every other seat is given.
      const seen = await waitFor<PodStateEvent>(a, 'pod:state', (st) => st.pod.seats[0]?.list !== undefined);
      expect(seen.pod.seats[0]!.list).toMatchObject({ total: 59, unknown: 2 });

      /*
        (3) The dealt deck, read three ways, because a library's contents are withheld from
        everybody including its owner:

        - `view.manual`, which names **every** card the engine cannot play in the dealt game. This
          used to be the engine's refusal to automate the table, which named only the first card it
          found and so could not carry the count — hybrid automation replaced the refusal with a
          list, which is what this reading wanted in the first place (see `coverage.ts`);
        - `libraryCount`, which is 59 only if the deal read the same entries the other two did;
        - the command zone, which holds a card only if the deal spread the commander.

        Between them a path 3 that read a different list shows up: drop the commander and the
        command zone is empty and the library is 60, read different entries and the count moves.
      */
      const loaded = okAck(await emitAck(a, 'pod:action', {
        action: { type: 'deck:load', seat: 0, deckId: 'custom:0' },
        expectedVersion: ack.stateVersion!,
      }));
      /*
        Read after the load and **before** `game:start`, because starting draws seat zero an
        opening hand: the library reads 52 there, and 52 is a number this test would have to
        restate every time the opening hand size changed. 59 is the list.
      */
      const after = await waitFor<PodStateEvent>(a, 'pod:state', (st) => st.stateVersion >= loaded.stateVersion!);
      const view = unpackView(after.state as unknown as PackedView);
      expect(view.seats.find((st) => st.index === 0)?.libraryCount).toBe(59);
      expect(view.zones['0:command']?.length).toBe(1);

      const second = okAck(await emitAck(a, 'pod:action', {
        action: { type: 'deck:load', seat: 1, deckId: 'ember-rush' },
        expectedVersion: loaded.stateVersion!,
      }));
      const started = okAck(await emitAck(a, 'pod:action', {
        action: { type: 'game:start' }, expectedVersion: second.stateVersion!,
      }));
      /*
        And the dealt deck's unreadable cards, read off `view.manual`.

        This used to read them out of the engine's **refusal** to automate the table, which named
        only the first one it found — a limit this comment used to record. Hybrid automation removed
        the refusal and replaced it with something strictly better for this check: a list of every
        card the engine cannot play, which is what the third reading needed all along.
      */
      const auto = okAck(await emitAck(a, 'pod:action', {
        action: { type: 'auto:start' }, expectedVersion: started.stateVersion!,
      }));
      const dealt = await waitFor<PodStateEvent>(a, 'pod:state',
        (st) => st.stateVersion >= auto.stateVersion!);
      const manual = unpackView(dealt.state as unknown as PackedView).manual.map((m) => m.name);
      expect(manual.slice().sort()).toEqual(['Also Not A Card', 'Nonsense Card']);
    }, 20_000);

    it('refuses a paste that is not a deck, and keeps the seat as it was', async () => {
      const { a } = await seatedPair();
      expect(await emitAck(a, 'pod:deck', { text: '   ' }))
        .toMatchObject({ ok: false, error: { code: 'illegal_action' } });
      const ack = okAck(await emitAck(a, 'pod:deck', { text: '4 Forest' }));
      expect(ack.deck).toMatchObject({ total: 4, unknownCount: 0 });
    }, 20_000);

    it('starts the rules engine on a list it cannot fully read, and names the card', async () => {
      const { a } = await seatedPair();
      const pasted = okAck(await emitAck(a, 'pod:deck', { text: '40 Forest\n20 Nonsense Card' }));
      const loaded = okAck(await emitAck(a, 'pod:action', {
        action: { type: 'deck:load', seat: 0, deckId: 'custom:0' },
        expectedVersion: pasted.stateVersion!,
      }));
      // Seat 1 takes a built-in deck, so the only unreadable cards are seat 0's.
      const second = okAck(await emitAck(a, 'pod:action', {
        action: { type: 'deck:load', seat: 1, deckId: 'ember-rush' },
        expectedVersion: loaded.stateVersion!,
      }));
      const started = okAck(await emitAck(a, 'pod:action', {
        action: { type: 'game:start' }, expectedVersion: second.stateVersion!,
      }));
      /*
        Started, not refused — and that is a change. This used to assert
        `{ ok: false, error: { code: 'illegal_action' } }`, because `auto:start` threw on any card
        the engine could not read and the table dropped to tabletop mode. Hybrid automation replaced
        that: the engine runs, and the cards it cannot play are flagged for moving by hand. See
        `coverage.ts` in the rules engine for why.

        What the test still has to establish is the part that makes hybrid honest — that the player
        is **told** — so it reads the name out of the view the server broadcasts rather than out of
        an error message.
      */
      const auto = okAck(await emitAck(a, 'pod:action', {
        action: { type: 'auto:start' }, expectedVersion: started.stateVersion!,
      }));
      const state = await waitFor<PodStateEvent>(a, 'pod:state',
        (st) => st.stateVersion >= auto.stateVersion!);
      const view = unpackView(state.state as unknown as PackedView);
      expect(view.manual.map((m) => m.name)).toEqual(['Nonsense Card']);
      expect(view.manual[0]?.reason).toBe('no-printed-data');
      expect(view.automation, 'the engine should be running, which is the whole point').not.toBeNull();
    }, 20_000);

    it('will not let the host read a guest’s list by loading it onto their own seat', async () => {
      /*
        The one thing per-seat ids could have cost. A list is private — the table is told its size
        and how much of it the engine can read, never its cards — and the host can load a deck for
        any seat. So the host asking for seat 1's list on seat 0 has to be refused, and it is,
        because the decks an action may resolve are its own sender's.
      */
      const { a, b } = await seatedPair();
      const theirs = okAck(await emitAck(b, 'pod:deck', { text: '36 Forest\n24 Island' }));
      const refused = await emitAck(a, 'pod:action', {
        action: { type: 'deck:load', seat: 0, deckId: 'custom:1' },
        expectedVersion: theirs.stateVersion!,
      });
      // INVALID_DECK, not a refusal about permission: from the host's action that list has no id.
      expect(refused).toMatchObject({ ok: false, error: { code: 'illegal_action' } });
      if (!refused.ok) expect(refused.error.message).toContain('no deck with id custom:1');
    }, 20_000);

    it('deals both lists again on a rematch, whoever asks for it', async () => {
      /*
        The regression per-seat ids exist for. A rematch reloads every seat's deck by the id that
        seat already has, so with one shared `custom` the host's rematch asked for a deck id only
        the guest's actions could resolve — and "play again" was refused at any table where the
        other player had pasted a list.
      */
      const { a, b } = await seatedPair();
      const mine = okAck(await emitAck(a, 'pod:deck', { text: '36 Forest\n24 Llanowar Elves' }));
      const theirs = okAck(await emitAck(b, 'pod:deck', { text: '36 Mountain\n24 Shock' }));
      let v = Math.max(mine.stateVersion!, theirs.stateVersion!);
      // Each player loads their own, which is the only way a pasted list is ever loaded.
      for (const [who, action] of [
        [a, { type: 'deck:load', seat: 0, deckId: 'custom:0' }],
        [b, { type: 'deck:load', seat: 1, deckId: 'custom:1' }],
        [a, { type: 'game:start' }],
      ] as const) {
        v = okAck(await emitAck(who, 'pod:action', { action, expectedVersion: v })).stateVersion!;
      }
      // Seat 1 out of life ends it, and then the host — not the player who pasted seat 1's deck —
      // asks for another game.
      v = okAck(await emitAck(a, 'pod:action', {
        action: { type: 'life:adjust', seat: 1, delta: -40 }, expectedVersion: v,
      })).stateVersion!;
      const again = await emitAck(a, 'pod:action', {
        action: { type: 'game:rematch' }, expectedVersion: v,
      });
      expect(again).toMatchObject({ ok: true });
      const after = await waitFor<PodStateEvent>(a, 'pod:state',
        (s) => s.stateVersion >= okAck(again).stateVersion!);
      const view = unpackView(after.state as unknown as PackedView);
      expect(view.seats.map((s) => s.deckId)).toEqual(['custom:0', 'custom:1']);
      expect(view.seats.map((s) => s.libraryCount! + 7)).toEqual([60, 60]);
    }, 30_000);
  });

});

/*
  Who goes first, which two people decide with a die and this table decided by asking who created
  it. `game:start` with no seat named starts seat zero, so the host went first in every game ever
  played here — and the engine itself knows going first is an edge: a rematch gives the previous
  winner the second turn.

  The roll is injected rather than observed, because the alternative is a test that starts twenty
  tables and checks both seats came up, which fails one run in a million for being unlucky.
*/
describe('rolling for who goes first', () => {
  const seats = [{ seat: 0 as const }, { seat: 1 as const }];
  const start = { type: 'game:start', by: 0 } as const;

  it('fills in a seat when the table named none', () => {
    expect(withRolledFirstSeat(start, seats, () => 0)).toMatchObject({ firstSeat: 0 });
    expect(withRolledFirstSeat(start, seats, () => 0.99)).toMatchObject({ firstSeat: 1 });
    // A roll that comes back exactly 1 — which `Math.random` never does, and a stub might — lands
    // on the last seat rather than past the end of the table.
    expect(withRolledFirstSeat(start, seats, () => 1)).toMatchObject({ firstSeat: 1 });
  });

  it('leaves a start that named a seat exactly as it arrived', () => {
    const named = { type: 'game:start', by: 0, firstSeat: 1 } as const;
    expect(withRolledFirstSeat(named, seats, () => 0)).toBe(named);
  });

  it('leaves every other action alone', () => {
    const pass = { type: 'auto:pass', by: 0 } as const;
    expect(withRolledFirstSeat(pass, seats, () => 0)).toBe(pass);
  });

  it('rolls across four seats in a pod, the computer\'s included', () => {
    const pod = [{ seat: 0 as const }, { seat: 1 as const }, { seat: 2 as const }, { seat: 3 as const }];
    expect(withRolledFirstSeat(start, pod, () => 0.5)).toMatchObject({ firstSeat: 2 });
    expect(withRolledFirstSeat(start, pod, () => 0.8)).toMatchObject({ firstSeat: 3 });
  });

  it('does nothing at a table with no seats, rather than rolling a seat that is not there', () => {
    expect(withRolledFirstSeat(start, [], () => 0)).toBe(start);
  });
});

/**
 * A pasted list resolved against the card table (D459).
 *
 * The thing the whole corpus was for: a deck of cards nobody hand-wrote, played by the rules engine
 * rather than by hand. `customDeck` has been able to do this since D430 — pool, then printed data,
 * then cardboard — and **no caller in this app supplied any data**, so every pasted name outside the
 * 348-card pool was cardboard whatever was in `scryfall_cards`.
 *
 * Its own server, with its own card library, because the suite above is the behaviour of a table
 * with no card table and is worth keeping exactly as it is: the two together are the before and
 * after. The library is a fake rather than Postgres — two rows this file wrote, so the assertions
 * name cards instead of counting corpus — and `cardLibrary.test.ts` is where the real one is run
 * against the real schema.
 *
 * Every fixture is a printed card the pool does **not** have, which is load-bearing: `customDeck`
 * consults the pool first, so a Lightning Bolt here would resolve to the hand-written script and
 * prove nothing about the card table at all.
 */
describe.skipIf(!REDIS_URL)('a pasted list read out of the card table (requires REDIS_URL)', () => {
  const ROWS: CardDataRow[] = [
    {
      name: 'Wall of Omens',
      type_line: 'Creature — Wall',
      oracle_text: 'Defender\nWhen Wall of Omens enters, draw a card.',
      mana_cost: '{1}{W}',
      cmc: 2,
      colors: ['W'],
      power: '0',
      toughness: '4',
      layout: 'normal',
    },
    {
      name: 'Elvish Mystic',
      type_line: 'Creature — Elf Druid',
      oracle_text: '{T}: Add {G}.',
      mana_cost: '{G}',
      cmc: 1,
      colors: ['G'],
      power: '1',
      toughness: '1',
      layout: 'normal',
    },
  ];

  /** What the lookup was asked for, so a test can say the warm happened where it has to. */
  const asked: string[][] = [];
  const cards: CardLibrary = {
    warm: async (names) => {
      asked.push([...names]);
    },
    rowFor: (name) => ROWS.find((r) => r.name!.toLowerCase() === name.trim().toLowerCase()),
    close: async () => {},
  };

  let rt: Realtime;
  let url: string;
  const clients: Socket[] = [];

  beforeAll(async () => {
    rt = await createRealtime({
      redisUrl: REDIS_URL!,
      allowedOrigins: [],
      log: pino({ level: 'silent' }),
      store: { keyPrefix: `test-cards:${Date.now().toString(36)}:${process.pid}`, cards },
      rateLimit: { rate: 20, burst: 40 },
    });
    await new Promise<void>((resolve) => rt.httpServer.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(rt.httpServer.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.disconnect();
    asked.splice(0);
  });

  afterAll(async () => {
    await rt.store.flushPrefix();
    await rt.close();
  });

  const client = async (name: string): Promise<Socket> => {
    const s = connect(url, { transports: ['websocket'], forceNew: true, auth: { name }, reconnection: false });
    clients.push(s);
    await waitFor(s, 'connect');
    return s;
  };

  /**
   * Two players seated and readied, which is what deals the table. The list is this suite's
   * subject, not the pod, so this is the shortest route to a table that will accept `deck:load`.
   */
  const seated = async () => {
    const a = await client('Alice');
    const b = await client('Bob');
    const created = okAck(await emitAck(a, 'pod:create', {
      name: 'Card table', format: 'commander', visibility: 'private',
    }));
    const code = created.code!;
    const bothSeated = waitFor<PodStateEvent>(a, 'pod:state', (st) => st.pod.seats.length === 2);
    okAck(await emitAck(b, 'pod:join', { code, name: 'Bob' }));
    await bothSeated;
    const dealt = waitFor<PodStateEvent>(b, 'pod:state', (st) => st.pod.status === 'in_progress');
    okAck(await emitAck(a, 'pod:ready', { ready: true }));
    okAck(await emitAck(b, 'pod:ready', { ready: true }));
    await dealt;
    asked.splice(0);
    return { a, b, code };
  };

  const LIST = ['Deck', '40 Forest', '10 Wall of Omens', '9 Elvish Mystic'].join('\n');

  it('resolves a name the pool does not have into the printed card', async () => {
    const { a } = await seated();
    const ack = okAck(await emitAck(a, 'pod:deck', { text: LIST }));
    // Nothing unreadable: 40 basics from the pool, 19 cards from the card table. The same paste
    // against the suite above — the server with no card library — reports 19.
    expect(ack.deck).toMatchObject({ total: 59, distinct: 3, unknownCount: 0 });
    expect(ack.deck!.unknown).toEqual([]);
  }, 20_000);

  it('reads the same list into the summary, the ack and the dealt deck', async () => {
    /*
      D459's version of the three-way agreement above, and the reason the warm lives in
      `PodStore.mutate` rather than at the call sites: a pasted list is read three times inside one
      mutation — the ack, the lobby summary, the deck dealt — and they can only agree if all three
      see the same rows. Two names the table has and two it does not, so a reading that saw no rows
      (4 unreadable), or that saw rows for only the newly pasted list (2), is a different number
      from the right one.
    */
    const { a } = await seated();
    const text = [
      'Commander', '1 Elvish Mystic', '',
      'Deck', '40 Forest', '10 Wall of Omens',
      '5 Nonsense Card', '4 Also Not A Card',
    ].join('\n');

    const ack = okAck(await emitAck(a, 'pod:deck', { text }));
    expect(ack.deck).toMatchObject({ total: 59, unknownCount: 2 });
    expect(ack.deck!.unknown!.slice().sort()).toEqual(['Also Not A Card', 'Nonsense Card']);

    const seen = await waitFor<PodStateEvent>(a, 'pod:state', (st) => st.pod.seats[0]?.list !== undefined);
    expect(seen.pod.seats[0]!.list).toMatchObject({ total: 59, unknown: 2 });

    const loaded = okAck(await emitAck(a, 'pod:action', {
      action: { type: 'deck:load', seat: 0, deckId: 'custom:0' },
      expectedVersion: ack.stateVersion!,
    }));
    const after = await waitFor<PodStateEvent>(a, 'pod:state', (st) => st.stateVersion >= loaded.stateVersion!);
    const view = unpackView(after.state as unknown as PackedView);
    expect(view.seats.find((st) => st.index === 0)?.libraryCount).toBe(59);
    expect(view.zones['0:command']?.length).toBe(1);
  }, 20_000);

  it('deals a game in which the card table cards are played by the engine, not by hand', async () => {
    /*
      The payoff, read off `view.manual` — the list of cards the engine cannot play in the dealt
      game, which is what tells a person which ones to move themselves (D362, D363). Wall of Omens
      and Elvish Mystic are not on it, so the table is dealing them as cards with rules: a 0/4
      Defender that draws a card when it arrives, and a creature that taps for green.
    */
    const { a } = await seated();
    const pasted = okAck(await emitAck(a, 'pod:deck', { text: LIST }));
    const mine = okAck(await emitAck(a, 'pod:action', {
      action: { type: 'deck:load', seat: 0, deckId: 'custom:0' },
      expectedVersion: pasted.stateVersion!,
    }));
    const theirs = okAck(await emitAck(a, 'pod:action', {
      action: { type: 'deck:load', seat: 1, deckId: 'ember-rush' },
      expectedVersion: mine.stateVersion!,
    }));
    const started = okAck(await emitAck(a, 'pod:action', {
      action: { type: 'game:start' }, expectedVersion: theirs.stateVersion!,
    }));
    const auto = okAck(await emitAck(a, 'pod:action', {
      action: { type: 'auto:start' }, expectedVersion: started.stateVersion!,
    }));
    const dealt = await waitFor<PodStateEvent>(a, 'pod:state', (st) => st.stateVersion >= auto.stateVersion!);
    const view = unpackView(dealt.state as unknown as PackedView);
    expect(view.manual.map((m) => m.name)).toEqual([]);
    // And the cards really are the printed ones rather than a name with nothing behind it: read off
    // the hand, which is the one zone this seat may see.
    /*
      And the cards in hand really are the printed ones, not names with nothing behind them. Read
      through `view.cards`, because a zone carries instance ids and the definitions travel once each
      (D26) — so this is also the reading that would catch a card dealt as cardboard: cardboard has
      an empty type line, which is what `deckIsAutomatable` and the manual badge both key off.
    */
    const hand = (view.zones['0:hand'] ?? []).map((id) => view.cards[id]);
    expect(hand.length).toBeGreaterThan(0);
    for (const card of hand) {
      expect(['Forest', 'Wall of Omens', 'Elvish Mystic']).toContain(card?.card?.name);
      expect(card?.card?.typeLine ?? '').not.toBe('');
    }
    const omens = hand.find((c) => c?.card?.name === 'Wall of Omens')?.card;
    if (omens !== undefined) {
      // The printed card, from the card table: a 0/4 whose text is its own. The size travels as the
      // printed string, because `*` and `1+*` are printed values (see migration 0015).
      expect({ power: omens.power, toughness: omens.toughness }).toEqual({ power: '0', toughness: '4' });
      expect(omens.oracleText).toContain('When Wall of Omens enters, draw a card.');
    }
  }, 30_000);

  it('asks the card table for the names being pasted, before the list is on the record', async () => {
    /*
      `warmCards` inside `mutate` reads the lists already stored on the record, and a list being
      pasted is not on it yet — so `setDeck` warms the parsed names itself. Without that the ack,
      which is the reading the player is shown, would be the one reading that saw no rows.

      Asserted on what the lookup was asked for rather than on the ack alone, because the ack would
      also be right if the rows happened to be cached from an earlier test.
    */
    const { a } = await seated();
    okAck(await emitAck(a, 'pod:deck', { text: LIST }));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]!.slice().sort()).toEqual(['Elvish Mystic', 'Forest', 'Wall of Omens']);
  }, 20_000);

  it('resolves a list stored by one node when a second node deals it', async () => {
    /*
      Why `warmCards` is in `mutate` and not only in `setDeck`, found by a break run: removing it
      changed nothing, because the test above pastes and deals through the same process, and the
      cache the paste warmed is still warm when the deal reads it.

      That is not how this runs. Pods live entirely in Redis so **any node can serve any socket**
      (see this file's header), and an in-process cache is per node — so the node that deals a table
      is routinely not the node the list was pasted to, and its cache for those names is cold. Two
      stores over the same Redis and the same keyspace are exactly that pair of nodes, and the
      second one's library has never been asked for anything.

      Without the warm in `mutate`, the second node deals a deck of cardboard: the same list, the
      same player, a different table, because of which process happened to answer.
    */
    const prefix = `test-twonode:${Date.now().toString(36)}:${process.pid}`;
    /*
      A library that starts cold and only answers for what it was warmed with — which the fake
      shared by the tests above is not, and that is why those tests could not catch the missing
      warm. A fake that answers unconditionally is a fake with no cache in it, so it models the one
      situation that never happens.
    */
    const libraryFor = (): CardLibrary => {
      const warmed = new Map<string, CardDataRow>();
      return {
        warm: async (names) => {
          for (const name of names) {
            const row = ROWS.find((r) => r.name!.toLowerCase() === name.trim().toLowerCase());
            if (row !== undefined) warmed.set(name.trim().toLowerCase(), row);
          }
        },
        rowFor: (name) => warmed.get(name.trim().toLowerCase()),
        close: async () => {},
      };
    };
    const first = new PodStore(rt.redis, { keyPrefix: prefix, cards: libraryFor() });
    /*
      Two more nodes rather than one, because the warm happens in two places and each has to be
      shown on a cache that is genuinely cold. `dealer` is asked to act without reading first, which
      is the mutation path; `reader` only ever reads. Sharing one would hide whichever came second:
      the first call warms its library, and after that nothing about it is cold any more.
    */
    const dealer = new PodStore(rt.redis, { keyPrefix: prefix, cards: libraryFor() });
    const reader = new PodStore(rt.redis, { keyPrefix: prefix, cards: libraryFor() });
    try {
      const host = await first.create(
        { format: 'commander', visibility: 'private', name: 'Two nodes', bots: 1 },
        { id: makePlayerId('Alice'), name: 'Alice' },
      );
      const code = host.pod.code;
      const pasted = await first.setDeck(code, host.playerId, { text: LIST });
      expect(pasted.summary).toMatchObject({ unknownCount: 0 });
      const dealt = await first.ready(code, host.playerId, true);

      /*
        A node that has read nothing about this table, asked to deal the list straight away, and
        then to start the rules engine on it — because `view.manual` is the only reading that tells
        a resolved card from cardboard, and it is populated only once automation is running. The
        first draft of this stopped after the load and asserted `libraryCount`, which is 59 whether
        the deck is 19 printed cards or 19 blanks: a break run that removed the warm altogether left
        it passing.
      */
      const loaded = await dealer.applyAction(
        code, host.playerId,
        { type: 'deck:load', seat: 0, deckId: 'custom:0' },
        dealt.stateVersion,
      );
      expect(viewFor(loaded.state!, 0).seats.find((st) => st.index === 0)?.libraryCount).toBe(59);
      const started = await dealer.applyAction(
        code, host.playerId, { type: 'game:start' }, loaded.stateVersion,
      );
      const auto = await dealer.applyAction(
        code, host.playerId, { type: 'auto:start' }, started.stateVersion,
      );
      expect(viewFor(auto.state!, 0).manual.map((m) => m.name)).toEqual([]);

      // And a node that only reads: the summary it hands a player joining the table.
      const seen = await reader.get(code);
      expect(seen?.pod.seats[0]?.list).toMatchObject({ total: 59, unknown: 0 });
    } finally {
      await first.flushPrefix();
    }
  }, 30_000);

  it('still deals the built-in decks without asking the card table anything', async () => {
    /*
      A table playing the 348 hand-written cards must not pay for this at all: no pasted list, no
      names, no lookup. The guard is in `warmCards`, and this is what says it is there.

      Its own store and its own recording array, which the first two drafts did not have and which
      is the whole difficulty of asserting that something did *not* happen. Disconnecting the
      previous test's sockets makes the server mark those seats disconnected, and that mutation
      warms the previous pod's lists — asynchronously, landing whenever it lands. So a shared array
      picked up a lookup belonging to a test that had already finished, and clearing the array first
      did not help: the stray write arrives after the clear. Nothing can leak into an array only
      this test's store can write to.
    */
    const solo: string[][] = [];
    const store = new PodStore(rt.redis, {
      keyPrefix: `test-solo:${Date.now().toString(36)}:${process.pid}`,
      cards: {
        warm: async (names) => void solo.push([...names]),
        rowFor: () => undefined,
        close: async () => {},
      },
    });
    const pod = await store.create(
      { format: 'commander', visibility: 'private', name: 'Built-ins', bots: 1 },
      { id: makePlayerId('Solo'), name: 'Solo' },
    );
    await store.ready(pod.pod.code, pod.playerId, true);
    expect(solo).toEqual([]);
    // And the table really was dealt, so this is a lookup that did not happen rather than a
    // mutation that did not run.
    expect((await store.get(pod.pod.code))?.pod.status).toBe('in_progress');
    await store.flushPrefix();
  }, 20_000);
});
