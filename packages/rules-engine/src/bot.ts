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

/**
 * How a bot values a play. Higher is chosen first.
 *
 * A modal spell arrives as one play per combination of modes, all at the same mana cost, so the
 * tie-break is how many modes it takes: more of the card is more of the card. It has no idea what
 * any mode *does*, which is the same shallowness as everywhere else here — what matters is that
 * every option it picks from came from the engine, so "choose one or both" never takes a mode
 * whose target it cannot fill.
 */
const playValue = (play: LegalPlay): number => {
  if (play.kind === 'land') return 1000; // always make your land drop
  if (play.isManaAbility) return -1000; // mana is tapped on demand, not for its own sake
  // An X spell is worth what X will be: `{X}{R}` parses as a one-mana card, so without this a
  // Fireball for eight ranks below a Shock and gets cast for nothing or not at all.
  return costValue(parseManaCost(play.manaCost)) + (play.xMax ?? 0) + (play.modes?.length ?? 0) / 10;
};

/**
 * Answers a card's mid-resolution question.
 *
 * The one judgement that matters is which way the question cuts. A card out of a library or a
 * graveyard is something the bot is *gaining*, so it takes as many as it may and the best of them;
 * a card out of its hand or off its battlefield is something it is *losing*, so it gives up as few
 * as it may and the worst of them. A bot that answered every question with "the first candidate"
 * would tutor up a Mountain and sacrifice its best creature while passing every test that only
 * checks the game finished.
 */
function decideCards(
  state: GameState, ask: NonNullable<LegalActions['mustDecide']>,
): string[] {
  const gaining = ask.from === 'library' || ask.from === 'graveyard';
  const ranked = [...ask.candidates].sort((a, b) => cardWorth(state, b) - cardWorth(state, a));
  const take = gaining ? ask.max : ask.min;
  return (gaining ? ranked : ranked.reverse()).slice(0, take);
}

/**
 * Roughly how much the bot wants a card, for a choice it has no other way to judge.
 *
 * Mana value, with a land worth a flat amount: a land has no mana cost, so cost alone would make
 * every land the worst card in every pile — and a tutor that fetches land is most of what a tutor
 * in these decks is for.
 */
function cardWorth(state: GameState, id: string): number {
  const inst = state.instances[id];
  if (inst === undefined) return 0;
  const def = state.cardDefs[inst.defKey];
  if (/land/i.test(def?.typeLine ?? '')) return 2.5;
  return costValue(parseManaCost(def?.manaCost));
}

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

/** The least valuable of a set of creatures, for feeding to something hungry. */
function cheapestCreature(state: GameState, ids: readonly string[]): string | null {
  let best: { id: string; power: number } | null = null;
  for (const id of ids) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const power = characteristicsOf(state, inst).power;
    if (best === null || power < best.power) best = { id, power };
  }
  return best?.id ?? null;
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
/**
 * Who attacks, and whom.
 *
 * In a two-player game "whom" is not a question. In a pod it is the whole question, and the bot's
 * answer is the shallow one that is still a real answer: go for whoever is closest to dead, and
 * send a creature at somebody else when the lowest player already has enough coming at them to
 * finish them. That spreads attacks across seats, which also means several defenders owe a block
 * at once — a path no four-player game exercised before, because aiming everything at one seat
 * meant the engine's multi-defender declarations were only ever asserted on a built board.
 */
