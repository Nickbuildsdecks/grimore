import { describe, expect, it } from 'vitest';
import {
  EngineError,
  FORMATS,
  MAX_LOG_ENTRIES,
  actionSeed,
  applyAction,
  applyMany,
  createGame,
  lastLogEntry,
  mulberry32,
  type Action,
  type GameState,
} from './index.js';

const HOST = { isHost: true } as const;

function pod(seed = 42): GameState {
  return createGame({
    id: 'table-1',
    format: 'pod',
    seed,
    players: [
      { playerId: 'p0', name: 'Ada' },
      { playerId: 'p1', name: 'Bob' },
      { playerId: 'p2', name: 'Cy' },
      { playerId: 'p3', name: 'Dee' },
    ],
  });
}

function duel(format: 'edh' | 'modern' = 'modern', seed = 7): GameState {
  return createGame({
    id: 'duel-1',
    format,
    seed,
    players: [
      { playerId: 'p0', name: 'Ada' },
      { playerId: 'p1', name: 'Bob' },
    ],
  });
}

function started(state: GameState): GameState {
  return applyAction(state, { type: 'game:start', by: 0 });
}

function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(EngineError);
  expect((thrown as EngineError).code).toBe(code);
}

describe('formats', () => {
  it('defines pod, edh and modern with the live app values', () => {
    expect(FORMATS.pod).toMatchObject({ minPlayers: 2, maxPlayers: 4, defaultPlayers: 4, startingLife: 40, commanderDamageRule: true });
    expect(FORMATS.edh).toMatchObject({ minPlayers: 2, maxPlayers: 2, startingLife: 40, commanderDamageRule: true });
    expect(FORMATS.modern).toMatchObject({ minPlayers: 2, maxPlayers: 2, startingLife: 20, commanderDamageRule: false });
  });
});

describe('createGame', () => {
  it('seats players with the format starting life', () => {
    const g = pod();
    expect(g.seats).toHaveLength(4);
    expect(g.seats.map((s) => s.life)).toEqual([40, 40, 40, 40]);
    expect(g.started).toBe(false);
    expect(g.turn).toBe(0);
    expect(g.stateVersion).toBe(0);
    expect(duel('modern').seats[0]!.life).toBe(20);
  });

  it('rejects wrong player counts and duplicate ids', () => {
    expectCode(() => createGame({ id: 'x', format: 'pod', players: [{ playerId: 'a', name: 'A' }] }), 'INVALID_PLAYERS');
    expectCode(
      () => createGame({ id: 'x', format: 'edh', players: [{ playerId: 'a', name: 'A' }, { playerId: 'b', name: 'B' }, { playerId: 'c', name: 'C' }] }),
      'INVALID_PLAYERS',
    );
    expectCode(
      () => createGame({ id: 'x', format: 'edh', players: [{ playerId: 'a', name: 'A' }, { playerId: 'a', name: 'B' }] }),
      'INVALID_PLAYERS',
    );
    expectCode(() => createGame({ id: 'x', format: 'vintage' as never, players: [] }), 'INVALID_FORMAT');
  });

  it('derives a deterministic seed from the id when none is given', () => {
    const a = createGame({ id: 'same', format: 'edh', players: [{ playerId: 'a', name: 'A' }, { playerId: 'b', name: 'B' }] });
    const b = createGame({ id: 'same', format: 'edh', players: [{ playerId: 'a', name: 'A' }, { playerId: 'b', name: 'B' }] });
    expect(a.rngSeed).toBe(b.rngSeed);
  });
});

