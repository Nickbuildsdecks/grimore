/**
 * A player that only ever does what the engine says it may.
 *
 * Its first job is a test: it plays whole games from shuffled decks, choosing every move from
 * `legalActions` and nothing else, so a game that finishes is proof of two things that are hard to
 * assert any other way — the engine never offers an illegal play, and it never reaches a state
 * where nobody can do anything. A deadlock in an Arena-style engine is worse than a wrong ruling,
 * because a wrong ruling is at least a game.
 *
 * Its second job is to be the AI opponent for a table with one player, which is why it lives in
 * `src/` and not in a test file. The decision-making is deliberately shallow — attack with
 * everything, block when the trade is good, cast the biggest thing you can afford — because a
 * stronger opponent needs a search, and a search needs a position evaluator, and neither is worth
 * writing before the rules underneath them are trustworthy.
 */
import { legalActions, type LegalActions, type LegalPlay } from './legalActions.js';
import { bottomOwed, pendingDeclaration, stillDeciding } from './automation.js';
import { characteristicsOf } from './characteristics.js';
import { canAttack, canBlock } from './combat.js';
import { applyAction } from './engine.js';
import { costValue, parseManaCost } from './mana.js';
import type { Target } from './turnTypes.js';
import type { Action, ActionContext, GameState, SeatIndex } from './types.js';

const HOST: ActionContext = { isHost: true };

/** How a bot values a play. Higher is chosen first. */
const playValue = (play: LegalPlay): number => {
  if (play.kind === 'land') return 1000; // always make your land drop
  if (play.isManaAbility) return -1000; // mana is tapped on demand, not for its own sake
  return costValue(parseManaCost(play.manaCost));
};

/** The opponents of a seat, nearest first. */
const foesOf = (state: GameState, seat: SeatIndex): SeatIndex[] =>
  state.seats.filter((s) => s.index !== seat && !s.eliminated).map((s) => s.index);

/**
 * Picks targets for a play, preferring the opponent and the opponent's creatures.
 *
 * It has no idea what a card does, so a pump spell gets aimed at an enemy creature — legal, and
 * wasteful. Fixing that needs the bot to read the script's intent, which is a different piece of
 * work; what matters here is that every choice comes from the candidate list the engine produced,
 * so a bad choice is still a legal one.
 */
function chooseTargets(state: GameState, seat: SeatIndex, play: LegalPlay): Target[] | null {
  const chosen: Target[] = [];
  const used = new Set<string>();
  const foes = foesOf(state, seat);
  for (let i = 0; i < play.targetSpecs.length; i++) {
    const spec = play.targetSpecs[i]!;
    const candidates = (play.candidates[i] ?? []).filter(
      (t) => !used.has(t.kind === 'card' ? `c${t.id}` : `p${t.seat}`),
    );
    const enemyFirst = [...candidates].sort((a, b) => rank(state, b, foes) - rank(state, a, foes));
    const pick = enemyFirst[0];
    if (pick === undefined) {
      if (spec.optional) continue;
      return null;
    }
    used.add(pick.kind === 'card' ? `c${pick.id}` : `p${pick.seat}`);
    chosen.push(pick);
  }
  return chosen;
}

/** Enemy players score highest, then enemy creatures by size, then anything else. */
function rank(state: GameState, target: Target, foes: readonly SeatIndex[]): number {
  if (target.kind === 'player') return foes.includes(target.seat) ? 100 : -100;
  const inst = state.instances[target.id];
  if (inst === undefined) return -100;
  const mine = !foes.includes(inst.zoneSeat);
  const size = characteristicsOf(state, inst).power;
  return mine ? -50 + size : 50 + size;
}

/** Everything the seat can attack with, which for this bot is everything it is allowed to. */
function chooseAttackers(state: GameState, seat: SeatIndex): { attacker: string; defender: SeatIndex }[] {
  const foe = foesOf(state, seat)[0];
  if (foe === undefined) return [];
  return legalActions(state, seat).attackers
    .filter((id) => canAttack(state, id, seat) === null)
    .map((attacker) => ({ attacker, defender: foe }));
}

/**
 * Blocks where the trade is not a loss: the blocker kills the attacker, or survives it.
 *
 * A bot that chump-blocked everything would never die, and a bot that never blocked would die to
 * the first two creatures — neither plays a game out, which is the whole point of this file.
 */
function chooseBlocks(state: GameState, seat: SeatIndex): { blocker: string; attacker: string }[] {
  const out: { blocker: string; attacker: string }[] = [];
  const taken = new Set<string>();
  const lifeLeft = state.seats[seat]?.life ?? 0;
  const incoming = state.combat.attacks
    .filter((a) => a.defender === seat)
    .reduce((n, a) => {
      const inst = state.instances[a.attacker];
      return n + (inst === undefined ? 0 : characteristicsOf(state, inst).power);
    }, 0);
  // With lethal coming in, any block is better than no block.
  const desperate = incoming >= lifeLeft;

  for (const option of legalActions(state, seat).blockers) {
    const blocker = state.instances[option.blocker];
    if (blocker === undefined) continue;
    const mine = characteristicsOf(state, blocker);
    for (const attackerId of option.canBlock) {
      if (taken.has(attackerId) && !desperate) continue;
      const attacker = state.instances[attackerId];
      if (attacker === undefined) continue;
      if (canBlock(state, option.blocker, attackerId, seat) !== null) continue;
      const theirs = characteristicsOf(state, attacker);
      const kills = mine.power >= theirs.toughness;
      const survives = mine.toughness > theirs.power;
      // Menace needs two blockers, which this bot does not coordinate, so it leaves them alone.
      if (theirs.keywords.has('menace')) continue;
      if (!desperate && !kills && !survives) continue;
      out.push({ blocker: option.blocker, attacker: attackerId });
      taken.add(attackerId);
      break;
    }
  }
  return out;
}