function chooseAttackers(state: GameState, seat: SeatIndex): { attacker: string; defender: SeatIndex }[] {
  const foes = foesOf(state, seat)
    .map((index) => ({ index, life: state.seats[index]?.life ?? 0 }))
    .sort((a, b) => a.life - b.life);
  if (foes.length === 0) return [];
  const able = legalActions(state, seat).attackers.filter((id) => canAttack(state, id, seat) === null);

  const out: { attacker: string; defender: SeatIndex }[] = [];
  let at = 0;
  let committed = 0;
  for (const attacker of able) {
    const target = foes[at] ?? foes[foes.length - 1]!;
    out.push({ attacker, defender: target.index });
    const inst = state.instances[attacker];
    committed += inst === undefined ? 0 : characteristicsOf(state, inst).power;
    // Enough to kill them outright: anything further is wasted here, so the next one goes
    // somewhere else. Unblocked damage is the assumption, which is what makes it shallow.
    if (committed >= target.life && at < foes.length - 1) {
      at += 1;
      committed = 0;
    }
  }
  return out;
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

  // A card that stopped mid-resolution to ask this seat something blocks everything, including
  // the player whose spell it is, so it is answered before anything else is even considered.
  const ask = actions.mustDecide;
  if (ask !== null) return { type: 'auto:decide', by: seat, cards: decideCards(state, ask) };

  // A trigger waiting for its targets blocks everything else, so it is answered next.
  const choice = actions.mustChoose;
  if (choice !== null) {
    const foes = foesOf(state, seat);
    const chosen: Target[] = [];
    const used = new Set<string>();
    for (let i = 0; i < choice.specs.length; i++) {
      const want = Math.max(1, choice.specs[i]!.count ?? 1);
      const ranked = [...(choice.candidates[i] ?? [])]
        .filter((t) => !used.has(t.kind === 'card' ? `c${t.id}` : `p${t.seat}`))
        .sort((a, b) => rank(state, b, foes) - rank(state, a, foes));
      for (const pick of ranked.slice(0, want)) {
        used.add(pick.kind === 'card' ? `c${pick.id}` : `p${pick.seat}`);
        chosen.push(pick);
      }
    }
    return { type: 'auto:choose', by: seat, targets: chosen };
  }

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
        // X as large as the mana allows. The shallowness here is the same as everywhere else in
        // this file — it does not know what the card does, so it does not know that a Hurricane
        // hits its own controller too, and it will occasionally kill itself with one. That is the
        // bot being a bot rather than the rules being wrong, and it is why `playout.test.ts`
        // asserts that games *finish* rather than that they are played well.
        ...(play.xMax === undefined ? {} : { x: play.xMax }),
        ...(play.modes === undefined ? {} : { modes: [...play.modes] }),
        ...(targets.length > 0 ? { targets } : {}),
      };
    }
    // An ability paid for by sacrificing something is only worth it when the thing eaten is worth
    // less than the thing fed. A bot that pumped by eating its best creature every turn would
    // play itself out of the game while passing every other test here.
    if (play.sacrificeOptions.length > 0) {
      const fodder = cheapestCreature(state, play.sacrificeOptions);
      if (fodder === null) continue;
      const self = state.instances[play.card];
      const worth = self === undefined ? 0 : characteristicsOf(state, self).power;
      if (characteristicsOf(state, state.instances[fodder]!).power >= worth) continue;
      return {
        type: 'auto:activate', by: seat, card: play.card, abilityIndex: play.abilityIndex ?? 0,
        sacrifice: fodder,
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

/**
 * Every seat the engine is waiting on.
 *
 * Usually one, because priority is held by one player at a time — but not always. Opening hands
 * are settled independently and simultaneously, and in a pod every defender declares blockers.
 * A caller that looked only at the front of the queue would never act for the others, which is
 * exactly how a bot seat ends up never keeping its hand.
 */
export function seatsToAct(state: GameState): SeatIndex[] {
  if (!state.automated || state.finished) return [];
  // Opening hands come before anything else, including priority.
  if (state.openingHands) return stillDeciding(state);
  // So does a resolution that stopped to ask a question, and a trigger waiting for its targets.
  if (state.pendingDecision !== null) return [state.pendingDecision.seat];
  if (state.pendingChoice !== null) return [state.pendingChoice.seat];
  if (state.pendingDiscard !== null) return [state.pendingDiscard.seat];
  const owed = pendingDeclaration(state);
  if (owed !== null) return [...owed.seats];
  return state.priority === null ? [] : [state.priority];
}

/** The seat at the front of that queue, for a caller that only handles one at a time. */
export function seatToAct(state: GameState): SeatIndex | null {
  return seatsToAct(state)[0] ?? null;
}