describe('purity', () => {
  it('never mutates the input state', () => {
    const g = started(pod());
    const snapshot = structuredClone(g);
    const next = applyAction(g, { type: 'life:adjust', by: 1, seat: 1, delta: -5 });
    expect(g).toEqual(snapshot);
    expect(next).not.toBe(g);
    expect(next.seats[1]!.life).toBe(35);
    expect(g.seats[1]!.life).toBe(40);
    expect(next.seats[0]).toBe(g.seats[0]); // untouched seats are shared structurally
  });

  it('increments stateVersion and appends a log entry on every action', () => {
    const g = pod();
    const n1 = applyAction(g, { type: 'coin:flip', by: 0 });
    const n2 = applyAction(n1, { type: 'life:adjust', by: 2, seat: 2, delta: 1 });
    expect(n1.stateVersion).toBe(1);
    expect(n2.stateVersion).toBe(2);
    expect(n2.log).toHaveLength(2);
    expect(lastLogEntry(n2)).toMatchObject({ version: 2, by: 2, type: 'life:adjust' });
  });

  it('bounds the log to MAX_LOG_ENTRIES', () => {
    let g = pod();
    for (let i = 0; i < MAX_LOG_ENTRIES + 25; i++) {
      g = applyAction(g, { type: 'counter:adjust', by: 0, seat: 0, key: 'energy', delta: 1 });
    }
    expect(g.log).toHaveLength(MAX_LOG_ENTRIES);
    expect(g.log[g.log.length - 1]!.version).toBe(MAX_LOG_ENTRIES + 25);
    expect(g.log[0]!.version).toBe(26);
  });
});

describe('life, poison, counters and tax', () => {
  it('adjusts life and eliminates at 0 or below', () => {
    const g = started(pod());
    const hurt = applyAction(g, { type: 'life:adjust', by: 3, seat: 3, delta: -39 });
    expect(hurt.seats[3]!.eliminated).toBe(false);
    const dead = applyAction(hurt, { type: 'life:adjust', by: 3, seat: 3, delta: -1 });
    expect(dead.seats[3]).toMatchObject({ life: 0, eliminated: true, eliminatedReason: 'life' });
    expect(lastLogEntry(dead)!.message).toContain('eliminated (life)');
  });

  it('allows negative life and life gain', () => {
    const g = started(pod());
    const n = applyAction(g, { type: 'life:adjust', by: 0, seat: 0, delta: -45 });
    expect(n.seats[0]!.life).toBe(-5);
    expect(n.seats[0]!.eliminated).toBe(true);
    const gain = applyAction(g, { type: 'life:adjust', by: 0, seat: 0, delta: 10 });
    expect(gain.seats[0]!.life).toBe(50);
  });

  it('eliminates at 10 poison and never goes below 0', () => {
    const g = started(pod());
    const p9 = applyAction(g, { type: 'poison:adjust', by: 1, seat: 1, delta: 9 });
    expect(p9.seats[1]!.eliminated).toBe(false);
    const p10 = applyAction(p9, { type: 'poison:adjust', by: 1, seat: 1, delta: 1 });
    expect(p10.seats[1]).toMatchObject({ poison: 10, eliminated: true, eliminatedReason: 'poison' });
    const neg = applyAction(g, { type: 'poison:adjust', by: 1, seat: 1, delta: -3 });
    expect(neg.seats[1]!.poison).toBe(0);
  });

  it('tracks arbitrary counters and drops them at zero', () => {
    const g = pod();
    const e = applyAction(g, { type: 'counter:adjust', by: 0, seat: 0, key: 'energy', delta: 3 });
    const x = applyAction(e, { type: 'counter:adjust', by: 0, seat: 0, key: 'experience', delta: 2 });
    expect(x.seats[0]!.counters).toEqual({ energy: 3, experience: 2 });
    const z = applyAction(x, { type: 'counter:adjust', by: 0, seat: 0, key: 'energy', delta: -5 });
    expect(z.seats[0]!.counters).toEqual({ experience: 2 });
    expectCode(() => applyAction(g, { type: 'counter:adjust', by: 0, seat: 0, key: '', delta: 1 }), 'INVALID_ACTION');
  });

  it('adjusts commander tax with a floor of 0', () => {
    const g = pod();
    const t = applyAction(g, { type: 'commanderTax:adjust', by: 2, seat: 2, delta: 2 });
    expect(t.seats[2]!.commanderTax).toBe(2);
    const t2 = applyAction(t, { type: 'commanderTax:adjust', by: 2, seat: 2, delta: -4 });
    expect(t2.seats[2]!.commanderTax).toBe(0);
  });
});

