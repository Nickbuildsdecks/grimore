/*
  Deals between players: the words, the expiry, and who broke one.

  Everything about a pact that is not storage lives here, because a pact is the one thing in this
  engine that is not a rule. See `GameState.pacts` for why it is modelled at all. The division of
  labour: this module knows what a deal *says* and when it stops covering anything, the reducer in
  `engine.ts` records the offer and the answer, and `autoActions.ts` asks `pactsBrokenBy` when
  attackers are declared. Nothing anywhere refuses an attack.
*/
import type { GameState, Pact, PactKind, SeatIndex } from './types.js';

/**
 * How many live pacts a table keeps.
 *
 * A cap because declined and expired pacts are never swept — the record is the feature — and a
 * long pod of a talkative table would otherwise grow the state without bound. Only settled pacts
 * are ever dropped (see `appendPact`), so the cap can never take a live agreement away from
 * somebody who is relying on it.
 */
export const MAX_PACTS = 40;

/** Seats a pact binds, in the direction each one promised. */
function promises(pact: Pact): readonly { readonly from: SeatIndex; readonly to: SeatIndex }[] {
  // A truce is the only one that binds both ways, and it is the one players actually make: "leave
  // me alone and I will leave you alone" is two promises in one sentence.
  return pact.kind === 'truce-until-your-turn'
    ? [{ from: pact.from, to: pact.to }, { from: pact.to, to: pact.from }]
    : [{ from: pact.from, to: pact.to }];
}

/**
 * Turns from now until `seat` is the active player again; a full rotation if it already is, and
 * null when that seat gets no more turns at all.
 */
function turnsUntilActive(state: GameState, seat: SeatIndex): number | null {
  const n = state.seats.length;
  for (let step = 1; step <= n; step++) {
    const idx = (state.activeSeat + step) % n;
    const at = state.seats[idx];
    if (at === undefined || at.eliminated) continue;
    if (idx === seat) return step;
  }
  return null;
}

/** A term that is already over, for a deal keyed to a turn nobody will take. */
const ALREADY_OVER = (state: GameState): number => state.turn - 1;

/**
 * The last turn an accepted pact covers, worked out when it is accepted.
 *
 * Turn numbers rather than a seat-and-count pair because an expiry has to survive eliminations:
 * "until my next turn" is ambiguous once a seat between us is gone, and a turn number is not.
 * The cost is that a pact is measured in turns taken rather than turns promised, which is the
 * same thing at the moment of acceptance and is what a player watching the table sees.
 */
export function pactThrough(state: GameState, pact: Pact): number {
  switch (pact.kind) {
    // The rest of this turn, which is what somebody asks for when an attack is already coming.
    case 'no-attack-this-turn':
      return state.turn;
    // Through the end of the offering player's next turn — the turn they would have attacked on.
    case 'no-attack-next-turn': {
      const until = turnsUntilActive(state, pact.from);
      // Nobody is owed anything by a player who is out of the game, and a deal struck with one
      // covers nothing rather than lasting forever — which is what a null expiry would mean.
      return until === null ? ALREADY_OVER(state) : state.turn + until;
    }
    // Until the receiving player's next turn *begins*, so the last turn covered is the one before
    // it. A truce that ran into their turn would be a truce they could not attack out of, which
    // is not what anybody means by "until your turn".
    case 'truce-until-your-turn': {
      const until = turnsUntilActive(state, pact.to);
      return until === null ? ALREADY_OVER(state) : state.turn + until - 1;
    }
  }
}

/**
 * Accepted, unbroken, and still inside its term, judged against a turn number.
 *
 * Takes the turn rather than the state because the table UI has to ask the same question of a
 * `GameView`, and a second implementation of "is this deal still on" is exactly the sort of thing
 * that ends up disagreeing with the engine about whose word is good.
 */
export function pactLiveAt(turn: number, pact: Pact): boolean {
  return pact.status === 'accepted' && pact.broken !== true
    && pact.throughTurn !== null && turn <= pact.throughTurn;
}

/** The same question, asked of a game state. */
export function pactIsLive(state: GameState, pact: Pact): boolean {
  return pactLiveAt(state.turn, pact);
}

