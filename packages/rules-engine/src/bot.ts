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
import { zoneKey } from './cards.js';
import { listAt } from './cardActions.js';
import { bottomOwed, pendingDeclaration, stillDeciding } from './automation.js';
import { characteristicsOf, hasType } from './characteristics.js';
import { canAttack, canBlock } from './combat.js';
import { creaturesControlledBy } from './effects.js';
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
  state: GameState, seat: SeatIndex, ask: NonNullable<LegalActions['mustDecide']>,
): string[] {
  // Scry is neither gaining nor losing: the answer is "which of these do I not want to draw", and
  // the only thing the bot knows about wanting is mana. So it bottoms a land once it has enough
  // of them and keeps everything else, which is the one scry decision that is obviously right and
  // the one a player would make without thinking. Anything cleverer needs it to know what it is
  // holding and what it is playing against.
  if (ask.from === 'library-top') {
    const lands = listAt(state, zoneKey(seat, 'battlefield'))
      .filter((id) => /land/i.test(state.cardDefs[state.instances[id]?.defKey ?? '']?.typeLine ?? ''))
      .length;
    if (lands < 5) return [];
    return ask.candidates
      .filter((id) => /land/i.test(state.cardDefs[state.instances[id]?.defKey ?? '']?.typeLine ?? ''))
      .slice(0, ask.max);
  }
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
    // A spec can want more than one — "untap two target lands" is one spec with a count of two,
    // and sending one target for it is a play the engine refuses. The bot was doing exactly that
    // the moment a card with `count: 2` existed.
    const want = Math.max(1, spec.count ?? 1);
    for (let taken = 0; taken < want; taken++) {
      const candidates = (play.candidates[i] ?? []).filter(
        (t) => !used.has(t.kind === 'card' ? `c${t.id}` : `p${t.seat}`),
      );
      const enemyFirst = [...candidates].sort((a, b) => rank(state, b, foes) - rank(state, a, foes));
      const pick = enemyFirst[0];
      if (pick === undefined) {
        if (spec.optional) break;
        return null;
      }
      used.add(pick.kind === 'card' ? `c${pick.id}` : `p${pick.seat}`);
      chosen.push(pick);
    }
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

/** What a creature is worth to the board, crudely: how much it can do and how hard it is to kill. */
const creatureValue = (state: GameState, id: string): number => {
  const inst = state.instances[id];
  if (inst === undefined) return 0;
  const ch = characteristicsOf(state, inst);
  return ch.power + ch.toughness;
};

/** Whether `attacker` would die to `blocker` in combat, and whether it would take it with it. */
function exchange(
  state: GameState, attackerId: string, blockerId: string,
): { iDie: boolean; itDies: boolean } {
  const attacker = state.instances[attackerId];
  const blocker = state.instances[blockerId];
  if (attacker === undefined || blocker === undefined) return { iDie: false, itDies: false };
  const mine = characteristicsOf(state, attacker);
  const theirs = characteristicsOf(state, blocker);
  const deadly = (power: number, deathtouch: boolean, toughness: number) =>
    deathtouch ? power > 0 : power >= toughness;
  return {
    iDie: deadly(theirs.power, theirs.keywords.has('deathtouch'), mine.toughness)
      && !mine.keywords.has('indestructible'),
    itDies: deadly(mine.power, mine.keywords.has('deathtouch'), theirs.toughness)
      && !theirs.keywords.has('indestructible'),
  };
}

/**
 * A planeswalker this attacker could finish off this turn, or null.
 *
 * Only one it can kill: attacking a planeswalker it cannot remove gives the damage up for
 * nothing, since a player's life total is the thing that ends the game.
 */
function killableWalker(state: GameState, attackerId: string, foe: SeatIndex): string | null {
  const attacker = state.instances[attackerId];
  if (attacker === undefined) return null;
  const power = characteristicsOf(state, attacker).power;
  let best: { id: string; loyalty: number } | null = null;
  for (const id of listAt(state, zoneKey(foe, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    if (!hasType(characteristicsOf(state, inst).typeLine, 'planeswalker')) continue;
    const loyalty = inst.counters['loyalty'] ?? 0;
    if (loyalty <= 0 || loyalty > power) continue;
    if (best === null || loyalty > best.loyalty) best = { id, loyalty };
  }
  return best === null ? null : best.id;
}

/** The creatures a seat could actually block with right now: its own, untapped. */
const readyBlockers = (state: GameState, seat: SeatIndex): string[] =>
  creaturesControlledBy(state, seat).filter((id) => state.instances[id]?.tapped === false);

/**
 * Who attacks, and whom.
 *
 * Two questions, and the bot answers them separately.
 *
 * **Whom** is not a question in a duel and is the whole question in a pod: go for whoever is
 * closest to dead, and send the next creature somewhere else once the lowest player already has
 * enough coming at them to finish them. That spreads attacks across seats, which also means
 * several defenders owe a block at once.
 *
 * **Who** used to be "everything that can". That is how a bot gives away two creatures a game:
 * it ran a 1/1 into an untapped 3/3 every turn because the engine said it was allowed to. Now
 * each attacker is weighed against the blocks it could actually face:
 *
 *  - nothing can block it — attack, that is free damage;
 *  - nothing that blocks it can kill it — attack, the worst case is no damage;
 *  - it dies but takes something at least as good with it — attack, that is a trade;
 *  - it dies for nothing — stay home.
 *
 * With one exception that overrules all of it: if enough damage gets through to kill the
 * defender, everything attacks. A creature saved on the turn you could have won is a creature
 * saved for nothing, and a bot that never alpha-strikes draws out games it had already won.
 *
 * What it still does not do is hold creatures back to block. It knows what it is attacking into;
 * it does not know what is coming the other way.
 */
function chooseAttackers(state: GameState, seat: SeatIndex): { attacker: string; defender: SeatIndex }[] {
  const foes = foesOf(state, seat)
    .map((index) => ({ index, life: state.seats[index]?.life ?? 0 }))
    .sort((a, b) => a.life - b.life);
  if (foes.length === 0) return [];
  const able = legalActions(state, seat).attackers.filter((id) => canAttack(state, id, seat) === null);
  if (able.length === 0) return [];

  /**
   * Whether swinging with everything kills this player.
   *
   * Each untapped creature they have blocks one attacker, so the biggest attackers are assumed
   * blocked and the rest gets through. Pessimistic about trample and about several blockers on
   * one attacker, which is the right direction to be wrong in: it under-claims lethal rather
   * than attacking into a board that eats the team.
   */
  const lethalAgainst = (foe: { index: SeatIndex; life: number }): boolean => {
    const blockers = readyBlockers(state, foe.index).length;
    const powers = able
      .map((id) => {
        const inst = state.instances[id];
        return inst === undefined ? 0 : characteristicsOf(state, inst).power;
      })
      .sort((a, b) => b - a);
    const through = powers.slice(blockers).reduce((n, p) => n + p, 0);
    return through >= foe.life && foe.life > 0;
  };

  const worthAttacking = (attackerId: string, foe: SeatIndex): boolean => {
    const blockers = readyBlockers(state, foe)
      .filter((blockerId) => canBlock(state, blockerId, attackerId, foe) === null);
    if (blockers.length === 0) return true;
    let worstLoss = false;
    let trade = false;
    for (const blockerId of blockers) {
      const { iDie, itDies } = exchange(state, attackerId, blockerId);
      if (!iDie) continue;
      // A blocker that kills it for nothing is the reason to stay home; one that dies with it is
      // a trade, and worth it when what dies is at least as good as what is lost.
      if (!itDies) worstLoss = true;
      else if (creatureValue(state, blockerId) >= creatureValue(state, attackerId)) trade = true;
      else worstLoss = true;
    }
    return !worstLoss || trade;
  };

  const out: { attacker: string; defender: SeatIndex; planeswalker?: string }[] = [];
  let at = 0;
  let committed = 0;
  for (const attacker of able) {
    const target = foes[at] ?? foes[foes.length - 1]!;
    if (lethalAgainst(target) || worthAttacking(attacker, target.index)) {
      // A planeswalker it can kill outright is worth more than the same damage to a player on
      // forty life. Shallow on purpose — it does not ask what the planeswalker *does*, only
      // whether this creature finishes it — and a planeswalker nobody can kill is left alone
      // rather than chipped at, because chipping is how a creature dies for nothing.
      const walker = killableWalker(state, attacker, target.index);
      out.push({ attacker, defender: target.index, ...(walker === null ? {} : { planeswalker: walker }) });
      const inst = state.instances[attacker];
      committed += inst === undefined ? 0 : characteristicsOf(state, inst).power;
    }
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
 * What to block, and with what.
 *
 * A bot that chump-blocked everything would never die and never win; one that never blocked would
 * die to the first two creatures. Neither plays a game out, which is the whole point of this file.
 * So each possible blocker takes the best fight available to it:
 *
 *  - kill it and live — always worth it;
 *  - kill it and die with it — worth it when what dies is worth at least as much;
 *  - live through it — worth it, that is damage stopped for nothing;
 *  - die for nothing — only with lethal coming in, where any block is better than none.
 *
 * Between two fights it is the same kind of answer as attacking: block the biggest thing it can
 * actually handle. Picking the first legal pairing instead — which is what this did — meant a 4/4
 * eating a 1/1 while a 5/5 walked past it.
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
    let best: { attacker: string; score: number } | null = null;
    for (const attackerId of option.canBlock) {
      if (taken.has(attackerId) && !desperate) continue;
      const attacker = state.instances[attackerId];
      if (attacker === undefined) continue;
      if (canBlock(state, option.blocker, attackerId, seat) !== null) continue;
      // Menace needs two blockers, which this bot does not coordinate, so it leaves them alone.
      if (characteristicsOf(state, attacker).keywords.has('menace')) continue;
      // `exchange` reads from the first creature's side, and here the first creature really is
      // the attacker: `iDie` is the attacker dying and `itDies` is this seat's blocker dying.
      // Naming them is not pedantry — the two are a swap away from a bot that blocks its best
      // creature into death and calls it a trade.
      const { iDie: attackerDies, itDies: blockerDies } = exchange(state, attackerId, option.blocker);
      const worthIt = attackerDies
        ? (!blockerDies || creatureValue(state, attackerId) >= creatureValue(state, option.blocker))
        : !blockerDies;
      if (!worthIt && !desperate) continue;
      // Stop the biggest thing this creature can actually handle, preferring a fight it survives.
      const score = characteristicsOf(state, attacker).power
        + (attackerDies ? 10 : 0) + (blockerDies ? 0 : 5);
      if (best === null || score > best.score) best = { attacker: attackerId, score };
    }
    if (best === null) continue;
    out.push({ blocker: option.blocker, attacker: best.attacker });
    taken.add(best.attacker);
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
  if (ask !== null) return { type: 'auto:decide', by: seat, cards: decideCards(state, seat, ask) };

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
    // An X spell with X stuck at nothing is a card thrown away: a Fireball for no damage, an
    // Endless One that enters as a 0/0 and dies before anyone can look at it. Legal, and never
    // what the bot means — it was casting Endless One for zero before this line.
    if (play.xMax === 0) continue;
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