describe('commander damage', () => {
  it('eliminates a seat at 21 damage from a single commander', () => {
    const g = started(pod());
    const a = applyAction(g, { type: 'commanderDamage:adjust', by: 0, seat: 0, fromSeat: 1, delta: 15 });
    const b = applyAction(a, { type: 'commanderDamage:adjust', by: 0, seat: 0, fromSeat: 2, delta: 15 });
    expect(b.seats[0]!.eliminated).toBe(false); // 15 + 15 across two commanders does not count
    expect(b.seats[0]!.commanderDamage).toEqual({ '1': 15, '2': 15 });
    const c = applyAction(b, { type: 'commanderDamage:adjust', by: 0, seat: 0, fromSeat: 1, delta: 6 });
    expect(c.seats[0]).toMatchObject({ eliminated: true, eliminatedReason: 'commanderDamage' });
    expect(c.seats[0]!.life).toBe(40); // commander damage is tracked separately from life
  });

  it('applies in edh but not in modern', () => {
    const e = started(duel('edh'));
    const dead = applyAction(e, { type: 'commanderDamage:adjust', by: 1, seat: 1, fromSeat: 0, delta: 21 });
    expect(dead.seats[1]!.eliminated).toBe(true);
    expect(dead.finished).toBe(true);
    const m = started(duel('modern'));
    expectCode(
      () => applyAction(m, { type: 'commanderDamage:adjust', by: 1, seat: 1, fromSeat: 0, delta: 21 }),
      'RULE_NOT_APPLICABLE',
    );
  });

  it('rejects self-inflicted commander damage and unknown seats', () => {
    const g = pod();
    expectCode(() => applyAction(g, { type: 'commanderDamage:adjust', by: 0, seat: 0, fromSeat: 0, delta: 1 }), 'INVALID_SEAT');
    expectCode(() => applyAction(g, { type: 'commanderDamage:adjust', by: 0, seat: 0, fromSeat: 9, delta: 1 }), 'INVALID_SEAT');
  });
});

describe('turns', () => {
  it('requires the game to be started and only the active seat may pass', () => {
    const g = pod();
    expectCode(() => applyAction(g, { type: 'turn:pass', by: 0 }), 'NOT_STARTED');
    const s = started(g);
    expect(s).toMatchObject({ started: true, turn: 1, activeSeat: 0 });
    expectCode(() => applyAction(s, { type: 'turn:pass', by: 2 }), 'NOT_ACTIVE_SEAT');
    const n = applyAction(s, { type: 'turn:pass', by: 0 });
    expect(n).toMatchObject({ turn: 2, activeSeat: 1 });
    expectCode(() => applyAction(s, { type: 'game:start', by: 0 }), 'ALREADY_STARTED');
  });

  it('lets the host pass on behalf of the active seat', () => {
    const s = started(pod());
    const n = applyAction(s, { type: 'turn:pass', by: 3 }, HOST);
    expect(n.activeSeat).toBe(1);
  });

  it('skips eliminated seats and wraps around', () => {
    let s = started(pod());
    s = applyAction(s, { type: 'concede', by: 1 });
    s = applyAction(s, { type: 'concede', by: 3 });
    s = applyAction(s, { type: 'turn:pass', by: 0 });
    expect(s.activeSeat).toBe(2);
    s = applyAction(s, { type: 'turn:pass', by: 2 });
    expect(s.activeSeat).toBe(0);
    expect(s.turn).toBe(3);
  });

  it('advances the active seat when it is eliminated mid-turn', () => {
    const s = started(pod());
    const n = applyAction(s, { type: 'life:adjust', by: 0, seat: 0, delta: -40 });
    expect(n.seats[0]!.eliminated).toBe(true);
    expect(n.activeSeat).toBe(1);
  });

  it('honours firstSeat on game:start', () => {
    const s = applyAction(pod(), { type: 'game:start', by: 0, firstSeat: 2 });
    expect(s.activeSeat).toBe(2);
    expectCode(() => applyAction(pod(), { type: 'game:start', by: 0, firstSeat: 7 }), 'INVALID_SEAT');
  });
});