/** The cards in a seat's hand, most expensive first — what to pitch, and what to bottom. */
function handByCost(state: GameState, seat: SeatIndex): { id: string; cmc: number; land: boolean }[] {
  return [...(state.zones[`${seat}:hand`] ?? [])]
    .map((id) => {
      const def = state.cardDefs[state.instances[id]!.defKey];
      return {
        id,
        cmc: costValue(parseManaCost(def?.manaCost)),
        land: /land/i.test(def?.typeLine ?? ''),
      };
    })
    .sort((a, b) => b.cmc - a.cmc);
}

/**
 * Keep or mulligan, on the one heuristic that matters.
 *
 * A hand with no land cannot be played and a hand that is all land cannot do anything, and those
 * two cases are most of what a mulligan is for. Anything in between is kept, because judging a
 * borderline hand needs to know what the deck is trying to do — which is a different piece of work
 * from knowing the rules. It mulligans at most twice: a five-card hand is usually worse than a
 * mediocre six.
 */
function settleOpeningHand(state: GameState, seat: SeatIndex): Action {
  const hand = handByCost(state, seat);
  const lands = hand.filter((c) => c.land).length;
  const mulligans = state.seats[seat]?.mulligans ?? 0;
  if (mulligans < 2 && (lands <= 1 || lands >= hand.length - 1)) {
    return { type: 'mulligan', by: seat, seat };
  }
  // Bottom the most expensive non-lands first: a hand that mulliganed is short on mana, and the
  // cards it can least afford to cast are the ones it will miss least.
  const owed = bottomOwed(state, seat);
  const pitchable = [...hand.filter((c) => !c.land), ...hand.filter((c) => c.land)];
  return { type: 'auto:keep', by: seat, bottom: pitchable.slice(0, owed).map((c) => c.id) };
}

/** The single action this seat would take now, or null when it has nothing to do. */
export function botAction(state: GameState, seat: SeatIndex): Action | null {
  if (!state.automated || state.finished) return null;
  if (state.openingHands) {
    return state.kept.includes(seat) ? null : settleOpeningHand(state, seat);
  }
  const actions: LegalActions = legalActions(state, seat);

  if (actions.mustDiscard > 0) {
    // Pitch the most expensive thing, which is the card least likely to be castable.
    const worst = handByCost(state, seat)[0];
    return worst === undefined ? null : { type: 'auto:discard', by: seat, card: worst.id };
  }

  const owed = pendingDeclaration(state);
  if (owed !== null && owed.seats.includes(seat)) {
    return owed.kind === 'attackers'
      ? { type: 'auto:attack', by: seat, attackers: chooseAttackers(state, seat) }
      : { type: 'auto:block', by: seat, blocks: chooseBlocks(state, seat) };
  }

  if (!actions.hasPriority) return null;

  const playable = actions.plays
    .filter((p) => !p.isManaAbility)
    .sort((a, b) => playValue(b) - playValue(a));
  for (const play of playable) {
    const targets = chooseTargets(state, seat, play);
    if (targets === null) continue;
    if (play.kind === 'land') return { type: 'auto:playLand', by: seat, card: play.card };
    // Only offer the play if the mana for it can actually be produced; `legalActions` judges
    // affordability against untapped sources, and the tapping happens in `botTurn`.
    if (play.kind === 'cast') {
      return {
        type: 'auto:cast', by: seat, card: play.card,
        ...(targets.length > 0 ? { targets } : {}),
      };
    }
    return {
      type: 'auto:activate', by: seat, card: play.card, abilityIndex: play.abilityIndex ?? 0,
      ...(targets.length > 0 ? { targets } : {}),
    };
  }
  return { type: 'auto:pass', by: seat };
}

/**
 * Applies one bot action for one seat.
 *
 * There is no mana bookkeeping here on purpose: the engine taps for a cost it can pay, so a play
 * `legalActions` offered is one the engine will accept. A bot that tapped lands itself would be
 * second-guessing that, and would get it wrong the first time a land made two colours.
 */
export function botStep(state: GameState, seat: SeatIndex): GameState {
  const action = botAction(state, seat);
  if (action === null) return state;
  return applyAction(state, action, HOST);
}

export interface PlayOutResult {
  readonly state: GameState;
  readonly actions: number;
  readonly turns: number;
}

/**
 * Plays a game out with bots in every seat until somebody wins or `maxActions` is spent.
 *
 * Returns rather than throws when it runs out of actions, so a test can assert on how far it got
 * instead of only that it threw.
 */
export function playOut(state: GameState, maxActions = 6000): PlayOutResult {
  let next = state;
  let actions = 0;
  while (!next.finished && actions < maxActions) {
    const seat = seatToAct(next);
    if (seat === null) break;
    const before = next.stateVersion;
    next = botStep(next, seat);
    actions += 1;
    // No progress means a state nobody can act on, which is the deadlock this is looking for.
    if (next.stateVersion === before) break;
  }
  return { state: next, actions, turns: next.turn };
}

/** Which seat the engine is waiting on: the one owing a declaration, a discard, or priority. */
export function seatToAct(state: GameState): SeatIndex | null {
  if (!state.automated || state.finished) return null;
  // Opening hands come before anything else, including priority.
  if (state.openingHands) return stillDeciding(state)[0] ?? null;
  if (state.pendingDiscard !== null) return state.pendingDiscard.seat;
  const owed = pendingDeclaration(state);
  if (owed !== null) return owed.seats[0] ?? null;
  return state.priority;
}
