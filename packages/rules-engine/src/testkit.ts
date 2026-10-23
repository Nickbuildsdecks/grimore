/**
 * Board setup for the automation tests. Not shipped — `tsconfig.json` excludes it.
 *
 * Testing an automated rules engine needs a known board, and a shuffled 60-card deck is the
 * opposite of that. So this builds positions the way a judge sets one up for a ruling: it uses the
 * *tabletop* actions (`card:move`, `token:create`) to put named cards exactly where it wants them,
 * then hands the table to the rules engine with `auto:start`. Nothing here reaches into the state
 * directly, which matters: a test whose setup bypassed the reducers could pass against a state no
 * sequence of real actions could produce.
 */
import {
  applyAction,
  applyMany,
  createGame,
  zoneKey,
  type Action,
  type ActionContext,
  pendingDeclaration,
  type GameState,
  type SeatIndex,
  type Step,
} from './index.js';

export const PLAYERS = [
  { playerId: 'p-nick', name: 'Nick' },
  { playerId: 'p-friend', name: 'Friend' },
];

export const HOST: ActionContext = { isHost: true };

export const ids = (s: GameState, seat: SeatIndex, zone: Parameters<typeof zoneKey>[1]): readonly string[] =>
  s.zones[zoneKey(seat, zone)] ?? [];

export const nameOf = (s: GameState, id: string): string => s.cardDefs[s.instances[id]!.defKey]?.name ?? '?';

export const namesIn = (s: GameState, seat: SeatIndex, zone: Parameters<typeof zoneKey>[1]): string[] =>
  [...ids(s, seat, zone)].map((id) => nameOf(s, id)).sort();

export const life = (s: GameState, seat: SeatIndex): number => s.seats[seat]!.life;

export const damageOn = (s: GameState, id: string): number => s.instances[id]!.damage;

/** Finds an instance by card name in a zone, and fails loudly rather than returning undefined. */
export function find(s: GameState, seat: SeatIndex, zone: Parameters<typeof zoneKey>[1], name: string): string {
  const id = [...ids(s, seat, zone)].find((i) => nameOf(s, i) === name);
  if (id === undefined) {
    throw new Error(`seat ${seat} has no ${name} in ${zone} (has: ${namesIn(s, seat, zone).join(', ') || 'nothing'})`);
  }
  return id;
}

/** How many copies of a card the seat has in a zone. */
export const countOf = (s: GameState, seat: SeatIndex, zone: Parameters<typeof zoneKey>[1], name: string): number =>
  [...ids(s, seat, zone)].filter((i) => nameOf(s, i) === name).length;

export const apply = (s: GameState, action: Action): GameState => applyAction(s, action, HOST);
export const applyAll = (s: GameState, actions: readonly Action[]): GameState => applyMany(s, actions, HOST);