describe('monarch and initiative', () => {
  it('sets, transfers and clears the monarch', () => {
    const s = started(pod());
    const m = applyAction(s, { type: 'monarch:set', by: 1, seat: 1 });
    expect(m.monarch).toBe(1);
    expectCode(() => applyAction(m, { type: 'monarch:set', by: 2, seat: 3 }), 'FORBIDDEN');
    const t = applyAction(m, { type: 'monarch:set', by: 0, seat: 3 }, HOST);
    expect(t.monarch).toBe(3);
    expectCode(() => applyAction(t, { type: 'monarch:set', by: 0, seat: null }), 'FORBIDDEN');
    const c = applyAction(t, { type: 'monarch:set', by: 3, seat: null });
    expect(c.monarch).toBeNull();
  });

  it('clears monarch and initiative when that seat is eliminated', () => {
    let s = started(pod());
    s = applyAction(s, { type: 'monarch:set', by: 2, seat: 2 });
    s = applyAction(s, { type: 'initiative:set', by: 2, seat: 2 });
    expect(s).toMatchObject({ monarch: 2, initiative: 2 });
    s = applyAction(s, { type: 'concede', by: 2 });
    expect(s).toMatchObject({ monarch: null, initiative: null });
  });
});

describe('winning and finishing', () => {
  it('finishes with a winner when one seat remains', () => {
    let s = started(pod());
    s = applyAction(s, { type: 'concede', by: 0 });
    s = applyAction(s, { type: 'life:adjust', by: 1, seat: 1, delta: -40 });
    expect(s.finished).toBe(false);
    s = applyAction(s, { type: 'poison:adjust', by: 3, seat: 3, delta: 10 });
    expect(s).toMatchObject({ finished: true, winnerSeat: 2 });
    expect(lastLogEntry(s)!.message).toContain('Cy wins');
  });

  it('finishes when all other seats concede', () => {
    let s = started(duel('modern'));
    s = applyAction(s, { type: 'concede', by: 1 });
    expect(s).toMatchObject({ finished: true, winnerSeat: 0 });
    expect(s.seats[1]).toMatchObject({ eliminated: true, eliminatedReason: 'concede' });
  });

  it('rejects any further action on a finished game', () => {
    let s = started(duel('modern'));
    s = applyAction(s, { type: 'concede', by: 1 });
    expectCode(() => applyAction(s, { type: 'life:adjust', by: 0, seat: 0, delta: 1 }), 'GAME_FINISHED');
    expectCode(() => applyAction(s, { type: 'coin:flip', by: 0 }), 'GAME_FINISHED');
    expectCode(() => applyAction(s, { type: 'turn:pass', by: 0 }), 'GAME_FINISHED');
  });

  it('rejects modifications to an eliminated seat', () => {
    let s = started(pod());
    s = applyAction(s, { type: 'concede', by: 1 });
    expectCode(() => applyAction(s, { type: 'life:adjust', by: 1, seat: 1, delta: 5 }), 'SEAT_ELIMINATED');
    expectCode(() => applyAction(s, { type: 'concede', by: 1 }), 'SEAT_ELIMINATED');
  });
});

