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

/** Four seats, for a Commander pod. The first two are the same people as a two-player table. */
export const POD_PLAYERS = [
  ...PLAYERS,
  { playerId: 'p-third', name: 'Third' },
  { playerId: 'p-fourth', name: 'Fourth' },
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
  /**
   * Whether the engine passes for a player with nothing to do. **Off by default here**, unlike at
   * a real table.
   *
   * A test board is deliberately almost empty — seven named cards instead of a hand — so with it
   * on, both seats would have nothing to do and the engine would correctly fast-forward past the
   * very step the test is about. A test that cares about one rule wants lock-step priority; the
   * playability of auto-passing is asserted by its own tests and by `playout.test.ts`, which play
   * real games from full hands.
   */
  readonly autoPass?: boolean;
  /**
   * The table format. `modern` by default, which has no command zone — a commander test needs
   * `edh` (two seats) or `pod` (up to four), because that is what puts the commander in the
   * command zone and turns on the twenty-one-damage rule.
   */
  readonly format?: 'modern' | 'edh' | 'pod';
  /** How many seats. Two by default; `pod` allows up to four. */
  readonly seats?: number;
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
  const count = setup.seats ?? 2;
  const seatList = Array.from({ length: count }, (_, i) => i as SeatIndex);
  let s = createGame({
    id: 'game-auto', format: setup.format ?? 'modern',
    players: POD_PLAYERS.slice(0, count), seed: 20261023,
  });
  const decks = { ...DECKS, ...setup.decks };
  s = applyAll(s, [
    ...seatList.map((seat) => ({
      type: 'deck:load' as const, by: seat, seat, deckId: decks[seat] ?? 'ember-rush',
    })),
    { type: 'game:start', by: 0, firstSeat: first },
  ]);

  // Clear every opening hand so only the named cards are held.
  for (const seat of seatList) {
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

  s = apply(s, { type: 'auto:start', by: 0, firstSeat: first, autoPass: setup.autoPass ?? false });
  // Opening hands are settled before turn one. Nothing here ever mulligans — a test board is built
  // card by card — so every seat simply keeps, which is what starts the game.
  for (const seat of seatList) s = apply(s, { type: 'auto:keep', by: seat });
  return s;
}

/** Passes priority round the table until something happens: the stack resolves or the step ends. */
export function passBoth(s: GameState): GameState {
  const step = s.step;
  // The *contents*, not the depth: a spell resolving into its own triggered ability leaves the
  // stack exactly as deep as it was, and a helper that compared depths would keep passing into a
  // trigger that is waiting to be aimed.
  const top = s.stackOrder.join(',');
  let next = s;
  for (let i = 0; i < 8; i++) {
    if (next.priority === null) return next;
    next = apply(next, { type: 'auto:pass', by: next.priority });
    if (next.pendingChoice !== null) return next;
    // A spell that stopped mid-resolution to ask a question is still on the stack, so neither the
    // step nor the contents have changed — passing again would just be refused.
    if (next.pendingDecision !== null) return next;
    if (next.step !== step || next.stackOrder.join(',') !== top) return next;
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
    const decision = next.pendingDecision;
    if (decision !== null) {
      next = apply(next, {
        type: 'auto:decide', by: decision.seat,
        cards: decision.candidates.slice(0, decision.min),
      });
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
    if (next.pendingDecision !== null) {
      throw new Error(`stopped at "${next.pendingDecision.prompt}" before reaching ${step}`);
    }
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

/**
 * Answers a mid-resolution question with the named cards, and fails loudly if nothing is asking.
 *
 * Named rather than indexed, because a test that said `candidates[0]` would keep passing after the
 * card it meant stopped being first.
 */
export function decide(s: GameState, names: readonly string[]): GameState {
  const pending = s.pendingDecision;
  if (pending === null) throw new Error('nothing is waiting on a decision');
  const cards = names.map((name) => {
    const id = pending.candidates.find((c) => nameOf(s, c) === name);
    if (id === undefined) {
      throw new Error(`"${name}" is not a choice (offered: ${pending.candidates.map((c) => nameOf(s, c)).join(', ')})`);
    }
    return id;
  });
  return apply(s, { type: 'auto:decide', by: pending.seat, cards });
}

/** What a mid-resolution question is offering, by name and sorted, for an assertion. */
export function choices(s: GameState): string[] {
  const pending = s.pendingDecision;
  if (pending === null) throw new Error('nothing is waiting on a decision');
  return pending.candidates.map((c) => nameOf(s, c)).sort();
}

/**
 * Passes priority until the stack is empty and nothing is queued.
 *
 * Needed because a *tabletop* action — `card:move`, `token:create` — never calls `settle`, so a
 * death or an arrival it causes is recorded and sits there until the next engine action announces
 * it. A test that creates a token by hand and then looks at the stack sees an empty one, which is
 * the trap this exists to avoid.
 */
export function drain(s: GameState, limit = 16): GameState {
  let next = s;
  for (let i = 0; i < limit; i++) {
    if (
      next.stackOrder.length === 0 && next.died.length === 0
      && next.entered.length === 0 && next.left.length === 0
    ) return next;
    if (next.pendingChoice !== null || next.pendingDecision !== null) return next;
    if (next.priority === null) return next;
    next = apply(next, { type: 'auto:pass', by: next.priority });
  }
  return next;
}

/** The names on the stack, bottom first. */
export const stackNames = (s: GameState): string[] =>
  [...s.stackOrder].map((id) => s.stackObjects[id]!.description);

/**
 * `STATE_MAX_BYTES` from the realtime contract, restated for the tests that measure against it.
 *
 * Restated rather than imported: the engine depends on nothing, least of all the transport, and a
 * package dependency added for one number in a test would be the wrong trade. The derivation lives
 * with the real constant in `packages/shared/src/realtime/events.ts` — change it there and these
 * assertions are the ones that should fail next.
 */
export const WIRE_CAP = 128 * 1024;