/** The error an action throws, as a string, or `null` when it is accepted. */
export function refusal(s: GameState, action: Action): string | null {
  try {
    apply(s, action);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Lands to place: a count of the seat's primary basic, or an explicit list of basics. */
export type Lands = number | readonly string[];

export interface Setup {
  /** Which deck each seat plays, when a test needs a card the default decks do not contain. */
  readonly decks?: Readonly<Record<number, string>>;
  /** Cards to put in each seat's hand, by name. Everything else goes back to the library. */
  readonly hands?: Readonly<Record<number, readonly string[]>>;
  /** Cards to put onto each seat's battlefield, by name. */
  readonly battlefield?: Readonly<Record<number, readonly string[]>>;
  /** Which seat takes the first turn. */
  readonly firstSeat?: SeatIndex;
  /** Turn to pretend we have reached, so battlefield creatures are not summoning sick. */
  readonly turn?: number;
}

const DECKS: Readonly<Record<number, string>> = { 0: 'ember-rush', 1: 'verdant-guard' };

/**
 * A board with exactly the cards asked for, handed to the rules engine.
 *
 * Opening hands are emptied and the named cards pulled out of the library, so a test says what it
 * needs and gets nothing else. `turn` fast-forwards the turn counter before handing over, which is
 * how a creature put onto the battlefield during setup avoids summoning sickness: the engine judges
 * that by comparing the turn it arrived with the current turn, so arriving on turn 1 and playing on
 * turn 3 is exactly the situation a test wants.
 */
export function arena(setup: Setup = {}): GameState {
  const first = setup.firstSeat ?? 0;
  let s = createGame({ id: 'game-auto', format: 'modern', players: PLAYERS, seed: 20261023 });
  const decks = { ...DECKS, ...setup.decks };
  s = applyAll(s, [
    { type: 'deck:load', by: 0, seat: 0, deckId: decks[0]! },
    { type: 'deck:load', by: 1, seat: 1, deckId: decks[1]! },
    { type: 'game:start', by: 0, firstSeat: first },
  ]);

  // Clear both opening hands so only the named cards are held.
  for (const seat of [0, 1] as SeatIndex[]) {
    for (const id of [...ids(s, seat, 'hand')]) {
      s = apply(s, { type: 'card:move', by: seat, card: id, toZone: 'library', position: 'bottom' });
    }
  }

  const place = (seat: SeatIndex, names: readonly string[], zone: 'hand' | 'battlefield'): void => {
    for (const name of names) {
      const id = find(s, seat, 'library', name);
      s = apply(s, { type: 'card:move', by: seat, card: id, toZone: zone });
    }
  };
  for (const [seat, names] of Object.entries(setup.hands ?? {})) place(Number(seat) as SeatIndex, names, 'hand');
  for (const [seat, names] of Object.entries(setup.battlefield ?? {})) {
    place(Number(seat) as SeatIndex, names, 'battlefield');
  }

  // Fast-forward the turn counter with repeated `turn:pass`, which is the tabletop's own action, so
  // creatures placed above have been on the battlefield "since before this turn".
  const target = setup.turn ?? 1;
  for (let turn = 1; turn < target; turn++) s = apply(s, { type: 'turn:pass', by: s.activeSeat });
  if (s.activeSeat !== first) s = apply(s, { type: 'turn:pass', by: s.activeSeat });

  return apply(s, { type: 'auto:start', by: 0, firstSeat: first });
}

/** Passes priority round the table until something happens: the stack resolves or the step ends. */
export function passBoth(s: GameState): GameState {
  const step = s.step;
  const depth = s.stackOrder.length;
  let next = s;
  for (let i = 0; i < 8; i++) {
    if (next.priority === null) return next;
    next = apply(next, { type: 'auto:pass', by: next.priority });
    if (next.step !== step || next.stackOrder.length !== depth) return next;
  }
  throw new Error(`passing did not change anything (step ${step})`);
}

/**
 * Runs the turn out and stops at the beginning of the next one.
 *
 * Unlike `advanceTo` this one answers the decisions it meets — no attackers, no blockers, discard
 * the first card — because a test that only wants to see what wears off at end of turn should not
 * have to play out a combat to get there.
 */
export function nextTurn(s: GameState): GameState {
  const from = s.turn;
  let next = s;
  for (let i = 0; i < 120; i++) {
    if (next.turn > from) return next;
    const discard = next.pendingDiscard;
    if (discard !== null) {
      next = apply(next, { type: 'auto:discard', by: discard.seat, card: ids(next, discard.seat, 'hand')[0]! });
      continue;
    }
    const owed = pendingDeclaration(next);
    if (owed !== null) {
      for (const seat of owed.seats) {
        next = owed.kind === 'attackers'
          ? apply(next, { type: 'auto:attack', by: seat, attackers: [] })
          : apply(next, { type: 'auto:block', by: seat, blocks: [] });
      }
      continue;
    }
    if (next.priority === null) throw new Error(`nobody holds priority at ${next.step}`);
    next = apply(next, { type: 'auto:pass', by: next.priority });
  }
  throw new Error(`never reached turn ${from + 1} (stuck at ${next.step})`);
}

/**
 * Passes priority until the game reaches `step`, or fails if it does not get there.
 *
 * Deliberately refuses to pass through a step that wants a decision: if the engine stops for a
 * declaration or a discard, that is a fact about the state the test wants to see, not something to
 * paper over. Only steps where somebody receives priority are reachable — untap and cleanup are
 * walked straight through, so ask for `upkeep` rather than `untap`.
 */
export function advanceTo(s: GameState, step: Step, limit = 60): GameState {
  let next = s;
  for (let i = 0; i < limit; i++) {
    if (next.step === step) return next;
    if (next.pendingDiscard !== null) throw new Error(`stopped at a discard before reaching ${step}`);
    if (next.priority === null) throw new Error(`stopped at ${next.step} (a declaration is owed) before reaching ${step}`);
    next = apply(next, { type: 'auto:pass', by: next.priority });
  }
  throw new Error(`never reached ${step} (stuck at ${next.step})`);
}

/** Taps every untapped land the seat controls for mana, so a test can afford what it casts. */
export function tapAllLands(s: GameState, seat: SeatIndex): GameState {
  let next = s;
  for (const id of [...ids(next, seat, 'battlefield')]) {
    const inst = next.instances[id]!;
    if (inst.tapped) continue;
    const def = next.cardDefs[inst.defKey];
    if (!(def?.typeLine ?? '').toLowerCase().includes('land')) continue;
    next = apply(next, { type: 'auto:activate', by: seat, card: id, abilityIndex: 0 });
  }
  return next;
}

/** The names on the stack, bottom first. */
export const stackNames = (s: GameState): string[] =>
  [...s.stackOrder].map((id) => s.stackObjects[id]!.description);