describe('game:reset', () => {
  it('returns a fresh unstarted table with the same seats and a new deterministic seed', () => {
    let s = started(pod(99));
    s = applyAction(s, { type: 'life:adjust', by: 0, seat: 0, delta: -12 });
    s = applyAction(s, { type: 'concede', by: 1 });
    s = applyAction(s, { type: 'concede', by: 2 });
    s = applyAction(s, { type: 'concede', by: 3 });
    expect(s.finished).toBe(true);
    const r = applyAction(s, { type: 'game:reset', by: 0 }, HOST);
    expect(r).toMatchObject({ started: false, finished: false, winnerSeat: null, turn: 0, activeSeat: 0, monarch: null, initiative: null });
    expect(r.seats.map((x) => x.playerId)).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(r.seats.every((x) => x.life === 40 && !x.eliminated && x.poison === 0)).toBe(true);
    expect(r.rngSeed).not.toBe(s.rngSeed);
    expect(r.stateVersion).toBe(s.stateVersion + 1);
    const r2 = applyAction(s, { type: 'game:reset', by: 0 }, HOST);
    expect(r2.rngSeed).toBe(r.rngSeed);
  });

  it('requires the host', () => {
    expectCode(() => applyAction(pod(), { type: 'game:reset', by: 0 }), 'FORBIDDEN');
  });
});

describe('randomness', () => {
  it('mulberry32 is deterministic for a seed', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const xs = [a(), a(), a()];
    expect(xs).toEqual([b(), b(), b()]);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(actionSeed(1, 1)).not.toBe(actionSeed(1, 2));
  });

  it('dice rolls are reproducible from seed + stateVersion and stay in range', () => {
    const a = applyAction(pod(5), { type: 'dice:roll', by: 0, sides: 20, count: 3 });
    const b = applyAction(pod(5), { type: 'dice:roll', by: 0, sides: 20, count: 3 });
    const resultsA = lastLogEntry(a)!.data!['results'] as number[];
    const resultsB = lastLogEntry(b)!.data!['results'] as number[];
    expect(resultsA).toEqual(resultsB);
    expect(resultsA).toHaveLength(3);
    expect(resultsA.every((r) => Number.isInteger(r) && r >= 1 && r <= 20)).toBe(true);
    expect(a.stateVersion).toBe(1);
    expect(a.seats).toEqual(pod(5).seats);
  });

  it('different seeds or versions give different roll streams', () => {
    const roll = (g: GameState): number[] =>
      lastLogEntry(applyAction(g, { type: 'dice:roll', by: 0, sides: 1000, count: 10 }))!.data!['results'] as number[];
    expect(roll(pod(1))).not.toEqual(roll(pod(2)));
    const g = pod(1);
    const later = applyAction(g, { type: 'coin:flip', by: 0 });
    expect(roll(g)).not.toEqual(roll(later));
  });

  it('coin flips are deterministic and land on heads or tails', () => {
    const a = applyAction(pod(11), { type: 'coin:flip', by: 2 });
    const b = applyAction(pod(11), { type: 'coin:flip', by: 2 });
    const ra = lastLogEntry(a)!.data!['result'];
    expect(['heads', 'tails']).toContain(ra);
    expect(ra).toBe(lastLogEntry(b)!.data!['result']);
  });

  it('validates dice bounds', () => {
    const g = pod();
    expectCode(() => applyAction(g, { type: 'dice:roll', by: 0, sides: 1, count: 1 }), 'INVALID_NUMBER');
    expectCode(() => applyAction(g, { type: 'dice:roll', by: 0, sides: 1001, count: 1 }), 'INVALID_NUMBER');
    expectCode(() => applyAction(g, { type: 'dice:roll', by: 0, sides: 6, count: 0 }), 'INVALID_NUMBER');
    expectCode(() => applyAction(g, { type: 'dice:roll', by: 0, sides: 6, count: 21 }), 'INVALID_NUMBER');
    expectCode(() => applyAction(g, { type: 'dice:roll', by: 0, sides: 6.5, count: 1 }), 'INVALID_NUMBER');
  });
});