/**
 * The seats a pact binds, for a caller outside this module.
 *
 * A truce binds both ways and the other two bind one; a table drawing a badge needs to know which
 * without re-deriving it from the kind.
 */
export function pactBinds(pact: Pact, a: SeatIndex, b: SeatIndex): boolean {
  return promises(pact).some((v) => (v.from === a && v.to === b) || (v.from === b && v.to === a));
}

/** Every live pact that covers `seat`, in either direction. For the badge on a seat. */
export function livePactsFor(state: GameState, seat: SeatIndex): Pact[] {
  return state.pacts.filter(
    (p) => pactIsLive(state, p) && promises(p).some((v) => v.from === seat || v.to === seat),
  );
}

/** True when `attacker` promised, in a pact still live, not to attack `defender`. */
export function pactProtects(state: GameState, attacker: SeatIndex, defender: SeatIndex): boolean {
  return state.pacts.some(
    (p) => pactIsLive(state, p) && promises(p).some((v) => v.from === attacker && v.to === defender),
  );
}

/**
 * The pacts this attack declaration breaks.
 *
 * Asked rather than enforced: the caller marks them broken and says so, and declares the attack
 * anyway. A player who goes back on a deal has done something the table should see, not something
 * the software should prevent.
 */
export function pactsBrokenBy(
  state: GameState, attacker: SeatIndex, defenders: readonly SeatIndex[],
): Pact[] {
  return state.pacts.filter(
    (p) => pactIsLive(state, p)
      && promises(p).some((v) => v.from === attacker && defenders.includes(v.to)),
  );
}

/** Marks the given pacts broken, leaving every other one alone. */
export function markPactsBroken(pacts: readonly Pact[], broken: readonly Pact[]): readonly Pact[] {
  if (broken.length === 0) return pacts;
  const ids = new Set(broken.map((p) => p.id));
  return pacts.map((p) => (ids.has(p.id) ? { ...p, broken: true as const } : p));
}

/** Adds a pact, dropping the oldest settled ones if the table is over its cap. */
export function appendPact(state: GameState, pact: Pact): readonly Pact[] {
  const next = [...state.pacts, pact];
  if (next.length <= MAX_PACTS) return next;
  const keep = next.filter((p) => p.status === 'offered' || pactIsLive(state, p));
  const settled = next.filter((p) => !(p.status === 'offered' || pactIsLive(state, p)));
  // Oldest settled first: `state.pacts` is in offer order, so dropping from the front of this
  // list drops the deals the table has had longest to forget.
  return [...settled.slice(Math.max(0, settled.length - (MAX_PACTS - keep.length))), ...keep];
}

/** The deal in words, naming both players, for the log. */
export function pactLine(state: GameState, from: SeatIndex, to: SeatIndex, kind: PactKind): string {
  return pactWords(kind, state.seats[from]?.name ?? `seat ${from}`, state.seats[to]?.name ?? `seat ${to}`);
}

/**
 * The same words from two names, for a caller that has the names and not the state.
 *
 * Third person and named on both sides, rather than the "I will not attack you" a player would
 * say: the same sentence is read by four people, and on the line where somebody *accepts* a deal
 * "I" is the wrong player.
 */
export function pactWords(kind: PactKind, a: string, b: string): string {
  switch (kind) {
    case 'no-attack-this-turn':
      return `${a} will not attack ${b} this turn`;
    case 'no-attack-next-turn':
      return `${a} will not attack ${b} next turn`;
    case 'truce-until-your-turn':
      return `${a} and ${b} will not attack each other until ${b}'s next turn`;
  }
}

/** The same deal short enough for a badge or a button. */
export function pactShort(kind: PactKind): string {
  switch (kind) {
    case 'no-attack-this-turn': return 'no attack this turn';
    case 'no-attack-next-turn': return 'no attack next turn';
    case 'truce-until-your-turn': return 'truce';
  }
}

/** The three deals a table may offer, in the order the UI shows them. */
export const PACT_KINDS: readonly PactKind[] = [
  'truce-until-your-turn', 'no-attack-this-turn', 'no-attack-next-turn',
];
