import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { io as connect, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import type { PodErrorEvent, PodStateEvent } from '@grimore/shared';
import { createRealtime, type Realtime } from './io.js';
import type { AckResult } from './handlers.js';
import { TokenBucket } from './ratelimit.js';
import { generateCode, toEngineFormat, maxSeatsFor } from './pod.js';
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
    expect(back.state).toEqual(state.state); // game untouched by the reconnect

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
});