describe('replay', () => {
  it('applyMany reproduces the same final state as sequential applyAction', () => {
    const actions: Action[] = [
      { type: 'game:start', by: 0 },
      { type: 'dice:roll', by: 0, sides: 6, count: 2 },
      { type: 'life:adjust', by: 1, seat: 1, delta: -7 },
      { type: 'turn:pass', by: 0 },
      { type: 'coin:flip', by: 1 },
      { type: 'commanderDamage:adjust', by: 2, seat: 2, fromSeat: 1, delta: 9 },
      { type: 'monarch:set', by: 1, seat: 1 },
      { type: 'turn:pass', by: 1 },
      { type: 'concede', by: 3 },
    ];
    const sequential = actions.reduce((s, a) => applyAction(s, a), pod(2024));
    const batched = applyMany(pod(2024), actions);
    expect(batched).toEqual(sequential);
    expect(batched.stateVersion).toBe(actions.length);
    expect(batched.log.map((l) => l.message)).toEqual(sequential.log.map((l) => l.message));
  });

  it('applyMany accepts per-action contexts', () => {
    const s = applyMany(pod(), [
      { type: 'game:start', by: 0 },
      { action: { type: 'life:adjust', by: 0, seat: 2, delta: -3 }, ctx: HOST },
    ]);
    expect(s.seats[2]!.life).toBe(37);
    expectCode(
      () => applyMany(pod(), [{ type: 'game:start', by: 0 }, { type: 'life:adjust', by: 0, seat: 2, delta: -3 }]),
      'FORBIDDEN',
    );
  });
});

describe('permissions and validation', () => {
  it('only the seat itself may change its own totals', () => {
    const g = pod();
    expectCode(() => applyAction(g, { type: 'life:adjust', by: 0, seat: 1, delta: -1 }), 'FORBIDDEN');
    expectCode(() => applyAction(g, { type: 'poison:adjust', by: 0, seat: 1, delta: 1 }), 'FORBIDDEN');
    expectCode(() => applyAction(g, { type: 'commanderDamage:adjust', by: 0, seat: 1, fromSeat: 0, delta: 1 }), 'FORBIDDEN');
    expectCode(() => applyAction(g, { type: 'counter:adjust', by: 0, seat: 1, key: 'energy', delta: 1 }), 'FORBIDDEN');
    expectCode(() => applyAction(g, { type: 'commanderTax:adjust', by: 0, seat: 1, delta: 2 }), 'FORBIDDEN');
    expectCode(() => applyAction(g, { type: 'concede', by: 0, seat: 1 }), 'FORBIDDEN');
  });

  it('the host may act on behalf of any seat', () => {
    const g = pod();
    const n = applyAction(g, { type: 'life:adjust', by: 0, seat: 1, delta: -1 }, HOST);
    expect(n.seats[1]!.life).toBe(39);
    const c = applyAction(g, { type: 'concede', by: 0, seat: 1 }, HOST);
    expect(c.seats[1]!.eliminated).toBe(true);
  });

  it('rejects unknown seats, non-integer or out-of-range numbers', () => {
    const g = pod();
    expectCode(() => applyAction(g, { type: 'life:adjust', by: 4, seat: 4, delta: -1 }), 'INVALID_SEAT');
    expectCode(() => applyAction(g, { type: 'life:adjust', by: 0, seat: -1, delta: -1 }), 'INVALID_SEAT');
    expectCode(() => applyAction(g, { type: 'life:adjust', by: 0, seat: 0, delta: 1.5 }), 'INVALID_NUMBER');
    expectCode(() => applyAction(g, { type: 'life:adjust', by: 0, seat: 0, delta: Number.NaN }), 'INVALID_NUMBER');
    expectCode(() => applyAction(g, { type: 'life:adjust', by: 0, seat: 0, delta: Number.POSITIVE_INFINITY }), 'INVALID_NUMBER');
    expectCode(() => applyAction(g, { type: 'life:adjust', by: 0, seat: 0, delta: 1000 }), 'INVALID_NUMBER');
    expectCode(() => applyAction(g, { type: 'life:adjust', by: 0, seat: 0, delta: -1000 }), 'INVALID_NUMBER');
    expectCode(() => applyAction(g, { type: 'life:adjust', by: 0, seat: 0, delta: '5' as never }), 'INVALID_NUMBER');
  });

  it('rejects malformed actions', () => {
    const g = pod();
    expectCode(() => applyAction(g, { type: 'teleport', by: 0 } as never), 'INVALID_ACTION');
    expectCode(() => applyAction(g, null as never), 'INVALID_ACTION');
  });
});
