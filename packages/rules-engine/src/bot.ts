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
import { pactProtects } from './pacts.js';
import { crewPlan, legalActions, manaSources, type LegalActions, type LegalPlay } from './legalActions.js';
import { zoneKey, type CardDef } from './cards.js';
import { listAt } from './cardActions.js';
import {
  bottomOwed, modesOf, pendingDeclaration, pendingRetarget, preferredAmount, preferredOption,
  stillDeciding,
} from './automation.js';
import { characteristicsOf, hasType, parseTypeLine, type Keyword } from './characteristics.js';
import {
  attackAimIssue, canAttack, canBlock, damageOrdersOwed, forcedAttackers, legalAttackers,
  legalDefenders,
} from './combat.js';
import { creaturesControlledBy, poolOf } from './effects.js';
import { applyAction } from './engine.js';
import { canAfford, costValue, parseManaCost, type ManaCost } from './mana.js';
import { scriptFor } from './scripts.js';
import { isNumberDecision } from './scriptTypes.js';
import { targetKey, type Target } from './turnTypes.js';
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
/**
 * The whole answer to an outstanding question, cards or word.
 *
 * One function for the two places that answer one, because they were two copies of the same line
 * and a question whose answer is a *word* would otherwise have been handled in one of them.
 */
function decideAction(
  state: GameState, seat: SeatIndex, ask: NonNullable<LegalActions['mustDecide']>,
): Action {
  // A word is answered by the card that asked, which is the only thing that knows what its own
  // options mean. See `ChoiceDecisionSpec.best`.
  if (ask.options !== undefined) {
    return {
      type: 'auto:decide', by: seat, cards: [],
      option: preferredOption(state) ?? ask.options[0] ?? '',
    };
  }
  // And a number by the card that asked, for the same reason: only Toxic Deluge knows that its
  // number is life worth spending. See `NumberDecisionSpec.best`.
  if (ask.numbers !== undefined) {
    return {
      type: 'auto:decide', by: seat, cards: [],
      amount: preferredAmount(state) ?? ask.numbers.min,
    };
  }
  // And where a copy should point, which no card can answer: the card being copied is not the card
  // asking. See `newTargetFor`.
  if (ask.targetChoices !== undefined) {
    const picked = newTargetFor(state, seat, ask.targetChoices);
    return {
      type: 'auto:decide', by: seat, cards: [],
      ...(picked === undefined ? {} : { target: picked }),
    };
  }
  return { type: 'auto:decide', by: seat, cards: decideCards(state, seat, ask) };
}

/**
 * Where the bot points a copy, and when it leaves the copy where it was.
 *
 * The same ranking a cast uses — enemies and enemy creatures first, or my own side for a spec the
 * card marked `friendly` — because it is the same question with the same blind spot: the bot does
 * not know what the spell *does*, and the card's own hint is the thing that stops it pointing a
 * copied prevention shield at the player it is attacking.
 *
 * **Declining when the best answer is the one it already has** is not a tidiness: a copy of my own
 * Lightning Bolt is already aimed at the opponent, and re-choosing the same target is a legal
 * answer that reads, in the log and on the stack, as though the bot changed its mind and did not.
 * The interesting case is the other one — a copy of *their* removal spell, which arrives pointed at
 * my own creature and is worth a card only once it is pointed back, which is what it does.
 *
 * **One case it gets wrong, and knowingly.** A copied Gravedigger trigger has both corpses in the
 * bot's *own* graveyard, so the ranking sees two of its own cards, ties, and declines — and then
 * the copy returns the card and the original is countered for pointing at an object that has
 * changed zones, which is one creature back instead of two. Answering that needs "would declining
 * make the original fizzle", which is a question about what the copied effect *does* and cannot be
 * read off the board: the pool's other copy card is the one the measurement is about, and there
 * the answer is right. A person answering the question gets both creatures, which the tests show.
 */
function newTargetFor(
  state: GameState, seat: SeatIndex, choices: readonly Target[],
): Target | undefined {
  const aiming = pendingRetarget(state);
  const foes = foesOf(state, seat);
  const score = aiming?.friendly === true
    ? (t: Target): number => friendlyRank(state, t, foes)
    : (t: Target): number => rank(state, t, foes);
  const best = [...choices].sort((a, b) => score(b) - score(a))[0];
  if (best === undefined) return undefined;
  const current = aiming?.current;
  // A tie goes to leaving it alone, which is why this is `<=` rather than `<`.
  if (current !== undefined && score(best) <= score(current)) return undefined;
  return best;
}

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
  /*
    "Choose any creature on the battlefield", which is a different question from every other one
    here: the answer is not a card to keep or discard but a creature to *become*, so it is judged
    the way the search judges a creature — body plus keywords — rather than by mana value. A Clone
    copying the biggest thing on the table is also the whole reason the card is good.
  */
  if (ask.from === 'any-battlefield') {
    return [...ask.candidates]
      .sort((a, b) => creatureValue(state, b) - creatureValue(state, a))
      .slice(0, Math.max(ask.min, Math.min(1, ask.max)));
  }
  const gaining = ask.from === 'library' || ask.from === 'graveyard';
  const ranked = [...ask.candidates].sort((a, b) => cardWorth(state, b) - cardWorth(state, a));
  const take = gaining ? ask.max : ask.min;
  const order = gaining ? ranked : ranked.reverse();
  /*
    And a madness card goes first when cards are being given up rather than gained.

    Ahead of the ordinary order rather than inside it, because that order is about mana value and
    this is about the card not being lost at all — see `madnessToPitch` for the 41 discards made
    out of a hand holding one, and none of them it.
  */
  if (!gaining) {
    const pitch = madnessToPitch(state, seat, order);
    if (pitch !== null) return [pitch, ...order.filter((id) => id !== pitch)].slice(0, take);
  }
  return order.slice(0, take);
}

/**
 * A card in this hand that would rather be **discarded**: a madness card whose cost is payable now.
 *
 * Not a discard at all, which is the whole of the rule. A Fiery Temper pitched to a Faithless
 * Looting with a Mountain untapped is a Lightning Bolt for {R}; the same card kept in hand is a
 * three-mana sorcery that may never be cast. So when the bot owes a discard it gives up that card
 * first, ahead of whatever its ordinary policy would have chosen.
 *
 * **Measured before it was written**, which is the discipline this project keeps for bot rules.
 * `offers.mjs` over 96 games of Ashen Rite: 281 real discards, **none** of them a madness card, and
 * **41** of them made out of a hand that was holding one. The keyword had never once fired in a
 * real game — not because the engine was wrong but because the discard policies rank by mana value,
 * and a three-mana sorcery is neither the cheapest card in a hand nor the dearest.
 *
 * Affordability is asked, because the rule is only right when the cast follows: a Temper discarded
 * with no red mana up is a card in a graveyard, and giving it up ahead of a land would then be
 * strictly worse than the policy it replaced. It is the same question `settleOffer` asks when it
 * decides whether to stop the table at all, through the same solver.
 */
function madnessToPitch(
  state: GameState, seat: SeatIndex, candidates: readonly string[],
): string | null {
  for (const id of candidates) {
    const name = state.cardDefs[state.instances[id]?.defKey ?? '']?.name;
    const madness = scriptFor(name)?.madness;
    if (madness === undefined) continue;
    const cost = parseManaCost(madness.cost);
    if (cost.unsupported !== undefined) continue;
    if (canAfford(poolOf(state, seat), cost, manaSources(state, seat))) return id;
  }
  return null;
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
 * wasteful. Fixing that in general needs the bot to read the script's intent, which is a different
 * piece of work; what matters here is that every choice comes from the candidate list the engine
 * produced, so a bad choice is still a legal one.
 *
 * The exception is a spec the card marks `friendly`, which is the one case where the default is not
 * merely wasteful but the whole cost of the card: a prevention shield aimed at an opponent prevents
 * the damage *you* were about to deal. Those are aimed the other way round — see `friendlyRank`.
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
        (t) => !used.has(targetKey(t)),
      );
      const score = spec.friendly === true
        ? (t: Target): number => friendlyRank(state, t, foes)
        : (t: Target): number => rank(state, t, foes);
      const bestFirst = [...candidates].sort((a, b) => score(b) - score(a));
      const pick = bestFirst[0];
      if (pick === undefined) {
        if (spec.optional) break;
        return null;
      }
      used.add(targetKey(pick));
      chosen.push(pick);
    }
  }
  return chosen;
}

/**
 * Whether a creature has text of its own: a trigger, an activated ability, or a static.
 *
 * The question behind it is "is this a card or is it a body". A Blood Artist is 0/1 and the whole
 * engine of its deck; a Centaur Courser is 3/3 and a body. Power cannot tell them apart and that
 * is exactly the mistake the fodder rule below was making.
 */
function hasOwnText(state: GameState, id: string): boolean {
  const script = scriptFor(state.cardDefs[state.instances[id]?.defKey ?? '']?.name);
  if (script === undefined) return false;
  return (script.triggers?.length ?? 0) > 0 || (script.abilities?.length ?? 0) > 0
    || (script.statics?.length ?? 0) > 0;
}

/**
 * The least valuable of a set of creatures, for feeding to something hungry.
 *
 * **Three ranks before power, because power is a bad measure of what a creature is worth to its
 * own deck.** A token is not a card and costs nothing to lose; a creature with no text is a body;
 * a creature with text is the deck's plan. Ashen Rite made the point: a Woe Strider offered its
 * `{0}` outlet a 0/1 Blood Artist and a 0/1 Goat and the old ordering could not tell them apart,
 * so it ate whichever came first in the list — which over 144 games meant eating the three cards
 * the rest of the deck is built around.
 */
function cheapestCreature(state: GameState, ids: readonly string[]): string | null {
  let best: { id: string; rank: number; power: number } | null = null;
  for (const id of ids) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const power = characteristicsOf(state, inst).power;
    const rank = inst.isToken ? 0 : hasOwnText(state, id) ? 2 : 1;
    if (best === null || rank < best.rank || (rank === best.rank && power < best.power)) {
      best = { id, rank, power };
    }
  }
  return best?.id ?? null;
}

/**
 * The other way round, for a spec the card marks `friendly`: my own side only.
 *
 * **Me before my creatures**, which is a judgement rather than an obvious ordering. A shield on a
 * blocker can save a creature; a shield on me only saves life. But the bot is offered these in a
 * combat it is being attacked in, where some of the damage is usually unblocked and coming at a
 * life total — and life is the thing that loses games, while the creature is replaceable. A seat
 * that could work out which of the two is better in *this* combat would be a better player than
 * this bot is anywhere else.
 */
function friendlyRank(state: GameState, target: Target, foes: readonly SeatIndex[]): number {
  if (target.kind === 'player') return foes.includes(target.seat) ? -100 : 100;
  // Nothing in the pool points a *friendly* spec at an ability on the stack, and if something ever
  // does, last place is the right answer until somebody measures a better one.
  if (target.kind === 'ability') return -100;
  const inst = state.instances[target.id];
  if (inst === undefined) return -100;
  if (foes.includes(inst.zoneSeat)) return -50;
  return 50 + creatureValue(state, target.id);
}

/** Enemy players score highest, then enemy creatures by size, then anything else. */
function rank(state: GameState, target: Target, foes: readonly SeatIndex[]): number {
  if (target.kind === 'player') return foes.includes(target.seat) ? 100 : -100;
  /*
    An ability on the stack: whose it is decides, and it ranks just under a spell.

    45 against the 50 an opponent's spell gets, which only matters for a Disallow looking at both
    at once — and countering the spell is the better half of that choice nearly every time, because
    the spell is usually the reason the ability exists. Its own controller's ability ranks below
    everything, which is what keeps the bot from pointing a counterspell at its own trigger when
    that is the only object on the stack.
  */
  if (target.kind === 'ability') {
    const object = state.stackObjects[target.id];
    if (object === undefined) return -100;
    return foes.includes(object.controller) ? 45 : -60;
  }
  const inst = state.instances[target.id];
  if (inst === undefined) return -100;
  const mine = !foes.includes(inst.zoneSeat);
  const size = characteristicsOf(state, inst).power;
  return mine ? -50 + size : 50 + size;
}

/** What a creature is worth to the board, crudely: how much it can do and how hard it is to kill. */
/**
 * What a keyword is worth on top of a body, in the same units as power and toughness.
 *
 * A 2/2 flier is not a 2/2: it gets through, and the 2/2 opposite it cannot stop it. The numbers
 * are small and deliberately so — this is the difference between two creatures of the same size,
 * not between a creature and a spell — and they are read by the *combat* heuristics as well as by
 * the evaluation, so a deathtouch blocker is correctly worth more than its body when the bot is
 * deciding whether a trade is good.
 */
const KEYWORD_VALUE: Readonly<Partial<Record<Keyword, number>>> = {
  flying: 1.5,
  deathtouch: 1.5,
  indestructible: 2,
  'double strike': 1.5,
  'first strike': 0.75,
  lifelink: 0.5,
  trample: 0.5,
  menace: 0.5,
  vigilance: 0.5,
  hexproof: 1,
  reach: 0.25,
};

const creatureValue = (state: GameState, id: string): number => {
  const inst = state.instances[id];
  if (inst === undefined) return 0;
  const ch = characteristicsOf(state, inst);
  let value = ch.power + ch.toughness;
  for (const keyword of ch.keywords) value += KEYWORD_VALUE[keyword] ?? 0;
  return value;
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
 *  - nothing can block it — attack, that is offered damage;
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
/**
 * Which opponent to go at first: the monarch, then whoever is closest to dying (CR 720).
 *
 * The crown ahead of the life total, and it is a **fact about the board** rather than a weight —
 * the player holding it draws an extra card at the beginning of every one of their own end steps,
 * and the only way to stop that is to deal them combat damage, which also hands the crown to you.
 * So "attack the monarch" is not a preference the search has to be talked into; it is the one
 * attack that does something no other attack can.
 *
 * In a duel it changes nothing, because there is one player to attack. It exists for the pod, and
 * `scripts/measure/pod-duel.mjs` is the instrument that can say whether it is worth having.
 */
function foeOrder(
  state: GameState, seat: SeatIndex, chase = true,
): { index: SeatIndex; life: number }[] {
  return foesOf(state, seat)
    .map((index) => ({ index, life: state.seats[index]?.life ?? 0 }))
    .sort((a, b) => {
      if (chase && state.monarch !== null) {
        if (a.index === state.monarch && b.index !== state.monarch) return -1;
        if (b.index === state.monarch && a.index !== state.monarch) return 1;
      }
      return a.life - b.life;
    });
}

function chooseAttackers(
  state: GameState, seat: SeatIndex, opts: BotOptions = {},
): { attacker: string; defender: SeatIndex }[] {
  const foes = foeOrder(state, seat, opts.chaseTheCrown !== false);
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

// ── Looking one move ahead ───────────────────────────────────────────────────────────────────────

/*
  What the bot wants, in one number.

  Weights are not a theory of Magic; they are the shortest list that produces recognisable play,
  and each one is set by what changed when it was wrong:

   - a creature is worth its power plus its toughness, which is the same measure the blocking
     logic already uses to decide a trade;
   - a point of life is worth about a quarter of a 2/2, because board takes life and life does not
     take board — but not nothing, or the bot races into lethal;
   - **a land in play is worth more than a card in hand**, because it is the card that makes every
     other card castable. This one was not a preference: with a card in hand worth more, a land
     drop *lowers* the score, so the bot stopped playing lands and lost 60 games out of 60 in the
     measurement while looking like a tuning problem. The land drop is now taken as a rule before
     the search runs, and the weights still have to agree with it.
*/
const LIFE_WEIGHT = 1.0;
const CARD_IN_HAND = 1.5;
/**
 * A card still in a library, which is the second way a game of Magic ends.
 *
 * 0.3 rather than a round number, chosen so that the cards in the pool land where they should: a
 * Tome Scour (five) is worth about a card out of a hand, a Mind Sculpt (seven) a little more, and
 * a sixty-card library eighteen points against a twenty-life total of twenty — "there are two
 * clocks and they run at about the same speed", which is the thing the evaluation has to believe
 * for either of them to be played towards.
 *
 * Linear rather than "only the last ten matter", which was the first shape and the wrong one.
 * Under it a mill spell cast at a forty-card library scores zero, so the bot would never cast one
 * until the library was nearly gone — and a deck that cannot start its plan never finishes it.
 * Linear means every mill is progress, which is how the deck is actually played.
 *
 * It values the bot's own library too, and that is correct rather than a side effect: drawing is
 * still worth taking (a card in hand is worth five in the library), self-mill is a real cost, and
 * a seat on three cards is in trouble the search can now see.
 */
const LIBRARY_CARD = 0.3;
/*
  An answer in hand priced above a generic card: measured, and worth nothing.

  The diagnostic in D69 found the one thing this search demonstrably gets wrong: over sixty games
  it never once declined to counter a spell it could pay for, because by this evaluation countering
  anything is a gain while the counterspell in hand is priced as any other card — so spending it is
  nearly offered, and Counterspells go on Rampant Growths.

  Pricing an answer above a generic card is the cheapest way to say "do not spend this on nothing".
  It did not work. Eighty-four paired games per value, the same seeds and pairings as D68:

  | answer in hand | control decks | counterspells cast |
  | --- | --- | --- |
  | 1.5 (as any card) | 23-61 | 75 |
  | 2.5 | 22-62 | 82 |
  | 3.5 | 21-63 | 83 |
  | 5.0 | 21-63 | 83 |

  Note the direction of the second column: valuing the answer *more* made it cast **more**
  counterspells, not fewer. Holding answers made its hands bigger and its games longer, and more
  counters were spent across the extra turns — the term changed how long it lived, not what it
  spent the answer on.

  **The conclusion is about the shape of the evaluation rather than any weight in it.** A sum of
  material cannot express "this card is worth more later than now": the sum is the same whether the
  card is spent well or badly, and every weight that makes holding it attractive also makes doing
  nothing attractive. Four ideas have now been measured against this ceiling and all four were
  deleted — a second ply (D62), a swing projection (D62), untapped mana (D68) and this. What would
  actually move it is knowledge of a kind the evaluation has no place for: which of the opponent's
  spells is the one that beats you.
*/
/*
  Unblocked power — the fifth term measured against this evaluation's ceiling, and the fifth deleted.

  The idea was the one thing a sum of material structurally cannot say. Every weight here is a fact
  about a *card*: `flying: 1.5` is worth the same against five ground creatures as against five
  fliers, when in the first case the 2/2 flier is a two-a-turn clock and in the second it is a 2/2.
  So the term asked the board instead — for each creature that could attack, is there anything
  opposite that could legally block it (`canBlock`, so one answer rather than a second opinion) —
  and added that power to the side it belonged to. Counted only when the opponent *had* blockers
  that could not do the job, because a creature unblocked by an empty board is already described by
  the power on the board.

  Bot against bot, both seats, every deck pairing, identical seeds. The negative control first:
  identical bots scored **56-56 of 112**, so the paired design has no seat or matchup bias at all
  and anything that moves is the term.

  | a point of unblocked power | record over 336 games |
  | --- | --- |
  | 0.5 | 165-171 |
  | 1.0 | 161-175 |
  | 2.0 | 158-178 |

  Monotone, and against. The first version counted tapped and summoning-sick creatures as pressure,
  which is a real flaw and not the reason: gating it on `canAttack` moved 0.5 to 164-172 and 1.0 to
  162-174 — the same answer.

  **Then the search was fixed and the answer changed, which is the part worth reading.** Those games
  were played when the search scored whatever position auto-pass had carried the table to — half of
  all attack declarations *after the turn had ended* (D117). Asked again on a search that stops
  where its action happened, the same term measures 170-166 at 0.5 and 168-168 at 1.0: **level, not
  losing.** So the term is not harmful and never was; the drift was making it harmful, and D116's
  "the hypothesis was wrong" was too strong a conclusion from a broken instrument.

  It stays deleted anyway, because level is level: a term that cannot be priced is a scan of both
  boards on every evaluation for nothing. What it bought was the correction above and the one that
  follows from it — four of the five deleted terms (a second ply and a swing projection in D62,
  untapped mana in D68, and this) are statements about what happens *next*, and all four were
  measured against a position that had already gone past them. Three of the four are now worth
  re-asking, which is a better place to be than five deletions and no explanation.
*/
const LAND_ON_BOARD = 2.5;
const PERMANENT_ON_BOARD = 3;
/*
  Mana left untapped is worth nothing, measured.

  A land is worth `LAND_ON_BOARD` whether it is tapped or not, so spending mana costs this
  evaluation nothing and the bot taps out every turn — and is then holding a counterspell with no
  mana when the spell worth answering arrives. That reads like the obvious hole, and it was built:
  a little for each untapped land, but only while the hand held something castable at instant
  speed, and capped at the cheapest such card's cost.

  **It lost games at every weight that changed anything.** Eighty-four paired games per weight on
  the same seeds, the two control decks against the three that beat them fastest plus the control
  mirror:

  | mana-up weight | control decks | counterspells cast |
  | --- | --- | --- |
  | 0 (none) | 23-61 | 75 |
  | 0.5 | 23-61 | 80 |
  | 1.0 | 20-64 | 79 |
  | 2.0 | 18-66 | 78 |

  Monotone: the more mana it held, the fewer games it won. So the term is gone.

  **That reading was wrong, and the numbers above are why it was recoverable.** Those games were
  played when the search scored whatever position auto-pass had carried the table to, which for a
  term about *the rest of this turn* is close to the worst possible instrument — mana pools empty
  when a step ends, so a term about mana held was being read in a position where it could no longer
  mean anything (D117). Asked again on a search that stops where its action happened, and on the
  paired bot-against-bot instrument rather than the narrow field above: **171-165 at 0.5, 171-165 at
  1.0, 169-167 at 2.0, and 167-169 on a second seed set.** Level, not monotone-against. See D119.

  It stays gone, because level is level and it costs a scan of the hand on every evaluation. But
  what stays with it is the corrected lesson rather than the original one: this is not "the board
  bought with the mana is worth more than the answer kept for it" — that was never measured. It is
  "holding mana is worth nothing to a bot that cannot plan a turn ahead", which is a smaller claim
  and the one the numbers support.

  The same measurement corrected the premise, which is the part worth keeping. **Every counterspell
  the bot casts is already cast in response** — 75 of 75 with the term off, 80 of 80 at 0.5 — and
  it could not be otherwise: a counterspell targets a spell on the stack, so with an empty stack it
  has no legal target and `legalActions` never offers it. The handicap was never *when* it counters.
  It is that it is often tapped out when the moment comes, and valuing untapped mana does not fix
  that, because what the mana bought instead was worth more.
*/

/*
  Evasion priced against the board in front of it: built, measured, and gone.

  `KEYWORD_VALUE` above prices flying at 1.5 whatever is opposite it, and that is two different
  cards: a 2/2 flier against a board with no flying and no reach is an unanswerable clock, and the
  same 2/2 against two Giant Spiders is a 2/2. No term here could tell those boards apart, which is
  the first thing a person reads off a battlefield — so it was worth asking.

  The term: a creature with flying whose controller's opponents have nothing with flying or reach,
  or one that simply cannot be blocked, is worth **its power again** times a weight. Asked once per
  `seatValue` rather than once per creature, so the extra work is one scan of the opponents'
  battlefields rather than one per creature of yours.

  **Level at every weight that changes anything**, on the paired bot-against-bot instrument, 936
  games a run with thirteen decks in both seats:

  | weight | seeds 3300 | seeds 8800 |
  | --- | --- | --- |
  | 0.5 | 467-469 | 470-464 |
  | 1.0 | 471-465 | — |
  | 2.0 | 468-468 | — |

  The negative control — the same bot in both arms — is exactly 468-468, which is what makes those
  three rows readable as level rather than arguable. And `disagree.mjs` says the term did change
  decisions, so this is a genuine wash rather than a setting that never fired: **83 of 30,176
  decisions differed**, 51 of them casts.

  It also costs time. Identical arms on the same seeds, which is the clean comparison: **157s with
  the term off and 169s with it on**, about 8% for nothing.

  So the term is gone, and the lesson it leaves is narrower than the idea that motivated it: *the
  bot's attacks and blocks already ask whether a creature can be blocked* — `canBlock` knows, and
  the combat heuristics read it. What the evaluation was being asked to add was a judgement about
  the **next** few turns, and a bot that cannot plan a turn ahead has nothing to do with it. The
  same shape of answer the mana-up term got, for the same underlying reason.
*/

/** Everything one seat has, from that seat's point of view. */
function seatValue(state: GameState, seat: SeatIndex): number {
  let total = (state.seats[seat]?.life ?? 0) * LIFE_WEIGHT;
  total += (state.zones[`${seat}:hand`] ?? []).length * CARD_IN_HAND;
  total += (state.zones[`${seat}:library`] ?? []).length * LIBRARY_CARD;
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const ch = characteristicsOf(state, inst);
    if (ch.isLand) total += LAND_ON_BOARD;
    else if (ch.isCreature) total += creatureValue(state, id);
    // A planeswalker's loyalty is its life *and* its spell-per-turn, so a counter on one is worth
    // about what a point of life is worth. Without this the search could not see what a plus
    // ability bought and stopped using them — three activations across sixteen games, where the
    // bot it replaced managed more than one per planeswalker it cast.
    else total += PERMANENT_ON_BOARD + (inst.counters['loyalty'] ?? 0) * LIFE_WEIGHT;
  }
  return total;
}

/**
 * How much this seat likes a position.
 *
 * Its own side, less the average opponent — the average rather than the sum, so a four-player pod
 * is scored on "am I ahead of the table" instead of on "is the rest of the table small", which
 * would have the bot ignore the player about to kill it in favour of the two who are behind.
 *
 * **Divided by the seats the table started with, not by the ones still alive.** That one word is
 * the difference between a pod that ends and a pod that does not. Dividing by the living opponents
 * means killing one *raises* the average of those left, so eliminating the weakest player scored
 * worse than doing nothing at all — and the bot duly declined. Measured on a real position: a seat
 * with 462 ready goblins, three opponents on 3, 6 and 1 life, and the alpha strike that kills one
 * of them outright scoring **1875.0 against 1877.3 for attacking with nothing**. It attacked with
 * nothing, every turn, for twenty turns, while Krenko doubled its board to nine hundred creatures
 * and every decision in the game got slower.
 *
 * A fixed denominator keeps the intent exactly — still "am I ahead of the table", still immune to
 * the sum's bias towards whoever is behind — and makes an elimination what it is: the average
 * opponent gets smaller because one of them is gone. In a two-player game the two readings are the
 * same number, which is why none of the duel measurements in this file move.
 */
export function evaluate(state: GameState, seat: SeatIndex): number {
  if (state.finished) return state.winnerSeat === seat ? 1e6 : -1e6;
  if (state.seats[seat]?.eliminated === true) return -1e6;
  let theirs = 0;
  for (const foe of foesOf(state, seat)) theirs += seatValue(state, foe);
  return seatValue(state, seat) - theirs / Math.max(1, state.seats.length - 1);
}

/**
 * Plays one action out far enough to be worth looking at.
 *
 * "Far enough" is: take the action, then let everything on the stack resolve with nobody
 * responding. That is the line the bot is actually choosing between — a spell it casts into an
 * empty stack on its own turn usually resolves — and it is the cheapest simulation that shows what
 * a card *does* rather than what it costs.
 *
 * Returns null when the action is refused, which should not happen: every action here was built
 * from `legalActions`. Swallowed rather than thrown because a search is not the place to discover
 * it — `playout.test.ts` is, and it asserts exactly that the engine never refuses what it offered.
 */
/**
 * The same state with nobody auto-passing, so a simulated action stops where it happened.
 *
 * `applyAction` runs the engine's auto-pass loop, and with it on the position that comes back can
 * be a step — or a whole turn — past the action it was about. Measured over 10,000 actions in real
 * games: **only 51% of casts leave the table on the same step, 19% advance a turn, and half of all
 * attack declarations are scored after the turn has already moved on.** That is the mechanism
 * behind four deleted evaluation terms (D116): a term about this swing, or about the mana kept for
 * this turn, read at a moment that has gone past it.
 *
 * Switched off inside the search only. The simulated state is scored and thrown away — it is never
 * applied to the real table — so this changes what the bot *sees*, never how the game runs.
 */
const noAutoPass = (state: GameState): GameState => ({
  ...state,
  autoPassOff: state.seats.map((seat) => seat.index),
});

function simulate(state: GameState, action: Action, stopAtAction: boolean): GameState | null {
  let next: GameState;
  try {
    next = applyAction(stopAtAction ? noAutoPass(state) : state, action, HOST);
  } catch {
    return null;
  }
  for (let i = 0; i < 12; i += 1) {
    if (next.stackOrder.length === 0 && answerPending(next) === null) break;
    const answer = answerPending(next);
    if (answer !== null) {
      try {
        next = applyAction(next, answer, HOST);
      } catch {
        break;
      }
      continue;
    }
    if (next.priority === null) break;
    try {
      next = applyAction(next, { type: 'auto:pass', by: next.priority }, HOST);
    } catch {
      break;
    }
  }
  return next;
}

/**
 * The X for a card whose X is a number to match rather than an amount of effect.
 *
 * Every other X spell here is cast for as much as the mana allows, and the search sees what that
 * buys — a Hurricane for six is six damage. A Chalice of the Void is the opposite: X is the mana
 * value it then answers, so a Chalice for four is a blank and a Chalice for one is a wall in front
 * of the fastest deck in the pool. The search cannot tell them apart, because the board after the
 * cast is an artifact with some counters on it either way and what the number is *worth* is a fact
 * about the cards in somebody else's hand.
 *
 * So it is chosen from what the opponents have **shown**: the mana values of every nonland card in
 * their graveyards and on their battlefields, the commonest of them winning, the smaller number
 * winning a tie, and one when they have shown nothing at all. A person does the same thing by eye
 * — "they are playing one-drops, so it goes on one" — and it reads only public zones, so it is not
 * the bot peeking at a hand (which `claude/decisions-log.md`, D110, is about).
 *
 * Mana value **nought** is skipped. A Chalice on zero counters a Tormod's Crypt and nothing else
 * anybody casts, and lands are left out for the same reason: they are played, not cast.
 */
function xToMatch(state: GameState, seat: SeatIndex, xMax: number): number {
  const shown = new Map<number, number>();
  for (const foe of foesOf(state, seat)) {
    for (const zone of ['graveyard', 'battlefield'] as const) {
      for (const id of listAt(state, zoneKey(foe, zone))) {
        const def = state.cardDefs[state.instances[id]?.defKey ?? ''];
        if (def === undefined || hasType(parseTypeLine(def.typeLine), 'land')) continue;
        const mv = costValue(parseManaCost(def.manaCost));
        if (mv === 0 || mv > xMax) continue;
        shown.set(mv, (shown.get(mv) ?? 0) + 1);
      }
    }
  }
  let best = 0;
  let bestSeen = 0;
  for (const mv of [...shown.keys()].sort((a, b) => a - b)) {
    const seen = shown.get(mv) ?? 0;
    if (seen > bestSeen) {
      best = mv;
      bestSeen = seen;
    }
  }
  // One when nothing has been shown, which is where a person starts and where the cheap spells are.
  return Math.max(1, Math.min(best === 0 ? 1 : best, xMax));
}

/** How many ways of aiming one spell are worth simulating. */
const AIM_WIDTH = 4;

/**
 * One way of aiming a play: what it points at, and how a divided quantity is spent on those
 * targets when the card divides one (CR 601.2d).
 *
 * The two travel together because they are announced together and are legal or illegal together:
 * a division is about a list of targets, and a target list for a dividing spell is not a play the
 * engine accepts without one.
 */
interface Aiming {
  readonly targets: readonly Target[];
  readonly division?: readonly number[];
}

/**
 * The ways this play could be aimed, best-first, at most `AIM_WIDTH` of them.
 *
 * Only the *first* target of a spell is varied. Which creature a Doom Blade kills is the choice
 * that decides whether the card was worth playing; the second target of a two-target spell almost
 * never is, and varying both would multiply the search for nothing.
 *
 * **Two orderings, not one, which is the fix for a measured bug.** The alternatives used to be the
 * top of the enemy-first ranking alone — and with three enemy creatures on the board, the top of
 * that ranking *is* three enemy creatures, so the bot's own side was never offered at all. A Giant
 * Growth on an opposing creature is a card given away, and the search would have rejected it
 * instantly if it had been shown the other aim: pumping their creature raises their side of the
 * evaluation and lowers its own. Measured over 60 duels, three such casts; the search could not
 * choose a target it was never handed.
 *
 * So the list is the best two by the enemy ordering and the best one by the own-side ordering
 * (`friendlyRank`), in that order after the heuristic's own pick — which is also why `AIM_WIDTH` is
 * four rather than three. The order matters because the options are compared with `>`, so an aim
 * that scores identically to an earlier one loses: the heuristic's pick stays the tie-break, and a
 * card that cannot tell its aims apart keeps the one the card's own `friendly` hint chose.
 */
function aimings(state: GameState, seat: SeatIndex, play: LegalPlay): Aiming[] {
  const spec = play.targetSpecs[0];
  if (spec?.divided !== undefined) return dividedAimings(state, seat, play, spec.divided);
  const first = chooseTargets(state, seat, play);
  if (first === null) return [];
  if (first.length === 0) return [{ targets: [] }];
  const foes = foesOf(state, seat);
  const candidates = play.candidates[0] ?? [];
  const byEnemy = [...candidates].sort((a, b) => rank(state, b, foes) - rank(state, a, foes));
  const byOwnSide = [...candidates]
    .sort((a, b) => friendlyRank(state, b, foes) - friendlyRank(state, a, foes));
  const alternatives = [byEnemy[0], byEnemy[1], byOwnSide[0]];
  const out: Aiming[] = [{ targets: first }];
  const seen = new Set([targetKey(first[0]!)]);
  // One spec wanting several targets is left alone: the heuristic filled all of them, and swapping
  // one out would need the rest re-picked around it.
  if (spec !== undefined && Math.max(1, spec.count ?? 1) === 1) {
    for (const option of alternatives) {
      if (option === undefined || seen.has(targetKey(option))) continue;
      const rest = first.slice(1);
      if (rest.some((t) => targetKey(t) === targetKey(option))) continue;
      seen.add(targetKey(option));
      out.push({ targets: [option, ...rest] });
    }
  }
  return out.slice(0, AIM_WIDTH);
}

/** What it would take to kill a creature right now, or null for one damage cannot kill. */
function lethalFor(state: GameState, id: string): number | null {
  const inst = state.instances[id];
  if (inst === undefined) return null;
  const ch = characteristicsOf(state, inst);
  if (!ch.isCreature || ch.keywords.has('indestructible')) return null;
  return Math.max(1, ch.toughness - inst.damage);
}

/**
 * The ways a divided quantity could be spent (CR 601.2d), for the search to price.
 *
 * Three options rather than a judgement, and that is the point: how to split three damage is
 * exactly the kind of question this bot has no business answering with a weight. One of them is
 * always right and which one depends on the board — kill the two X/1s, or put all three into the
 * face for the last three life — and `simulate` already scores boards. So each option is built
 * from a *fact* and handed over:
 *
 * - **All of it on one thing**, the best target by the enemy-first ranking. The Lava Spike aim.
 * - **Lethal first**: walk the opponents' creatures best-first, assign each exactly what it takes
 *   to kill it while the budget lasts, and put whatever is left on the best remaining target. This
 *   is the aim the card is printed for and the one a heuristic would miss, because it is worth
 *   less by every "biggest target" measure and kills two creatures.
 * - **One each**, spread as wide as the card allows. The answer to a board of X/1s, and different
 *   from lethal-first whenever a creature needs more than one.
 *
 * Identical options are dropped, so a board with one legal target produces one aiming rather than
 * three copies of the same one.
 */
function dividedAimings(
  state: GameState, seat: SeatIndex, play: LegalPlay, amount: number,
): Aiming[] {
  const spec = play.targetSpecs[0];
  const most = Math.min(Math.max(1, spec?.count ?? 1), amount);
  const foes = foesOf(state, seat);
  const ranked = [...(play.candidates[0] ?? [])]
    .sort((a, b) => rank(state, b, foes) - rank(state, a, foes));
  const best = ranked[0];
  if (best === undefined) return [];

  const out: Aiming[] = [];
  const add = (targets: readonly Target[], division: readonly number[]): void => {
    if (targets.length === 0 || division.reduce((n, d) => n + d, 0) !== amount) return;
    const key = targets.map((t, i) => `${targetKey(t)}:${division[i]}`).join('|');
    if (out.some((a) => a.targets.map((t, i) => `${targetKey(t)}:${a.division?.[i]}`).join('|') === key)) return;
    out.push({ targets, division });
  };

  add([best], [amount]);

  // Lethal first. Only an opponent's creature is worth exact change: spending two damage to kill
  // one of its own would be paying for the privilege.
  const kills: { target: Target; cost: number }[] = [];
  let budget = amount;
  for (const candidate of ranked) {
    if (kills.length >= most || budget <= 0) break;
    if (candidate.kind !== 'card') continue;
    const inst = state.instances[candidate.id];
    if (inst === undefined || !foes.includes(inst.zoneSeat)) continue;
    const needed = lethalFor(state, candidate.id);
    if (needed === null || needed > budget) continue;
    kills.push({ target: candidate, cost: needed });
    budget -= needed;
  }
  if (kills.length > 0) {
    const targets = kills.map((k) => k.target);
    const division = kills.map((k) => k.cost);
    if (budget > 0) {
      // The change goes on the best target that is not already taken, or onto the last creature
      // killed when there is nowhere else — overkill is legal and beats leaving it unassigned,
      // which is not.
      const spare = ranked.find(
        (t) => !targets.some((taken) => targetKey(taken) === targetKey(t)),
      );
      if (spare !== undefined && targets.length < most) {
        add([...targets, spare], [...division, budget]);
      } else {
        add(targets, [...division.slice(0, -1), (division[division.length - 1] ?? 0) + budget]);
      }
    } else {
      add(targets, division);
    }
  }

  // One each, as wide as it goes. The last share takes the remainder so the whole amount is spent.
  const wide = ranked.slice(0, most);
  if (wide.length > 1) {
    add(wide, wide.map((_, i) => (i === wide.length - 1 ? amount - (wide.length - 1) : 1)));
  }
  return out.slice(0, AIM_WIDTH);
}

/** How many plays are worth simulating, best-first by the shallow ranking. */
const PLAY_WIDTH = 8;

/**
 * Every action the bot could take right now, best-first by the old heuristic.
 *
 * The judgements that used to decide *the* play live here now and decide whether an option is
 * offered at all: an X spell stuck at zero, and a cost that eats a creature worth more than what
 * it buys. They stay because they are about things the one-move search cannot see — what a card
 * will be worth later — rather than about what a card does.
 */
function candidateActions(
  state: GameState, seat: SeatIndex, actions: LegalActions,
): { action: Action }[] {
  const out: { action: Action }[] = [];
  const playable = actions.plays
    .filter((p) => !p.isManaAbility)
    .sort((a, b) => playValue(b) - playValue(a))
    .slice(0, PLAY_WIDTH);

  for (const play of playable) {
    // An X spell with X stuck at nothing is a card thrown away: a Fireball for no damage, an
    // Endless One that enters as a 0/0 and dies before anyone can look at it. Legal, and never
    // what the bot means.
    if (play.xMax === 0) continue;
    // Lands are taken by the rule above, before the search sees them.
    if (play.kind === 'land') continue;
    /*
      Turning a morph face up: one action, no targets, nothing to choose.

      Offered to the search like any other play rather than ruled on here, which is the whole
      reason it needed no teaching: `simulate` scores the board with the creature turned up, so the
      bot pays two mana to make a 2/2 into a 5/5 when that wins the combat and holds the mana when
      it does not. A special action is also the only play in this list that cannot be answered, and
      the search gets that for free — there is no window for the opponent's reply to be searched.
    */
    if (play.kind === 'turnUp') {
      out.push({ action: { type: 'auto:turnUp', by: seat, card: play.card } });
      continue;
    }
    /*
      Foretelling: {2} to hide a card in exile, offered to the search like any other play.

      This is the one mechanic in the pool that is *about* the thing this bot cannot do. Holding two
      mana for a counterspell is a decision the search cannot price — it has been measured and
      written up three times (D108, D110, D119) — and foretell turns it into two decisions it can:
      spend two mana now on a card that is not doing anything yet, and spend two mana later on a
      spell that is. `simulate` scores the board after the foretell, so what it sees is two mana
      gone and a card out of hand, which is a cost with no visible gain — and that is exactly the
      case `castsARitual` and its family exist for. So it is dropped unless the mana was going
      spare; see `foretellIsSpareMana`.
    */
    if (play.kind === 'foretell') {
      out.push({ action: { type: 'auto:foretell', by: seat, card: play.card } });
      continue;
    }
    for (const aim of aimings(state, seat, play)) {
      const targets = aim.targets;
      if (play.kind === 'cast') {
        /*
          A spell with an additional cost: something has to be fed to it before it can be cast at
          all, and the bot has to decide whether that is worth doing.

          Shallow in the same way as every other judgement in this file, and deliberately so: it
          feeds the cheapest creature it has, and it will not do it unless that creature is worth
          less than what the spell is aimed at — or, for a spell with no target, unless the
          creature is nearly offered anyway. Without this it was happy to eat its best creature to
          draw two cards, which loses games while passing every test that only checks one finished.
        */
        let fodder: string | null = null;
        if (play.sacrificeOptions.length > 0) {
          fodder = cheapestCreature(state, play.sacrificeOptions);
          if (fodder === null) continue;
          const cost = characteristicsOf(state, state.instances[fodder]!).power;
          const gain = targets.reduce((best, target) => {
            if (target.kind !== 'card') return best;
            const inst = state.instances[target.id];
            return inst === undefined ? best : Math.max(best, characteristicsOf(state, inst).power);
          }, 0);
          if (cost >= Math.max(gain, 2)) continue;
        }
        out.push({
          action: {
            type: 'auto:cast', by: seat, card: play.card,
            // The kicker was chosen by choosing this play — `legalActions` offers the kicked
            // version as a separate one — so it has to be said, or the engine casts the cheap
            // half of a card the table offered as the expensive one.
            ...(play.kicked === true ? { kicked: true } : {}),
            // And the same for flashback, which is a different *zone* as well as a different
            // cost: without this the engine would be told to cast a card that is in a graveyard
            // as though it were in hand, and would refuse its own offer.
            ...(play.flashback === true ? { flashback: true } : {}),
            // And escape, which is flashback's zone with a cost that is partly cards: without
            // this the engine is told to cast a card in a graveyard as though it were in hand,
            // and the bot's own offer comes back refused. How many cards it costs is on the play
            // as `exiles`; which ones is the engine's to pick, so it is not sent.
            ...(play.escape === true ? { escape: true } : {}),
            // And morph, for the third time and the same reason: the face-down cast is a separate
            // play on the same card, so a cast sent without this flag is the printed one — which
            // the engine then refuses for want of mana, on turn three, which is exactly when the
            // bot wanted the 2/2.
            ...(play.faceDown === true ? { faceDown: true } : {}),
            // And foretell, which is a different zone as well as a different cost: without this
            // the engine is told to cast a card in exile as though it were in hand.
            ...(play.foretold === true ? { foretold: true } : {}),
            // And an offered cast, for the fourth time and the same reason, with one difference: this
            // flag is not a cheaper cost but a claim on an offer the engine is holding open, so a
            // cast sent without it is refused outright rather than charged the printed cost.
            ...(play.offered === true ? { offered: true } : {}),
            // And evoke, which is the kicker's shape with the trade reversed: a cheaper cast of a
            // card in hand, offered as its own play. Sent without the flag the engine would charge
            // the printed cost — and the bot would be casting a five-mana creature it had priced
            // at three.
            ...(play.evoked === true ? { evoked: true } : {}),
            // And dash, which is the same flag with the other consequence: without it the bot is
            // told to cast a two-mana 3/1 it had priced as a one-mana hasty one.
            ...(play.dashed === true ? { dashed: true } : {}),
            // And bestow, the third of the family: without it the bot is told to cast a creature
            // spell that has a creature targeted, which is a cast the engine refuses.
            ...(play.bestowed === true ? { bestowed: true } : {}),
            // And spectacle, the fourth: the row only exists on a turn an opponent has lost life,
            // and a cast sent without the flag is the printed cost on a card the bot had priced
            // at one mana.
            ...(play.spectacled === true ? { spectacled: true } : {}),
            // And overload, the fifth: a cast sent without the flag is the printed spell, which
            // targets one thing — and the bot had just decided it wanted all of them.
            ...(play.overloaded === true ? { overloaded: true } : {}),
            // And which half of a two-faced card, for the fifth time and the same reason: the two
            // halves are separate plays on one card, and a cast sent without this is either the
            // wrong spell or — on a split card, which has no printed face of its own — refused.
            ...(play.half === undefined ? {} : { half: play.half }),
            ...(fodder === null ? {} : { sacrifice: fodder }),
            /*
              X as large as the mana allows. The search sees what that buys, which is new: it
              will not cast a Hurricane for eight into a board of its own fliers any more.

              Unless X is a *number to match* rather than an amount, which is one card in the pool
              and the opposite rule: see `xToMatch`.
            */
            ...(play.xMax === undefined ? {} : {
              x: scriptFor(state.cardDefs[state.instances[play.card]?.defKey ?? '']?.name)
                ?.xIsANumberToMatch === true
                ? xToMatch(state, seat, play.xMax)
                : play.xMax,
            }),
            ...(play.modes === undefined ? {} : { modes: [...play.modes] }),
            ...(targets.length > 0 ? { targets: [...targets] } : {}),
            // And the division, which is not optional on a card that has one: the engine refuses
            // a dividing spell cast without it, so this is the line that makes the card castable
            // by anything other than a person.
            ...(aim.division === undefined ? {} : { division: [...aim.division] }),
          },
        });
        continue;
      }
      /*
        An ability paid for by sacrificing something is only worth it when the thing eaten is
        worth less than the thing fed.

        **And a creature with text of its own is never fed to one, which is the fourteenth member
        of the drop-this-option family.** The comparison below is against the *source's* power,
        which is a fair proxy for a Bloodthrone Vampire whose ability makes it bigger and means
        nothing at all for a Woe Strider whose `{0}` buys a scry. Measured: over 144 games Ashen
        Rite activated that outlet **348 times**, and what it was eating was its own 0/1 Blood
        Artists — the three cards the deck is built around — for a look at the top of the library.

        So a token is fed freely, a textless body is fed when the arithmetic below says so, and a
        card with text is not fed at all. The bot cannot tell when eating a Blood Artist to push
        lethal damage is right, and the measurement says the cost of guessing is enormous.
      */
      if (play.sacrificeOptions.length > 0) {
        const fodder = cheapestCreature(state, play.sacrificeOptions);
        if (fodder === null) continue;
        const token = state.instances[fodder]?.isToken === true;
        if (!token && hasOwnText(state, fodder)) continue;
        const self = state.instances[play.card];
        const worth = self === undefined ? 0 : characteristicsOf(state, self).power;
        if (!token && characteristicsOf(state, state.instances[fodder]!).power >= worth) continue;
        out.push({
          action: {
            type: 'auto:activate', by: seat, card: play.card, abilityIndex: play.abilityIndex ?? 0,
            sacrifice: fodder,
            ...(targets.length > 0 ? { targets: [...targets] } : {}),
          },
        });
        continue;
      }
      out.push({
        action: {
          type: 'auto:activate', by: seat, card: play.card, abilityIndex: play.abilityIndex ?? 0,
          ...(targets.length > 0 ? { targets: [...targets] } : {}),
        },
      });
    }
  }
  return out;
}

export interface BotOptions {
  /**
   * Whether to look one move ahead before choosing a play. On by default.
   *
   * Off is the bot as it was before the search existed: the most expensive affordable play, aimed
   * by the shallow ranking. It is kept for two reasons — it is the control the search is measured
   * against, and it is there to fall back on if the search ever turns out to cost more time than
   * it is worth on a table somebody is waiting at.
   */
  readonly lookahead?: boolean;
  /**
   * Whether the search stops where its action happened rather than wherever auto-pass carried the
   * table. On, and here to be turned off: it is the control this was measured against, and the
   * measurement is the reason it is on. See `noAutoPass`.
   */
  readonly stopAtAction?: boolean;
  /**
   * Whether to send attacks at the player holding the crown first (CR 720). On by default.
   *
   * Off is the control this was measured against. It changes only what the bot itself declares:
   * inside its own search the opponents are modelled with the rule on, because that is what the
   * other players at the table are doing — and threading a measurement switch through the search
   * would be a larger change than the thing being measured. See `foeOrder`.
   */
  readonly chaseTheCrown?: boolean;
  /**
   * Whether to keep back the mana an answer in hand is waiting for, on this seat's own turn.
   *
   * **On by default, and on for a reason the record does not give.** See `spendsAnAnswersMana` for
   * the measurement: bot against bot it is +72, +17 and +2 of 2808 across three seed sets — the
   * right sign three times and inside the floor — and the thirteen-deck table moves the five decks
   * that hold counterspells by +1 between them. Level, twice over. What it changes is the play: the
   * deck that counters 4% of the spells it holds an answer for counters 48% of them. Off is the bot
   * as it was, kept as the control this was measured against.
   */
  readonly reserveForAnswers?: boolean;
}

/**
 * Aims a trigger that is waiting for its targets, best candidate first.
 *
 * Lifted out of `botAction` so a simulation can answer the same question the same way: a combat
 * that kills two creatures in front of a Blood Artist stops dead on "choose a player", and a
 * search that gave up there would score the exchange without the four points of life it swings.
 */
function aimPending(
  state: GameState, seat: SeatIndex, choice: NonNullable<LegalActions['mustChoose']>,
): Action {
  const foes = foesOf(state, seat);
  const chosen: Target[] = [];
  const used = new Set<string>();
  for (let i = 0; i < choice.specs.length; i++) {
    const want = Math.max(1, choice.specs[i]!.count ?? 1);
    const ranked = [...(choice.candidates[i] ?? [])]
      .filter((t) => !used.has(targetKey(t)))
      .sort((a, b) => rank(state, b, foes) - rank(state, a, foes));
    for (const pick of ranked.slice(0, want)) {
      used.add(targetKey(pick));
      chosen.push(pick);
    }
  }
  return { type: 'auto:choose', by: seat, targets: chosen };
}

/**
 * Answers whatever a simulated line is waiting on, for the seat it is waiting on.
 *
 * Returns null when nothing is pending. Both policies are the bot's own, which is the only
 * opponent model there is and the fair one: the other seat is assumed to answer as well as this
 * one would.
 */
function answerPending(state: GameState): Action | null {
  if (state.pendingChoice !== null) {
    const seat = state.pendingChoice.seat;
    const choice = legalActions(state, seat).mustChoose;
    return choice === null ? null : aimPending(state, seat, choice);
  }
  if (state.pendingDecision !== null) {
    const seat = state.pendingDecision.seat;
    const ask = legalActions(state, seat).mustDecide;
    return ask === null ? null : decideAction(state, seat, ask);
  }
  if (state.pendingPayment !== null) {
    return { type: 'auto:pay', by: state.pendingPayment.seat, pay: true };
  }
  /*
    An offered cast inside a simulated line, taken whenever there is a legal way to take it.

    Greedy rather than searched, which is this function's whole contract: it is what keeps a
    *simulation* moving, and a search inside a search is how a four-seat pod came to spend minutes
    on one decision (D71). The real decision — which target, which mode — is made by the search
    that owns the position, up in `botAction`; this is the stand-in for the other seats.
  */
  if (state.pendingOfferedCast !== null) {
    const seat = state.pendingOfferedCast.seat;
    const inside = legalActions(state, seat);
    const options = inside.mustCastOffered === null ? [] : candidateActions(state, seat, inside);
    return options[0]?.action ?? { type: 'auto:pass', by: seat };
  }
  return null;
}

// ── Combat, played out before it is declared ─────────────────────────────────────────────────────

/**
 * Plays a combat out: blockers declared, damage dealt, through to the end of combat.
 *
 * The defenders block with the bot's own blocking policy, which is the only opponent model there
 * is and a fair one — it is the same reasoning the player across the table would be using if they
 * were also the server. Everything else passes.
 *
 * It stops at the end of combat, so what it shows is *this* exchange played by the rules rather
 * than by `exchange()`'s arithmetic — first strike, deathtouch, trample, two blockers on one
 * attacker, a pump spell cast in response. That is the whole gain, and it is worth 17 games in
 * 400 against the same opponent on the same seeds.
 *
 * It does not reach the opponent's next turn, so "hold a creature back to block" is still outside
 * what it can see. The cheap substitute — scoring an untapped creature above a tapped one, so
 * attacking costs something — was tried and *lost* games: a one-point bonus changed nothing, two
 * points cost 26 games in 400, and four points made the bot worse than the one it replaced. In
 * this pool, attacking is right, and a bot that keeps blockers home is a bot that never closes.
 *
 * Nobody answers inside it either. Letting the defender cast its Fog, its pump or its removal here
 * was built and measured: it holds a creature back exactly where a player would, and it wins
 * nothing — D110 has the numbers and the reason it was reverted anyway.
 */
function throughCombat(state: GameState): GameState {
  let next = state;
  for (let i = 0; i < 40; i += 1) {
    if (next.finished) break;
    /*
      Past combat — but not before the consequences of it have finished.

      The step moves on the moment damage is dealt, while the triggers that damage raised are
      still on the stack: two creatures dying in front of a Blood Artist is four points of life
      that have not happened yet. Stopping at the step boundary scored the exchange without them,
      and the bot traded into a drain engine every time.
    */
    const settled = next.stackOrder.length === 0 && answerPending(next) === null;
    if (settled && (next.step === 'end-combat' || next.step === 'postcombat-main' || next.step === 'end')) break;
    const owed = pendingDeclaration(next);
    if (owed !== null) {
      const seat = owed.seats[0];
      if (seat === undefined) break;
      // The heuristic's own declaration, with whatever had to attack folded in — otherwise a
      // simulated turn with a Juggernaut on the board is refused and the playout stops short of
      // the combat it was looking at. See `attackPlans`.
      const action: Action = owed.kind === 'attackers'
        ? {
            type: 'auto:attack', by: seat,
            attackers: legalDeclaration(next, seat, chooseAttackers(next, seat)),
          }
        // Inside a simulation the order is taken rather than searched: searching it here would be
        // a search inside the search, and the heuristic order is the one `scoreDeclaration` is
        // comparing plans against anyway.
        : owed.kind === 'order'
          ? { type: 'auto:order', by: seat, orders: damageOrdersOwed(next, seat) }
          : { type: 'auto:block', by: seat, blocks: chooseBlocks(next, seat) };
      try {
        next = applyAction(next, action, HOST);
      } catch {
        break;
      }
      continue;
    }
    const answer = answerPending(next);
    if (answer !== null) {
      try {
        next = applyAction(next, answer, HOST);
      } catch {
        break;
      }
      continue;
    }
    if (next.priority === null) break;
    try {
      next = applyAction(next, { type: 'auto:pass', by: next.priority }, HOST);
    } catch {
      break;
    }
  }
  return next;
}

/**
 * One declaration, and what the board looks like once the dust settles.
 *
 * "Once the dust settles" is the end of *this* combat. Projecting the opponent's next attack as
 * well was built, measured twice — for every play, and for attack declarations alone — and changed
 * nothing: 276 wins in 400 games with it and 276 without, at twice the time. The depth is not what
 * is holding this bot back; the evaluation is, and the honest place for that finding is here rather
 * than in dead code. See `claude/decisions-log.md`, D62.
 */
function scoreDeclaration(
  state: GameState, seat: SeatIndex, action: Action, stopAtAction: boolean,
): number | null {
  let after: GameState;
  try {
    // Nobody auto-passing, so `throughCombat` below gets to decide where this stops. With it on,
    // half of all attack declarations come back with the turn already over — see `noAutoPass`.
    after = applyAction(stopAtAction ? noAutoPass(state) : state, action, HOST);
  } catch {
    return null;
  }
  return evaluate(throughCombat(after), seat);
}

type AttackPlan = { attacker: string; defender: SeatIndex; planeswalker?: string }[];

/**
 * The attacks worth considering, as whole plans rather than one creature at a time.
 *
 * Combat is not a sum of independent choices — two attackers into one blocker is a different
 * exchange from either of them alone — so the search compares plans:
 *
 *  - what the heuristic would do, which is the one to beat;
 *  - nothing at all, which is the plan the heuristic can never choose and the one a player picks
 *    when the swing back would kill them;
 *  - everything that can attack, because the heuristic is pessimistic about blockers on purpose
 *    and an alpha strike is sometimes exactly right;
 *  - the heuristic's plan minus its biggest creature, which is the plan a player picks when the
 *    board needs a blocker more than the opponent needs the damage.
 *
 * Four plans, not every subset: the subsets of ten attackers are a thousand combats to play out,
 * and these four are the shapes a player actually chooses between.
 */
function attackPlans(state: GameState, seat: SeatIndex, opts: BotOptions = {}): AttackPlan[] {
  const heuristic = chooseAttackers(state, seat, opts);
  const plans: AttackPlan[] = [heuristic, []];

  const able = legalActions(state, seat).attackers.filter((id) => canAttack(state, id, seat) === null);
  const foes = foeOrder(state, seat, opts.chaseTheCrown !== false);
  const nearest = foes[0];
  if (nearest !== undefined && able.length > heuristic.length) {
    plans.push(able.map((attacker) => ({ attacker, defender: nearest.index })));
  }

  if (heuristic.length > 1) {
    let biggest = heuristic[0]!;
    for (const entry of heuristic) {
      if (creatureValue(state, entry.attacker) > creatureValue(state, biggest.attacker)) biggest = entry;
    }
    plans.push(heuristic.filter((entry) => entry.attacker !== biggest.attacker));
  }
  /*
    Every plan has to be legal before it is any good.

    "Attacks each combat if able" (CR 508.1d) makes *leaving a creature at home* illegal, which is
    the one kind of rule a search over plans can break by accident: "attack with nothing" is one of
    the four plans here, and a Juggernaut on the board makes it a declaration the engine refuses.
    `playout.test.ts` asserts the engine never refuses what was offered, so this is not a nicety.

    Added rather than filtered: dropping the plans that miss a forced attacker would throw away
    "attack with nothing", which is the plan a player picks when the swing back would kill them —
    so the forced creatures are folded into each plan instead, aimed at whoever is weakest.
  */
  return plans.map((plan) => keepsItsWord(state, seat, legalDeclaration(state, seat, plan)));
}

/**
 * The same plan with the promises in it kept (see `GameState.pacts`).
 *
 * A pact is not a rule, so this is not `legalDeclaration`: every plan it touches was already legal
 * and the engine would have taken it. It is the bot *choosing* to keep its word, and it is applied
 * to every plan rather than scored as one option among several on purpose — a deal the search
 * would weigh against half a point of board advantage is a deal nobody at the table can rely on,
 * and the only thing a pact has going for it is that it is reliable.
 *
 * Which leaves the one case where it cannot: a creature that has to attack and has nowhere else to
 * go. Then the attack stands, the pact is marked broken, and the log says so — the bot breaking a
 * promise because the rules made it is better than the bot being unable to declare a legal attack,
 * and it is the honest answer to give a player who asks why.
 */
function keepsItsWord(state: GameState, seat: SeatIndex, plan: AttackPlan): AttackPlan {
  if (!plan.some((entry) => pactProtects(state, seat, entry.defender))) return plan;
  const forced = new Set(forcedAttackers(state, seat));
  const byLife = foesOf(state, seat)
    .map((index) => ({ index, life: state.seats[index]?.life ?? 0 }))
    .sort((a, b) => a.life - b.life)
    .map((foe) => foe.index);

  const kept: AttackPlan = [];
  for (const entry of plan) {
    if (!pactProtects(state, seat, entry.defender)) {
      kept.push(entry);
      continue;
    }
    const allowed = new Set(legalDefenders(state, entry.attacker, seat));
    const elsewhere = byLife.find((index) => allowed.has(index) && !pactProtects(state, seat, index));
    if (elsewhere !== undefined) {
      // Re-pointed before it is dropped: a deal with one player is not a reason to stop attacking
      // the other two, and in a pod that is usually the whole point of making one.
      kept.push({ attacker: entry.attacker, defender: elsewhere });
    } else if (forced.has(entry.attacker)) {
      kept.push(entry);
    }
  }
  return kept;
}

/**
 * A plan the engine will accept: everything that had to attack is in it, and nothing is pointed
 * somewhere it may not go.
 *
 * Both halves are here because both are ways a *plan* can be illegal while every creature in it is
 * fine, which is the one class of mistake a search over plans makes by accident. Leaving a forced
 * attacker at home is the first (CR 508.1d); aiming a goaded creature back at the player who
 * goaded it is the second (CR 701.38a), and the plans above can do it without trying — three of
 * the four send everything at whoever has the least life, and goad exists to stop exactly that.
 *
 * Every aim picks the weakest *legal* defender for that creature rather than the weakest outright,
 * which is the same heuristic the plans use, asked per creature instead of once.
 */
function legalDeclaration(state: GameState, seat: SeatIndex, plan: AttackPlan): AttackPlan {
  const byLife = foesOf(state, seat)
    .map((index) => ({ index, life: state.seats[index]?.life ?? 0 }))
    .sort((a, b) => a.life - b.life)
    .map((foe) => foe.index);
  const weakestLegal = (attacker: string): SeatIndex | null => {
    const allowed = new Set(legalDefenders(state, attacker, seat));
    return byLife.find((index) => allowed.has(index)) ?? null;
  };

  const fixed: AttackPlan = [];
  for (const entry of plan) {
    if (attackAimIssue(state, entry.attacker, seat, entry.defender) === null) {
      fixed.push(entry);
      continue;
    }
    // Re-pointed rather than dropped: it may well be a creature that has to attack, and the
    // planeswalker goes with the player it belonged to.
    const moved = weakestLegal(entry.attacker);
    if (moved !== null) fixed.push({ attacker: entry.attacker, defender: moved });
  }

  const already = new Set(fixed.map((entry) => entry.attacker));
  for (const attacker of forcedAttackers(state, seat)) {
    if (already.has(attacker)) continue;
    const defender = weakestLegal(attacker);
    if (defender !== null) fixed.push({ attacker, defender });
  }
  return fixed;
}

/**
 * The blocks worth considering.
 *
 * The same idea, shorter: what the heuristic would do, no blocks at all, and every blocker thrown
 * in front of the biggest thing it may legally block. "No blocks" matters more than it sounds —
 * the heuristic blocks whenever a trade looks even, and an even trade is a bad deal when the
 * creature it gives up was the only thing holding the next attack off.
 */
/**
 * Two on one: as many blockers as it takes to kill the biggest thing coming at you.
 *
 * `chooseBlocks` pairs each blocker with one attacker and marks that attacker taken, and says so
 * in its own comment — *"menace needs two blockers, which this bot does not coordinate"*. The
 * engine has always handled the other side of it: blockers are collected per attacker, menace is
 * enforced, and combat damage assigns lethal to each blocker in order before anything tramples
 * past (CR 510.1c, CR 702.19b). Only the bot could not ask the question.
 *
 * Measured over 160 unsteered games before this existed: 521 blocks, 471 of them with a single
 * blocker, and **235 where the attacker survived**. In 53 of those a second creature was standing
 * there, legally able to block, and the two together would have killed it. A tenth of every block
 * the bot made left a kill on the table.
 *
 * The plan: pick the attacker worth ganging — the most valuable one two or more creatures can
 * block — and add blockers cheapest-first until they add up to lethal. Then let the heuristic
 * place whatever is left on the other attackers, so this is "the usual block, plus a gang" rather
 * than "a gang and nothing else". It is offered, not taken: `bestPlan` plays it out against the
 * alternatives, which is where the question of whether it is worth two creatures gets answered.
 */
function gangBlock(state: GameState, seat: SeatIndex): { blocker: string; attacker: string }[] {
  const options = legalActions(state, seat).blockers;
  const able = new Map<string, string[]>();
  for (const option of options) {
    for (const attackerId of option.canBlock) {
      if (canBlock(state, option.blocker, attackerId, seat) !== null) continue;
      able.set(attackerId, [...(able.get(attackerId) ?? []), option.blocker]);
    }
  }
  let chosen: { attacker: string; blockers: string[] } | null = null;
  let bestWorth = -Infinity;
  for (const [attackerId, blockers] of able) {
    if (blockers.length < 2) continue;
    const attacker = state.instances[attackerId];
    if (attacker === undefined) continue;
    const ch = characteristicsOf(state, attacker);
    const needed = Math.max(1, ch.toughness - attacker.damage);
    // Cheapest first: the point is to kill it for as little as possible, and whatever is left
    // over still has the rest of the attack to answer.
    const order = [...blockers].sort((a, b) => creatureValue(state, a) - creatureValue(state, b));
    const gang: string[] = [];
    let power = 0;
    for (const id of order) {
      if (power >= needed) break;
      const inst = state.instances[id];
      if (inst === undefined) continue;
      const blocker = characteristicsOf(state, inst);
      gang.push(id);
      // Deathtouch makes any amount lethal (CR 702.2b), which is the whole of what it is for here.
      power = blocker.keywords.has('deathtouch') ? needed : power + blocker.power;
    }
    if (power < needed) continue;
    // Menace is the one shape that cannot be ganged by one creature (CR 702.110a); everything
    // else can, and a "gang" of one is just a block the heuristic already considered.
    if (gang.length < 2) continue;
    const worth = creatureValue(state, attackerId) - gang.reduce((n, id) => n + creatureValue(state, id), 0);
    if (worth > bestWorth) {
      bestWorth = worth;
      chosen = { attacker: attackerId, blockers: gang };
    }
  }
  if (chosen === null) return [];
  const plan = chosen.blockers.map((blocker) => ({ blocker, attacker: chosen!.attacker }));
  const used = new Set(chosen.blockers);
  // The rest of the attack, blocked the way it would have been anyway.
  for (const entry of chooseBlocks(state, seat)) {
    if (used.has(entry.blocker) || entry.attacker === chosen.attacker) continue;
    used.add(entry.blocker);
    plan.push(entry);
  }
  return plan;
}

function blockPlans(state: GameState, seat: SeatIndex): { blocker: string; attacker: string }[][] {
  const heuristic = chooseBlocks(state, seat);
  const plans: { blocker: string; attacker: string }[][] = [heuristic, []];
  const options = legalActions(state, seat).blockers;

  /**
   * One blocker per attacker, each sent at the best attacker it can reach by some measure.
   *
   * Two measures, because they are two different plans and the difference is the difference
   * between living and dying. By **value** it blocks the attackers worth killing, which is what
   * you want on a board where you are not under pressure. By **power** it blocks the attackers
   * that are about to kill you, which is the only thing that matters when they are.
   *
   * Measured over 120 duels before this: the bot faced a lethal attack 68 times, survived 7, and
   * one of the deaths was a block it chose over a block it had available that would have lived — a
   * seat on four life blocking a 1/1 and a 4/4 while a 3/3 went past, when blocking the 3/3 and the
   * 4/4 survived. The 1/1 was an Elvish Visionary, which `creatureValue` prices above a Centaur
   * Courser because it draws a card: by value it was the right block, and by power it was the
   * losing one. After, none — over 77 lethal attacks faced, because the games diverge the moment
   * the blocks do, so the counts are not comparable across the two runs, only the mistakes are.
   */
  const power = (id: string): number => {
    const inst = state.instances[id];
    return inst === undefined ? 0 : characteristicsOf(state, inst).power;
  };
  const spread = (by: (id: string) => number): { blocker: string; attacker: string }[] => {
    const out: { blocker: string; attacker: string }[] = [];
    const taken = new Set<string>();
    for (const option of options) {
      let best: string | null = null;
      for (const attackerId of option.canBlock) {
        if (taken.has(attackerId)) continue;
        const attacker = state.instances[attackerId];
        if (attacker === undefined) continue;
        if (characteristicsOf(state, attacker).keywords.has('menace')) continue;
        if (best === null || by(attackerId) > by(best)) best = attackerId;
      }
      if (best === null) continue;
      taken.add(best);
      out.push({ blocker: option.blocker, attacker: best });
    }
    return out;
  };
  const key = (plan: readonly { blocker: string; attacker: string }[]): string =>
    [...plan].map((entry) => `${entry.blocker}>${entry.attacker}`).sort().join('|');
  const seen = new Set([key(heuristic), key([])]);
  const byValue = spread((id) => creatureValue(state, id));
  if (byValue.length > heuristic.length && !seen.has(key(byValue))) {
    seen.add(key(byValue));
    plans.push(byValue);
  }
  /*
    And, when this seat is about to die, the block that stops the most damage.

    Offered even when it is the same *size* as the heuristic's plan, which is the part that was
    missing. The old code offered its one alternative only when that alternative had *more* blocks
    in it, and the heuristic had already blocked two attackers, so the plan that blocked the two
    *right* ones was never put in front of the search at all.

    Only when the seat is dying, though, because each plan is another combat played out and a block
    happens in most turns of most games. Offering both spreads in every block put nineteen decisions
    over half a second into a 60-pod soak, against baselines of zero and one at two commits with no
    behaviour change — outside that spread, so something really was slower, even though a tail
    cannot say by how much (D101). That is D71's bug coming back for a mistake that costs one game
    in a hundred and twenty. Confined to the lethal attack, the instrument that can price it — the
    mean per decision kind — puts it at 28.12ms -> 28.54ms on a block.
  */
  const life = state.seats[seat]?.life ?? 0;
  let incoming = 0;
  for (const attack of state.combat.attacks) {
    if (attack.defender !== seat) continue;
    incoming += Math.max(0, power(attack.attacker));
  }
  if (incoming >= life) {
    const byPower = spread(power);
    if (byPower.length > 0 && !seen.has(key(byPower))) {
      seen.add(key(byPower));
      plans.push(byPower);
    }
  }
  const gang = gangBlock(state, seat);
  if (gang.length > 0 && !seen.has(key(gang))) plans.push(gang);
  return plans;
}

type DamageOrder = { attacker: string; blockers: string[] };

/**
 * The damage assignment orders worth considering (CR 509.2).
 *
 * Three shapes, applied to every attack that owes an order, because they are the three answers a
 * player actually picks between:
 *
 *  - the order the blocks were declared in, which is what the engine used to do and is the one to
 *    beat;
 *  - cheapest first, which kills as *many* blockers as the power allows;
 *  - most valuable first, which kills the biggest thing it can afford — a 5/5 blocked by a 2/2 and
 *    a 4/4 kills the 4/4 or the 2/2, never both, and which one matters.
 *
 * Whether more kills or a better kill is worth having is not decided here: each order is played
 * through the combat by `scoreDeclaration`, the same way the attack and the block are.
 */
function orderPlans(state: GameState, seat: SeatIndex): DamageOrder[][] {
  const owed = damageOrdersOwed(state, seat);
  if (owed.length === 0) return [[]];
  const lethalCost = (attackerId: string, blockerId: string): number => {
    const attacker = state.instances[attackerId];
    const blocker = state.instances[blockerId];
    if (attacker === undefined || blocker === undefined) return 1;
    if (characteristicsOf(state, attacker).keywords.has('deathtouch')) return 1;
    const ch = characteristicsOf(state, blocker);
    return Math.max(1, ch.toughness - blocker.damage);
  };
  const byCost = (entry: DamageOrder): DamageOrder => ({
    attacker: entry.attacker,
    blockers: [...entry.blockers].sort(
      (a, b) => lethalCost(entry.attacker, a) - lethalCost(entry.attacker, b),
    ),
  });
  const byValue = (entry: DamageOrder): DamageOrder => ({
    attacker: entry.attacker,
    blockers: [...entry.blockers].sort(
      (a, b) => creatureValue(state, b) - creatureValue(state, a),
    ),
  });
  return [owed, owed.map(byCost), owed.map(byValue)];
}

/** Whether this bot's search stops where its action happened. On: see `noAutoPass`. */
const stopsAtAction = (opts: BotOptions): boolean => opts.stopAtAction ?? true;

/** The declaration this seat owes, chosen by playing each plan out. */
function declareBySearch(
  state: GameState, seat: SeatIndex, kind: 'attackers' | 'blockers' | 'order', opts: BotOptions,
): Action {
  if (kind === 'order') {
    const plans = orderPlans(state, seat);
    const fallback: Action = { type: 'auto:order', by: seat, orders: plans[0]! };
    if (opts.lookahead === false) return fallback;
    return bestPlan(state, seat, plans.map((orders) => ({
      type: 'auto:order', by: seat, orders,
    } as Action)), stopsAtAction(opts)) ?? fallback;
  }
  if (kind === 'attackers') {
    const plans = attackPlans(state, seat, opts);
    const fallback: Action = { type: 'auto:attack', by: seat, attackers: plans[0]! };
    if (opts.lookahead === false) return fallback;
    return bestPlan(state, seat, plans.map((attackers) => ({
      type: 'auto:attack', by: seat, attackers,
    } as Action)), stopsAtAction(opts)) ?? fallback;
  }
  const plans = blockPlans(state, seat);
  const fallback: Action = { type: 'auto:block', by: seat, blocks: plans[0]! };
  if (opts.lookahead === false) return fallback;
  return bestPlan(state, seat, plans.map((blocks) => ({
    type: 'auto:block', by: seat, blocks,
  } as Action)), stopsAtAction(opts)) ?? fallback;
}

/** The highest-scoring of a set of declarations, or null when none of them can be applied. */
function bestPlan(
  state: GameState, seat: SeatIndex, actions: readonly Action[], stopAtAction: boolean,
): Action | null {
  let best: Action | null = null;
  let bestScore = -Infinity;
  for (const action of actions) {
    const score = scoreDeclaration(state, seat, action, stopAtAction);
    if (score === null) continue;
    // `>` again, so the heuristic's own plan — which is always first — wins a tie. A search that
    // changed the play for a rounding error would be impossible to reason about from a log.
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }
  return best;
}

/** The single action this seat would take now, or null when it has nothing to do. */
/**
 * Whether there is combat damage left for a Fog to prevent.
 *
 * The second card in the "spent on nothing" family. A Fog cast on an empty board is a card in the
 * graveyard, and the evaluation sees a card leaving the hand either way — so the question is asked
 * of the *board*: is there an attack **aimed at this seat**, and is its damage still to come.
 *
 * Asked of the board **before** the cast rather than of the state after it, which is the mistake
 * this started as: with auto-pass on, a spell nobody can respond to resolves inside the same
 * action and the engine keeps passing, so a simulated line can end the turn — and an end-of-turn
 * effect is gone by then. The first version looked for the prevention effect in the state after
 * the cast, found nothing, and let every pointless Fog through: **21 cast across 160 games, 11 of
 * them with nothing attacking at all.**
 *
 * `first-strike-damage` counts, because a Fog cast after the first-strike damage still prevents
 * the regular damage. `postcombat-main` does not, which is the case this exists to stop.
 */
function damageStillToCome(state: GameState, seat: SeatIndex): boolean {
  // Aimed at *this* seat, which the first measurement after the rule went in showed is not the
  // same question: a Fog is symmetric, so fogging your own alpha strike prevents your damage and
  // nobody else's. Eleven Holy Days stopped eight points of attacking power between them, because
  // some of them were cast over the caster's own attack.
  if (!state.combat.attacks.some((attack) => attack.defender === seat)) return false;
  return state.step === 'declare-attackers'
    || state.step === 'declare-blockers'
    || state.step === 'first-strike-damage';
}

/**
 * Whether prevention spent on this action can still earn its keep.
 *
 * Damage has to be coming at this seat, which is `damageStillToCome` and is the Fog rule. A shield
 * paid for by **tapping a creature** has a second condition on top of it: it waits until blockers
 * are declared, because the tap is also paying with a blocker and the search cannot see that — it
 * scores the position one move out, where a tapped 1/1 and an untapped one are worth the same and
 * the block that 1/1 would have made has not happened yet. Nothing is lost by waiting: the ability
 * is instant speed, and a shield spent after blocks are in knows what it is stopping.
 */
function preventionCanMatter(state: GameState, seat: SeatIndex, action: Action): boolean {
  if (!damageStillToCome(state, seat)) return false;
  return !(action.type === 'auto:activate' && state.step === 'declare-attackers');
}

/**
 * Whether this action spends something whose whole effect is to prevent damage.
 *
 * Three shapes now, and each needed saying separately:
 *
 *  - the **card**, which is a Fog;
 *  - one **mode** of a card, which is Healing Salve's shield — its other mode gains three life and
 *    is never wasted in the same way, so dropping the whole card would throw away the good half;
 *  - one **ability**, which is Samite Healer's tap. The creature is a fine play; what is spent on
 *    nothing is the tap, and a tapped 1/1 is not a blocker.
 */
function castsAPrevention(state: GameState, action: Action): boolean {
  if (action.type === 'auto:activate') {
    const name = state.cardDefs[state.instances[action.card]?.defKey ?? '']?.name;
    const ability = scriptFor(name)?.abilities?.[action.abilityIndex ?? 0];
    return ability?.preventsDamage === true;
  }
  if (action.type !== 'auto:cast') return false;
  const name = state.cardDefs[state.instances[action.card]?.defKey ?? '']?.name;
  const script = name === undefined ? undefined : scriptFor(name);
  if (script === undefined) return false;
  if (script.preventsDamage === true) return true;
  return modesOf(script, action.modes).some((mode) => mode.preventsDamage === true);
}

/**
 * Whether this action turns a permanent into a creature (see `AbilityDef.animates`).
 */
function animatesSomething(state: GameState, action: Action): boolean {
  if (action.type !== 'auto:activate') return false;
  const name = state.cardDefs[state.instances[action.card]?.defKey ?? '']?.name;
  return scriptFor(name)?.abilities?.[action.abilityIndex ?? 0]?.animates === true;
}

/**
 * Whether animating this permanent could do anything: is there an attack to make, or a block.
 *
 * The eighth "spent on nothing" rule, and the one with the largest count behind it. A Mutavault
 * that becomes a 2/2 is *still a land* to `seatValue`, so the animation scores exactly zero — and
 * with no baseline for doing nothing, a search comparing options with `>` takes a free zero
 * whenever nothing better is affordable. It pressed the button **854 times across 56 games and
 * never attacked with it once**, which is {1} a turn spent on nothing in a deck whose spells all
 * cost {R}.
 *
 * So the board is asked instead, the same way the Fog, the ritual and the removal rules ask it:
 *
 *  - its own precombat main phase, with the land untapped, not summoning-sick, and somebody left
 *    to attack — the only moment animating leads to damage;
 *  - or an attack aimed at this seat with its damage still to come, where a 2/2 blocker is a 2/2
 *    blocker.
 *
 * Summoning sickness is read off `enteredTurn` directly rather than through `canAttack`, which
 * cannot answer the question: the permanent is not a creature *yet*, so `canAttack` would refuse
 * it for being a land. A land animated by something that also granted haste would be judged
 * wrongly here, and there is no such card.
 */
function animationCouldMatter(state: GameState, seat: SeatIndex, action: Action): boolean {
  if (action.type !== 'auto:activate') return false;
  const inst = state.instances[action.card];
  if (inst === undefined || inst.tapped) return false;
  /*
    And not twice, which is the auto-pass trap's cousin.

    The first animation is still on the stack when the next decision is made, so the permanent is
    not a creature yet and the board looks exactly as it did — the rule above would say yes again,
    and the bot would animate until the mana ran out. Asking the *stack* as well as the battlefield
    is the honest version of "has this already been done": one of the two is always the answer.
  */
  if (characteristicsOf(state, inst).isCreature) return false;
  if (state.stackOrder.some((id) => state.stackObjects[id]?.source === action.card)) return false;
  if (state.activeSeat === seat && state.step === 'precombat-main'
    && inst.enteredTurn < state.turn
    && state.seats.some((s) => s.index !== seat && !s.eliminated)) {
    return true;
  }
  return state.combat.attacks.some((attack) => attack.defender === seat)
    && (state.step === 'declare-attackers' || state.step === 'declare-blockers');
}

/**
 * Whether handing this ability back — by untapping the permanent it is on — would be worth nothing.
 *
 * Two kinds. An ability whose whole effect is **untapping** something, because counting it would
 * make the cycle its own justification: untapping a Kiora's Follower hands back an untap. And a
 * **mana** ability, because what untapping a land buys is a spell, which the cast comparison in
 * `untapBoughtSomething` asks about directly — counted here as well, every tapped land would be
 * worth untapping whether or not there was anything to spend it on.
 */
function pointlessToHandBack(state: GameState, play: LegalPlay): boolean {
  if (play.kind !== 'activate') return false;
  const name = state.cardDefs[state.instances[play.card]?.defKey ?? '']?.name;
  const ability = scriptFor(name)?.abilities?.[play.abilityIndex ?? 0];
  return ability?.untapsOnly === true || ability?.produces !== undefined;
}

/**
 * Whether this activation is one the card allows and the board makes pointless.
 *
 * The sixteenth of the "spent on nothing" family, and the first about an **ability** rather than a
 * card in hand. Adapt is the shape: "if this creature has no +1/+1 counters on it, put N on it" is
 * a condition inside the effect, so paying for it a second time is legal and does nothing — and
 * the search cannot see that, because with auto-pass on the state after a four-mana ability can be
 * a turn later and two positions a turn apart do not compare. Measured before the rule: one
 * Aeromunculus, **29 casts and 88 activations** across 34 games.
 *
 * The card says which question to ask; see `AbilityDef.buysNothingIf`.
 */
function activationBuysNothing(state: GameState, seat: SeatIndex, action: Action): boolean {
  if (action.type !== 'auto:activate') return false;
  const name = state.cardDefs[state.instances[action.card]?.defKey ?? '']?.name;
  const ability = scriptFor(name)?.abilities?.[action.abilityIndex ?? 0];
  return ability?.buysNothingIf !== undefined && ability.buysNothingIf(state, action.card, seat);
}

/**
 * Whether this equip moves an Equipment sideways: off a creature you control and onto one that is
 * no bigger.
 *
 * The seventeenth of the "spent on nothing" family, and the first one `wasted-plays.mjs` found
 * rather than a hunch. That harness fingerprints everything a player would call value before and
 * after each play and reports the ones where nothing moved; across 156 games, **124 of the 170
 * suspects were equips** — a Basilisk Collar moved onto a Wall of Blossoms twenty-one times, onto
 * Llanowar Elves ten, onto a Gravedigger twelve. The Equipment was already on something; the move
 * bought nothing.
 *
 * The engine has refused *re-equipping the same creature* since D35, because that is a play that
 * does nothing at all. This is the next shell out: a different creature, the same bonus, no gain.
 *
 * **Power is the test**, which is a proxy and the honest cost of the rule: deathtouch is worth more
 * on a creature that will block than on a bigger one that will not, and this drops that move too.
 * What it keeps is every first equip, every move onto something bigger, and every move off a host
 * that is gone, tapped or no longer a creature — which is what the printed reason to move an
 * Equipment usually is.
 */
function equipMovesSideways(state: GameState, seat: SeatIndex, action: Action): boolean {
  if (action.type !== 'auto:activate') return false;
  const inst = state.instances[action.card];
  if (inst === undefined) return false;
  const name = state.cardDefs[inst.defKey]?.name;
  if (scriptFor(name)?.equipBonus === undefined) return false;
  const hostId = inst.attachedTo;
  if (hostId === null || hostId === undefined) return false;
  const host = state.instances[hostId];
  // A host that has left, or stopped being a creature this seat controls, is a reason to move.
  if (host === undefined || host.zone !== 'battlefield' || host.zoneSeat !== seat) return false;
  if (!characteristicsOf(state, host).isCreature) return false;
  // And a host that is tapped cannot attack or block with the bonus on it, so moving is fair.
  if (host.tapped) return false;
  const target = action.targets?.[0];
  if (target === undefined || target.kind !== 'card') return false;
  const to = state.instances[target.id];
  if (to === undefined) return false;
  return characteristicsOf(state, to).power <= characteristicsOf(state, host).power;
}

/** Whether this action activates an ability whose whole effect is untapping something. */
function untapsSomething(state: GameState, action: Action): boolean {
  if (action.type !== 'auto:activate') return false;
  const name = state.cardDefs[state.instances[action.card]?.defKey ?? '']?.name;
  return scriptFor(name)?.abilities?.[action.abilityIndex ?? 0]?.untapsOnly === true;
}

/**
 * Whether untapping something bought this seat anything at all.
 *
 * The eleventh of the "spent on nothing" family, and the only one about a **cycle** rather than a
 * card. Two Kiora's Followers ("{T}: untap another target permanent") untap each other for ever:
 * A taps to untap B, B taps to untap A, and the board is exactly where it started. Every step of
 * that is legal, the engine is right to allow it, and the search is perfectly happy — `evaluate`
 * sums material, and which of two permanents is tapped is worth the same either way, so with no
 * baseline for doing nothing the free zero gets taken whenever there is nothing better. Measured
 * with one copy in Delta Bloom: **165 activations across 120 games**, and with two copies on the
 * same seeds **29,432** (see `claude/decisions-log.md`, D141, which wrote the problem down rather
 * than solving it). Afterwards, on those seeds: one and ten. The records move by five games and
 * three, both inside the noise floor — the table in `playout.test.ts` has all four numbers.
 *
 * The fix is not "do not repeat yourself" — a Gelectrode pinging twice in a step is the same shape
 * and entirely right. It is to ask what the untap *bought*, the way the ritual rule asks what the
 * mana bought. One fact about the board, then three comparisons:
 *
 *  - the target has to be **tapped**. Untapping an untapped permanent does nothing whatsoever, and
 *    that alone was 36 of the 57 activations the first version of this rule let through;
 *  - **mana**: a cast that was not affordable before is affordable now, which is what untapping a
 *    land is for, and is `ritualBoughtSomething`'s question asked of a different card;
 *  - **a body in a combat**: one more creature that can block an attack already on the table, or
 *    one more that can attack before this seat's own attack is declared. Counted rather than
 *    assumed, which is what makes the wash a wash: the ability taps a creature to untap a
 *    creature, so the count only moves if the source was not a body to begin with;
 *  - **an ability that does something other than untap or make mana**, handed back — untapping a
 *    tapped Master Decoy is a second creature tapped down, and that is a real gain.
 *
 * The last clause is where the cycle dies, and why it is worded that way rather than as "a new
 * ability": untapping a Kiora's Follower *does* hand one back, and that one is another untap, so
 * counting it would make the cycle its own justification. A mana ability is left out of it for the
 * mirror-image reason — see `pointlessToHandBack`.
 *
 * **Two traps, both found by instrumenting a version that fell into them.** The step is checked
 * because with auto-pass on, a line that had nothing to do with the untap has already left the
 * step by the time `simulate` returns — the lesson the ritual rule learned first. And the stack
 * has to be **empty**, because `simulate` drains it: with anything on the stack, every
 * sorcery-speed play in hand is missing from `before` and present in `after`, so the untap gets
 * credit for a Preordain it had nothing to do with. That was the whole of the first version's
 * remaining 57 activations. An untap held for a moment when something is already on the stack is
 * refused as a consequence, and nothing in the pool wants one.
 */
function untapBoughtSomething(
  before: GameState, after: GameState, seat: SeatIndex, action: Action,
): boolean {
  const aimed = action.type === 'auto:activate' ? action.targets?.[0] : undefined;
  const inst = aimed?.kind === 'card' ? before.instances[aimed.id] : undefined;
  if (inst === undefined || inst.zone !== 'battlefield' || !inst.tapped) return false;
  if (after.step !== before.step || after.turn !== before.turn) return false;
  if (before.stackOrder.length > 0) return false;
  const hadCasts = new Set(
    legalActions(before, seat).plays.filter((p) => p.kind === 'cast').map(playKey),
  );
  if (legalActions(after, seat).plays.some((p) => p.kind === 'cast' && !hadCasts.has(playKey(p)))) {
    return true;
  }
  const underAttack = before.combat.attacks.some((attack) => attack.defender === seat);
  if (underAttack && readyBlockers(after, seat).length > readyBlockers(before, seat).length) {
    return true;
  }
  const beforeTheSwing = before.activeSeat === seat
    && (before.step === 'precombat-main' || before.step === 'declare-attackers');
  if (beforeTheSwing) {
    const swingers = (state: GameState): number =>
      legalAttackers(state, seat).filter((id) => canAttack(state, id, seat) === null).length;
    if (swingers(after) > swingers(before)) return true;
  }
  const doingAbilities = (state: GameState): string[] => legalActions(state, seat).plays
    .filter((p) => p.kind === 'activate' && !pointlessToHandBack(state, p))
    .map(playKey);
  const had = new Set(doingAbilities(before));
  return doingAbilities(after).some((key) => !had.has(key));
}

/**
 * Whether this cast's own number comes out nought — a card spent to choose nothing.
 *
 * The twelfth of the "spent on nothing" family, and the first that is about a *question* rather
 * than a play. Toxic Deluge asks its caster how much life to pay as it resolves, and the card's own
 * answer is nought whenever no number kills more of theirs than of mine. Cast anyway, the spell
 * resolves, the card is in the graveyard, and the board is exactly where it was.
 *
 * The search cannot see that, and the reason is structural rather than a missing term: a cast puts
 * a spell on the *stack*, and the number is not chosen until it resolves, so one ply out the board
 * after the cast is the board before it plus a stack object — which scores the same as any other
 * play that does nothing. **Measured: three of seventeen Deluges across 120 games were cast for
 * nought**, and the other fourteen killed thirty of the opponent's creatures against three of its
 * own, so the number-picking was never the problem. See `NumberDecisionSpec.best`.
 *
 * Asked of the board *now* rather than at resolution, which is the same approximation every rule
 * in this family makes: the bot casts in its own main phase with an empty stack, so "now" and "as
 * it resolves" are the same board unless somebody responds — and a card held for the turn somebody
 * does respond is the card kept, not the card wasted.
 */
function chosenNumberIsNothing(state: GameState, seat: SeatIndex, action: Action): boolean {
  if (action.type !== 'auto:cast') return false;
  const name = state.cardDefs[state.instances[action.card]?.defKey ?? '']?.name;
  const script = name === undefined ? undefined : scriptFor(name);
  if (script?.decisions === undefined) return false;
  return script.decisions.some((spec) => {
    if (!isNumberDecision(spec) || spec.who !== 'controller') return false;
    const best = spec.best?.(state, seat);
    // A card with no opinion is not this rule's business, and neither is one whose range has
    // nothing in it but its own bottom: the test is "the card itself says nought buys this".
    if (best === undefined) return false;
    return best <= spec.range(state, seat).min;
  });
}

/**
 * Whether this action foretells a card (CR 702.143a).
 *
 * Measured, because the answer is more interesting than the rule: over 56 games this bot foretold
 * a **Saw It Coming eight times and a Behold the Multiverse not once**, and the asymmetry is the
 * cards rather than the judgement. A counterspell has no sorcery-speed use, so on the turn its
 * controller has spare mana it is the only thing to spend it on and the foretell is taken. A Behold
 * the Multiverse is castable on any turn there is mana for it, so there is always something better
 * to do with {2} than hide it.
 *
 * Which means foretell helps this bot on exactly the card the mechanic was printed for — the one it
 * otherwise has to hold mana for, which is the thing three separate measurements say it cannot do.
 */
const foretells = (state: GameState, action: Action): boolean =>
  action.type === 'auto:foretell' && state.instances[action.card] !== undefined;

/**
 * Whether the mana a foretell would spend was going spare anyway.
 *
 * The question the board can answer, where "is a cheaper spell next turn worth two mana now" is
 * the question it cannot. A foretell is right when this seat has mana it is not going to use: every
 * other play has been made or is unaffordable, and the two mana would otherwise empty at the end of
 * the step (CR 500.4).
 *
 * Asked by counting what else there is to do rather than by scoring it, because the scoring is
 * exactly what fails here — `simulate` ends with the stack empty and the payoff is a turn away. A
 * seat with a creature it could cast casts the creature; a seat holding nothing castable but a
 * foretell takes the foretell.
 *
 * Deliberately conservative in one direction: it will not foretell to *hide* a card, which is the
 * other half of why a person does it. That is information warfare and this bot has no model of what
 * an opponent knows.
 */
function foretellIsSpareMana(state: GameState, seat: SeatIndex, action: Action): boolean {
  if (action.type !== 'auto:foretell') return false;
  const plays = legalActions(state, seat).plays;
  /*
    Anything else worth doing with the mana, where "else" means **another card**.

    Lands are excluded because the land drop is offered and taken before the search, and mana abilities
    because tapping for mana is not spending it. The clause that matters is the third: every play on
    *this* card is excluded, its own ordinary cast included, because the question is whether the
    mana has a better home and casting the card now is the thing being compared against rather than
    a reason not to compare.

    The first version excluded only the foretells, which left a card's own cast in the list and made
    the rule say "never foretell something you could cast". That is wrong reasoning, and fixing it
    **changed nothing measurable**: 8 foretells of Saw It Coming and 0 of Behold the Multiverse
    over 56 games, before and after. The reason is in the cards rather than in the rule — see the
    note on `foretells` above and D127. The fix stays because the condition now says what it means.
  */
  const others = plays.filter((play) =>
    play.card !== action.card && play.kind !== 'land' && !play.isManaAbility);
  return others.length === 0;
}

/**
 * Whether this card can counter a **spell**, which is what "an answer" means to the rule below.
 *
 * Two words rather than one: "counter target" catches Squelch, whose target is an activated or
 * triggered *ability* and which therefore cannot answer a spell at all — and holding mana up for a
 * card that cannot be cast at the moment it is wanted is the one way the reservation rule costs its
 * own deck something. Read off the oracle text for the reason the whole family is: a card added to
 * the pool tomorrow is covered without anybody coming back here.
 *
 * It stays a text match rather than a look at the card's `targets` spec, because the spec says what
 * the *engine* will offer and this question is asked on a turn where the engine offers nothing —
 * the counterfactual D168 is built around.
 */
function canCounterASpell(def: CardDef): boolean {
  const text = def.oracleText ?? '';
  return /counter target/i.test(text) && /counter target[^.]*spell/i.test(text);
}

/**
 * The cheapest answer in this seat's hand that it could pay for right now, or null.
 *
 * "An answer" is a card that can counter a **spell** — the five hard counters, the two conditional
 * ones, Soul Manipulation's first mode. Matched on the oracle text rather than a list of names so
 * that a card added to the pool tomorrow is covered without anybody remembering to come back here,
 * and Chalice of the Void's "counter it" is deliberately not matched: a permanent that answers
 * spells by sitting there is not something anybody holds mana for.
 *
 * **A spell, not an ability, and that word is the narrowing D170 asked for.** The first version of
 * this matched "counter target" and so counted **Squelch**, which counters an activated or
 * triggered ability and can do nothing at all about a spell. `held-answers.mjs` priced the mistake:
 * 11 of Squelch's 17 windows in Arc Tempest ended in *nothing to point at*, which is the one column
 * where this rule costs its deck something — mana held up on its own turn for a card that was never
 * going to be castable. The rule exists to hold mana for an answer to a spell, so it now only
 * counts cards that can answer one.
 *
 * Affordability is asked of `canAfford` — the same solver `legalActions` and the payment both use,
 * so this cannot disagree with them about a dual land. It is asked *without* a target, which is
 * the whole reason this cannot be read off `legalActions().plays`: on its controller's own turn
 * with an empty stack a counterspell has nothing to point at, so the engine correctly refuses to
 * offer it and the question "could you pay for this if a spell arrived" is not one the offer
 * answers.
 */
function affordableAnswerInHand(state: GameState, seat: SeatIndex): ManaCost | null {
  let cheapest: ManaCost | null = null;
  const sources = manaSources(state, seat);
  const pool = poolOf(state, seat);
  for (const id of listAt(state, zoneKey(seat, 'hand'))) {
    const def = state.cardDefs[state.instances[id]?.defKey ?? ''];
    if (def === undefined || !canCounterASpell(def)) continue;
    const cost = parseManaCost(def.manaCost);
    if (!canAfford(pool, cost, sources)) continue;
    if (cheapest === null || costValue(cost) < costValue(cheapest)) cheapest = cost;
  }
  return cheapest;
}

/**
 * Whether making this play would spend the mana an answer in hand is waiting for.
 *
 * **The thirteenth of the drop-this-option family, and the one with the longest history behind
 * it.** Two earlier attempts at the same idea were *evaluation terms* — a point for each untapped
 * land while the hand held something castable at instant speed (D68), and an answer in hand priced
 * above a generic card (D69) — and both were deleted after measuring level or worse. The corrected
 * conclusion written beside them is a claim about mechanism rather than about weights: *"it is
 * often tapped out when the moment comes, and valuing untapped mana does not fix that."*
 *
 * `held-answers.mjs` measured that claim and it is an understatement. Of every moment an opponent
 * had a spell on the stack and this bot held a counterspell, across 144 games each, with this rule
 * off:
 *
 * | deck | windows | cast | the other card | **declined** | never offered | **no mana** | no target |
 * | --- | --- | --- | --- | --- | --- | --- | --- |
 * | Tidal Mind | 229 | 7% | 0% | **0%** | 0% | **87%** | 6% |
 * | Arc Tempest | 151 | 12% | 0% | **3%** | 0% | **77%** | 8% |
 * | Skyward Writ | 218 | 30% | 7% | **0%** | 1% | **54%** | 8% |
 *
 * So this is not a judgement problem — over 229 of Tidal Mind's windows it declined an affordable
 * answer not once, so it almost never gets to *make* the bad choice. It is a
 * tempo problem, and it has a precise shape — a seat that taps out in its own main phase has no
 * mana for the whole of the opponent's turn, because lands untap in their controller's own untap
 * step. The severity tracks the counter's cost exactly: Skyward Writ's {U}{U} Counterspell is cast
 * in 30% of its windows, where Tidal Mind's {1}{U}{U} Disallow was cast **4 times** against **118**
 * windows it could not pay for.
 *
 * With the rule on, Tidal Mind casts one in 44% of them and could not pay in 41%. The two middle
 * columns are the correction D168 carries: `declined` once counted windows another answer in the
 * same hand had already covered, and windows this seat was never actually offered, and both read
 * as judgement when neither was. The genuine declines are six of 208, and D170 is why no filter
 * was written for them.
 *
 * Which is why this is a filter and not a term. A weight can only say "untapped mana is worth a
 * little", and the search then spends it anyway on whatever is worth more right now — correctly,
 * because the thing the mana is *for* is on the far side of the search horizon. A filter says "not
 * that one", and leaves every other play on the table.
 *
 * Four conditions keep it narrow:
 *
 *   - **This seat's own turn, at sorcery speed.** Responding is what the mana was saved for, so a
 *     play made with something on the stack is never dropped.
 *   - **The cheapest answer only.** A hand with a Cancel and a Disallow reserves for the Cancel;
 *     keeping three sources up for the expensive one is the behaviour that would tax the deck most
 *     and buy the least.
 *   - **Affordable before, unaffordable after.** A play that leaves the answer payable is not
 *     dropped, so the rule costs nothing on a turn with mana to spare — which is most turns late
 *     in a game and no turns early in one.
 *   - **Never the answer itself**, and never a land: the land drop is taken before the search and
 *     adds mana rather than spending it.
 *
 * If every option is dropped the loop's own fallback passes, which is this rule working: a turn
 * spent holding two mana is what a person does with a Counterspell in hand.
 *
 * **It is only ever as good as the payment, and the payment is not trying to help it.** The engine
 * taps to pay the cost in front of it and has no opinion about what is being held back, so with
 * three Islands and two Swamps a {1}{U} creature can be paid for with two Islands — leaving one
 * blue source where a {1}{U}{U} answer needs two, and this rule then drops a play that a smarter
 * payment would have allowed. That is a real narrowing rather than a bug: the rule errs towards
 * holding the answer, which is the direction it exists to err in. A payment solver that preferred
 * to leave a named cost payable is a separate piece of work, and the first place it would show up
 * is here.
 */
function spendsAnAnswersMana(
  state: GameState, after: GameState, seat: SeatIndex, action: Action,
): boolean {
  if (action.type !== 'auto:cast' && action.type !== 'auto:activate') return false;
  if (state.activeSeat !== seat || state.stackOrder.length > 0) return false;
  const def = state.cardDefs[state.instances[action.card]?.defKey ?? ''];
  if (def !== undefined && canCounterASpell(def)) return false;
  /*
    Nobody to answer, which is the one case where this rule is pure tax.

    A counterspell answers a *spell*, and a player with no cards in hand is not going to cast one.
    Hand sizes are public, so this is a fact the bot is allowed to read rather than a guess about
    what they hold. It matters most exactly where the rule is most expensive: the fastest decks in
    this pool empty their hands by about turn six, so without this clause a control deck spends the
    rest of those games holding two mana up against a player who has nothing left to hold it for.
  */
  if (foesOf(state, seat).every((foe) => listAt(state, zoneKey(foe, 'hand')).length === 0)) {
    return false;
  }
  const cost = affordableAnswerInHand(state, seat);
  if (cost === null) return false;
  return !canAfford(poolOf(after, seat), cost, manaSources(after, seat));
}

/** Whether this action activates a crew ability (CR 702.122a). */
function crewsAVehicle(state: GameState, action: Action): boolean {
  if (action.type !== 'auto:activate') return false;
  const name = state.cardDefs[state.instances[action.card]?.defKey ?? '']?.name;
  return scriptFor(name)?.abilities?.[action.abilityIndex ?? 0]?.cost.crew !== undefined;
}

/**
 * Whether crewing this Vehicle puts more power into the combat than it takes out of it.
 *
 * The arithmetic the evaluation cannot do. After a crew the Vehicle really is a creature, so
 * `simulate` scores a board with one more attacker on it and nothing at all for the two creatures
 * now lying sideways — the cost is invisible in exactly the way a wasted mana is.
 *
 * Only the creatures that **could have attacked** are counted as a cost, which is the half that
 * makes this a fact about the board rather than a weight. A creature that arrived this turn, or is
 * already tapped, or cannot attack, was not going into this combat anyway: tapping it to crew is
 * offered, and a Vehicle crewed by summoning-sick creatures is the best thing that can happen to a
 * deck that just emptied its hand.
 *
 * Power rather than a fuller measure of what a creature is worth, deliberately: the question is
 * about one combat, and the thing this rule exists to stop is trading four power of attackers for
 * four power of Vehicle. An evasive Vehicle is worth more than its power says and this rule does
 * not know it — Sky Skiff flies, and against a ground board its two power is worth more than two
 * untapped 1/1s. That is a real limitation and the reason the comparison is strict rather than
 * generous: it declines the trades that are level.
 */
function crewBuysMoreThanItCosts(state: GameState, seat: SeatIndex, action: Action): boolean {
  if (action.type !== 'auto:activate') return false;
  const inst = state.instances[action.card];
  if (inst === undefined) return false;
  const name = state.cardDefs[inst.defKey]?.name;
  const need = scriptFor(name)?.abilities?.[action.abilityIndex ?? 0]?.cost.crew;
  if (need === undefined) return false;
  const plan = crewPlan(state, seat, need, action.card);
  if (plan === null) return false;
  const cost = plan.reduce((total, id) => {
    const creature = state.instances[id];
    if (creature === undefined) return total;
    // Could it have attacked? If not, tapping it costs this combat nothing.
    if (canAttack(state, id, seat) !== null) return total;
    return total + characteristicsOf(state, creature).power;
  }, 0);
  return characteristicsOf(state, inst).power > cost;
}

/** Whether this action casts a card whose point is to become a copy of a creature. */
function castsACopy(state: GameState, action: Action): boolean {
  if (action.type !== 'auto:cast') return false;
  const name = state.cardDefs[state.instances[action.card]?.defKey ?? '']?.name;
  return name !== undefined && scriptFor(name)?.copiesACreature === true;
}

/**
 * Whether there is anything on the table to copy.
 *
 * Any creature, anybody's — a Clone copies "any creature on the battlefield", and copying the
 * opponent's best one is what the card is for. Asked of the board rather than of the state after
 * the cast, for the reason the whole family exists: with auto-pass on, the state after a cast can
 * be a turn later, and by then the 0/0 has died and the position has moved on.
 */
function somethingToCopy(state: GameState): boolean {
  for (const seat of state.seats) {
    for (const id of listAt(state, zoneKey(seat.index, 'battlefield'))) {
      const inst = state.instances[id];
      if (inst !== undefined && characteristicsOf(state, inst).isCreature) return true;
    }
  }
  return false;
}

/** Whether this action casts a card whose whole effect is to remove a creature. */
function castsRemoval(state: GameState, action: Action): boolean {
  if (action.type !== 'auto:cast') return false;
  const name = state.cardDefs[state.instances[action.card]?.defKey ?? '']?.name;
  return name !== undefined && scriptFor(name)?.removesACreature === true;
}

/**
 * Whether there is a creature on the table that this seat does not control.
 *
 * The question a removal spell is cast for. Any opponent's, which is what matters at a four-player
 * table: a Doom Blade is worth casting for somebody else's creature whoever is attacking whom.
 * Asked of the board rather than of the state after the cast, like every other rule in this family.
 */
function somethingToRemove(state: GameState, seat: SeatIndex): boolean {
  for (const other of state.seats) {
    if (other.index === seat || other.eliminated) continue;
    for (const id of listAt(state, zoneKey(other.index, 'battlefield'))) {
      const inst = state.instances[id];
      if (inst !== undefined && characteristicsOf(state, inst).isCreature) return true;
    }
  }
  return false;
}

/**
 * Whether this cast would destroy a permanent its own controller controls.
 *
 * The fifteenth of the drop-this-option family, and the one an instrument found rather than a
 * suspicion: `creature-fate.mjs` followed every creature Blight Vector put onto the battlefield and
 * reported that **6% of them were killed by the deck's own Naturalize**. Which is exactly what the
 * card does if you aim it badly: "destroy target artifact or enchantment" is legal against an
 * *artifact creature*, and that deck's Plague Stingers and Ichorclaw Myrs are artifact creatures.
 * With no artifact or enchantment of the opponent's on the table, the only legal targets the engine
 * can offer are its own, and the search took one: a card spent to kill its own 1/1.
 *
 * `removesACreature` already stops a Doom Blade being cast with nothing of theirs to point at
 * (D89). This is the other half of the same mistake, and it has to be about the *target* rather
 * than about the card, because a Naturalize with a real target is a fine card and the same spell
 * is both.
 *
 * **A text match rather than a flag**, for D173's reason: the card's own words are what say whether
 * it destroys, and every "Destroy target …" in the pool means it. Nothing printed here wants to
 * destroy its own permanent — there is no Oblivion Ring, no "destroy target permanent you control"
 * — so the rule is unconditional. The day a card wants it (a symmetric enchantment its own
 * controller is losing to, say), this is the line to narrow.
 */
function destroysOneOfItsOwn(state: GameState, seat: SeatIndex, action: Action): boolean {
  if (action.type !== 'auto:cast') return false;
  const def = state.cardDefs[state.instances[action.card]?.defKey ?? ''];
  if (def === undefined || !/destroy target/i.test(def.oracleText ?? '')) return false;
  return (action.targets ?? []).some((target) => {
    if (target.kind !== 'card') return false;
    const inst = state.instances[target.id];
    return inst !== undefined && inst.zone === 'battlefield' && inst.zoneSeat === seat;
  });
}

/** Whether this action casts a spell whose whole effect is keeping one of your creatures alive. */
function castsAProtection(state: GameState, action: Action): boolean {
  if (action.type !== 'auto:cast') return false;
  const name = state.cardDefs[state.instances[action.card]?.defKey ?? '']?.name;
  return name !== undefined && scriptFor(name)?.protectsACreature === true;
}

/**
 * Whether one of this seat's creatures is in any danger a trick could answer.
 *
 * Two shapes, because the cards have two uses. Something on the stack aimed at a creature of mine
 * is the one the card is printed for — hexproof in response makes the removal miss. And a combat
 * one of my creatures is in is the other: +2/+2 wins a fight, and the search can judge *that* for
 * itself once the board says the fight exists.
 *
 * Asked of the board before the cast, not of the state after it. With auto-pass on, a spell
 * nobody can respond to resolves inside the same action and the engine keeps passing, so the state
 * after a cast can be a step or a turn later — which is the mistake the Fog rule made first and
 * the ritual rule made before that.
 */
function creatureOfYoursIsThreatened(state: GameState, seat: SeatIndex): boolean {
  for (const id of state.stackOrder) {
    const object = state.stackObjects[id];
    if (object === undefined || object.controller === seat) continue;
    for (const target of object.targets) {
      if (target.kind !== 'card') continue;
      const inst = state.instances[target.id];
      if (inst === undefined || inst.zone !== 'battlefield' || inst.zoneSeat !== seat) continue;
      if (characteristicsOf(state, inst).isCreature) return true;
    }
  }
  const fighting = state.step === 'declare-attackers'
    || state.step === 'declare-blockers'
    || state.step === 'first-strike-damage';
  if (!fighting) return false;
  return state.combat.attacks.some(
    (attack) => attack.defender === seat || state.instances[attack.attacker]?.zoneSeat === seat,
  );
}

/**
 * Whether this action casts a spell whose whole effect wears off at end of turn.
 *
 * Per mode as well as per card: a charm's pump mode wears off and its removal mode does not, and
 * holding a Selesnya Charm back for a combat you are not in would be wrong for the other two
 * thirds of the card.
 */
function castsAnExpiringPump(state: GameState, action: Action): boolean {
  if (action.type !== 'auto:cast') return false;
  const name = state.cardDefs[state.instances[action.card]?.defKey ?? '']?.name;
  const script = name === undefined ? undefined : scriptFor(name);
  if (script === undefined) return false;
  if (script.expiresAtEndOfTurn === true) return true;
  return modesOf(script, action.modes).some((mode) => mode.expiresAtEndOfTurn === true);
}

/**
 * Whether a bonus that wears off tonight can still earn its keep today.
 *
 * Not "is a pump good" — "is there anything better to do with it than cast it right now". Three
 * ways there is not:
 *
 *  - something on the stack is pointing at one of my creatures, so the pump may save it;
 *  - a combat is happening that one of my creatures is in, which is what the card is printed for;
 *  - it is a **sorcery** in my precombat main with something that can attack, because a sorcery
 *    cannot wait for blockers — there is no later this turn, and the Overrun line is exactly this.
 *
 * Everything else — an upkeep, a draw step, a main phase with an instant in hand — is a card spent
 * two steps before the question it answers. 59 of 95 measured casts were in an upkeep or a draw
 * step, before the caster had played a land.
 */
function expiringPumpCanMatter(state: GameState, seat: SeatIndex, action: Action): boolean {
  if (creatureOfYoursIsThreatened(state, seat)) return true;
  if (state.step !== 'precombat-main' || state.activeSeat !== seat) return false;
  const inst = action.type === 'auto:cast' ? state.instances[action.card] : undefined;
  const types = parseTypeLine(state.cardDefs[inst?.defKey ?? '']?.typeLine);
  // An instant can wait for blockers; only a sorcery has to be cast before the attack it helps.
  if (!hasType(types, 'sorcery')) return false;
  // `legalAttackers`, not `legalActions(...).attackers`: that field is only filled in while a
  // declaration is owed, so in a main phase it is always empty — which is how the first version
  // of this clause took Overrun from 23 casts a hundred-and-sixty games to none at all.
  return legalAttackers(state, seat).some((id) => canAttack(state, id, seat) === null);
}

/**
 * Whether this action casts a spell whose whole effect is goading other people's creatures.
 *
 * The fifth of the "spent on nothing" family, and the only one whose answer is about the number of
 * seats. Goad sends a creature at somebody *other than you*; with one opponent there is nobody
 * else, so the whole card becomes "their creatures now have to attack me".
 */
function castsAGoad(state: GameState, action: Action): boolean {
  if (action.type !== 'auto:cast') return false;
  const name = state.cardDefs[state.instances[action.card]?.defKey ?? '']?.name;
  return name !== undefined && scriptFor(name)?.goadsOpponents === true;
}

/** Whether goading could send anything anywhere but back at this seat. */
function goadHasSomewhereToSend(state: GameState, seat: SeatIndex): boolean {
  return state.seats.filter((s) => s.index !== seat && !s.eliminated).length > 1;
}

/** Whether this action casts a spell whose whole effect is mana. */
function castsARitual(state: GameState, action: Action): boolean {
  if (action.type !== 'auto:cast') return false;
  const name = state.cardDefs[state.instances[action.card]?.defKey ?? '']?.name;
  return name !== undefined && scriptFor(name)?.makesMana === true;
}

/** One play, identified well enough to tell "this is new" from "this was already on offer". */
const playKey = (play: LegalPlay): string =>
  `${play.kind}|${play.card}|${play.abilityIndex ?? ''}|${play.kicked === true ? 'k' : ''}`
  // And evoke, for the same reason as the kicker: the two castings of a Mulldrifter are two
  // plays, and a key that could not tell them apart would read the expensive one as still on
  // offer after the cheap one had been cast.
  + `${play.evoked === true ? 'e' : ''}${play.dashed === true ? 'd' : ''}`
  + `${play.bestowed === true ? 'b' : ''}${play.spectacled === true ? 's' : ''}`
  + `${play.overloaded === true ? 'o' : ''}`
  // The half, because two halves of one card are two different plays: without it the "did casting
  // that buy me anything" checks would read Ice as still on offer after Fire had been cast.
  + `|${play.half ?? ''}|${(play.modes ?? []).join(',')}`;

/**
 * Whether casting a ritual actually bought this seat a spell.
 *
 * The question a ritual asks, and the only thing it can be for. Dark Ritual's whole effect is
 * mana, mana empties at the end of the step (CR 500.4), and the search cannot see any of that: by
 * the evaluation the card simply left the hand. Measured over 120 unsteered games before the bot
 * knew — **cast 35 times, followed by a spell in the same step 3 times.**
 *
 * Asked as "is there a new cast" rather than priced as a weight, deliberately. Four attempts to
 * express a judgement like this as a number in `evaluate` have been measured and deleted (see
 * `claude/decisions-log.md`, D70): a sum of material cannot say "worth more later than now". This
 * is not that judgement. It is the same kind of rule as "do not cast an X spell for X=0" and "do
 * not eat a better creature than the one you are feeding it to" — a card spent on nothing, which
 * is a fact about the line rather than an opinion about the position.
 *
 * Two things it has to get right, both found by instrumenting a version that got them wrong.
 *
 * The step is checked first, because **a simulated line does not stop where the action does.**
 * With auto-pass on, a spell nobody can respond to resolves inside the same action and the engine
 * keeps passing for any seat with nothing to do — so the state `simulate` returns can be a step or
 * a turn later, with the pool long since emptied. A line that has left the step is precisely the
 * case this rule is for: nothing was done with the mana, which is why the step was allowed to end.
 *
 * And the comparison is between *plays*, not pools, because within the step the pool is exactly as
 * big as the ritual made it whether or not anything in hand can use it. The first version of this
 * compared pool sizes, and changed nothing at all — identical records, casts and follow-ups over
 * 84 paired games, because the two conditions it tested were the two that are always true.
 *
 * **Measured, paired on seeds, Ashen Rite against the other six decks, 240 games per arm and then
 * 240 more on a fresh seed set:**
 *
 * | | casts | followed by a spell | left in hand | Ashen Rite's record |
 * | --- | --- | --- | --- | --- |
 * | without | 164 | 17 (10%) | 7 | 92-148 |
 * | with | 124 | **115 (93%)** | 44 | 89-151 |
 * | without, fresh seeds | 148 | 20 (14%) | 5 | 110-130 |
 * | with, fresh seeds | 107 | **102 (95%)** | 45 | 118-122 |
 *
 * So: the card does its job nine times in ten instead of one, and the record moves by three games
 * one way and eight the other — nothing, which is the honest answer for two cards out of sixty.
 * Kept for the first column, not the last: a bot that casts a Dark Ritual and then does nothing
 * with it looks broken to the person sitting opposite, and that is worth more here than a win rate.
 *
 * The 18-game swing between two seed sets of the *same* configuration is worth remembering on its
 * own — the earlier sweeps in `claude/decisions-log.md` ran 84 games, where a 3-game difference is
 * indistinguishable from nothing.
 *
 * One hypothesis about the three games was measured and refuted rather than written up as a cause:
 * that a hand holding unspendable rituals would discard real cards at cleanup, because the discard
 * rule pitches the most expensive card. Over those 240 games there were 18 cleanup discards, 12 of
 * them with a ritual in hand, and **not one ritual discarded** — far too few to matter either way.
 */
function ritualBoughtSomething(before: GameState, after: GameState, seat: SeatIndex): boolean {
  if (after.step !== before.step || after.turn !== before.turn) return false;
  const had = new Set(
    legalActions(before, seat).plays.filter((p) => p.kind === 'cast').map(playKey),
  );
  return legalActions(after, seat).plays.some((p) => p.kind === 'cast' && !had.has(playKey(p)));
}

/**
 * The total power this seat could swing with, ignoring whose turn it is.
 *
 * A rough reach rather than a real attack: it is asked at a moment that may be nobody's combat, so
 * the question it answers is "do I have the board to kill you", not "can I kill you this turn".
 */
function openPower(state: GameState, seat: SeatIndex): number {
  let total = 0;
  for (const id of legalAttackers(state, seat)) {
    total += Math.max(0, characteristicsOf(state, state.instances[id]!).power);
  }
  return total;
}

/**
 * Answering a deal this seat was offered (see `GameState.pacts`).
 *
 * One rule: take it, unless the player offering it is already dead on the board. A bot that can
 * swing for somebody's whole life total and signs a truce instead is a bot that throws games
 * away, and a player who offers a deal while at four life against a swarm is asking to be let off
 * rather than offering anything — so that one gets declined and everything else gets accepted.
 *
 * It is this crude deliberately. The honest version of "is this deal good for me" needs the thing
 * the bot does not have: a model of what the other player does *next*, which is the same two-ply
 * search named in D108 as the limit on the shield half of prevention. Until that exists, a bot
 * that keeps every deal it takes (see `keepsItsWord`) and takes nearly every deal offered is
 * predictable, which is worth more at a table than clever would be.
 *
 * And it never offers one. Offering is the half of a pact a search genuinely cannot price: what it
 * buys is somebody else's future behaviour, and nothing in here models that at all. A bot that
 * offered deals it had no way to value would be making noise at the table, which is worse than
 * silence.
 */
function answerPact(state: GameState, seat: SeatIndex): Action | null {
  // The oldest offer first, which is the order they were made in: `state.pacts` is append-ordered.
  const offer = state.pacts.find((p) => p.status === 'offered' && p.to === seat);
  if (offer === undefined) return null;
  const accept = openPower(state, seat) < (state.seats[offer.from]?.life ?? 0);
  return { type: 'pact:respond', by: seat, pact: offer.id, accept };
}

export function botAction(state: GameState, seat: SeatIndex, opts: BotOptions = {}): Action | null {
  if (!state.automated || state.finished) return null;
  if (state.openingHands) {
    return state.kept.includes(seat) ? null : settleOpeningHand(state, seat);
  }
  const actions: LegalActions = legalActions(state, seat);

  // A card that stopped mid-resolution to ask this seat something blocks everything, including
  // the player whose spell it is, so it is answered before anything else is even considered.
  const ask = actions.mustDecide;
  if (ask !== null) return decideAction(state, seat, ask);

  // A trigger waiting for its targets blocks everything else, so it is answered next.
  const choice = actions.mustChoose;
  if (choice !== null) return aimPending(state, seat, choice);

  /*
    A ward, paid whenever it can be.

    The cheap rule, and the one the shape of this bot makes right rather than merely convenient.
    Declining throws the whole card away: the spell is already cast and its own cost already paid,
    so the only thing the ward mana buys is whatever else this seat would have done with it this
    turn — and this bot casts greedily down its curve, so by the time a ward is on the table there
    is usually nothing left it was saving for. `settlePayment` has already handled the case where
    the cost cannot be met, so reaching here means paying is available.

    What it cannot weigh is the case where the mana was worth more than the spell: holding two up
    for a counterspell is the example, and it is the same thing the search has never been able to
    price (D110). Worth revisiting when there is an evaluation that can, and measured as it stands:
    over a pod soak the bot declined a ward zero times, which is this rule being honest about what
    it is rather than evidence that it is right.
  */
  const ward = actions.mustPay;
  if (ward !== null) return { type: 'auto:pay', by: seat, pay: true };

  if (actions.mustDiscard > 0) {
    /*
      A madness card first, because discarding it is how it gets cast (see `madnessToPitch`), and
      otherwise the most expensive thing — the card least likely to be castable.
    */
    const hand = handByCost(state, seat);
    const pitch = madnessToPitch(state, seat, hand.map((card) => card.id)) ?? hand[0]?.id;
    return pitch === undefined ? null : { type: 'auto:discard', by: seat, card: pitch };
  }

  /*
    A deal on the table, answered before anything the rules are waiting on.

    Before the declaration deliberately: a truce accepted in the middle of the attack step changes
    who this seat may attack, so answering after declaring attackers would be answering a question
    that had already been decided. Nothing in the engine gates a pact on priority or on a step,
    which is what makes this ordering available.
  */
  const deal = answerPact(state, seat);
  if (deal !== null) return deal;

  const owed = pendingDeclaration(state);
  if (owed !== null && owed.seats.includes(seat)) {
    return declareBySearch(state, seat, owed.kind, opts);
  }

  /*
    An offered cast on offer holds no priority, and is the one play made without it (CR 702.85a).

    Let past this guard rather than answered above it, because unlike every other question that
    stops the table this one is a *play*: `legalActions` has already narrowed `plays` to the casts
    of the one card on offer, so everything below — the aimings, the search, the scoring — works on
    it unchanged, and the bot picks a target for a cascaded Lightning Bolt the same way it picks
    one for a Lightning Bolt in hand.

    Declining falls out of the same machinery: `candidateActions` returns nothing when there is no
    legal way to cast the card, and the line below answers that with a pass — which is what a
    decline is. What the search will not do is weigh casting against declining, because it has no
    baseline for doing nothing (see the note below); a free spell is nearly always worth casting,
    and a bot that threw one away on a bad target would be making the same mistake it makes with a
    paid one rather than a new one.
  */
  if (!actions.hasPriority && actions.mustCastOffered === null) return null;

  /*
    One move ahead.

    Everything above this line is a rule — answer the question, declare the blockers — and has one
    right answer. Which spell to cast is not like that: it is a judgement, and until now the bot
    made it by preferring the most expensive thing it could afford, which is how it came to cast
    a Hurricane that killed its own board and point a Shock at a 1/1 while a 5/5 attacked it.

    So: build every play it could make, *play each one out* far enough to see what happens, and
    keep the position it likes best. Doing nothing is one of the options, which is what makes the
    bot capable of holding a card back rather than spending it on nothing.

    It is one ply and no further, and that is now a measurement rather than a plan. The reply was
    built — each other seat answering inside the simulated line, greedily, gated on having
    something to answer and the mana to do it with — and it is level: 120-120 over 240 paired duels
    on identical seeds, at a quarter more time per decision in a pod. It changed real decisions (it
    declines to attack a Serra Angel into an untapped Doom Blade, which this bot does attack) and
    won nothing by it. See `claude/decisions-log.md`, D110, which also records why it should not be
    kept even if it had won: `botAction` takes the whole state, so a reply reads the opponent's hand
    and the bot plays around a card it cannot see. The honest version reasons from `viewFor` plus a
    model of what the deck could hold, which is a different piece of work from a deeper search.
  */
  /*
    The land drop is a rule, not a judgement.

    It is taken before the search and never weighed against anything, for the same reason the old
    ranking gave it a thousand: a land costs nothing, there is one a turn, and a turn without one
    is a turn behind for the rest of the game. Leaving it in the search was worse than wrong, it
    was invisible — a land is one card out of your hand for one permanent on the board, so any
    margin big enough to stop the bot wasting a Shock also stopped it playing lands, and it lost
    every game in the measurement while looking like a tuning problem.

    Between two lands it plays the one that is ready now: a land that enters tapped is better
    played on a turn whose mana was not going to be spent anyway.
  */
  const lands = actions.plays.filter((p) => p.kind === 'land');
  if (lands.length > 0) {
    /*
      Between two lands it plays the one that is ready now, and that is the only tie-break here.

      A second one was tried and reverted: play a land with **morph** last, because Zoetic Cavern
      is a land *or* a {3} 2/2 and spending it as a land while an Island is in hand throws the
      choice away for nothing. The reasoning is sound and the measurement is not — over two seed
      sets of 168 games it moved the number of face-down Cavern casts from 1 to 2 and from 3 to 4.
      Three casts in 336 games is not a change this instrument can price, so the branch came out
      and the number went into `claude/decisions-log.md` (D123) instead.

      The cause is upstream of any tie-break: the land drop is taken *before* the search, because
      leaving it in lost every game in the measurement (see above), so the bot never weighs the
      Cavern's two halves against each other at all. Its face-down half is a person's option rather
      than the computer's, and that is worth writing down rather than papering over.
    */
    /*
      The face, not the card, because a modal double-faced card's land is on its **back**: reading
      `entersTapped` off the front face says "ready now" about a tapped land, and the tie-break then
      plays the flexible card over the basic that was offered. The same lookup also keeps a Hagra
      Mauling in hand while an untapped Swamp is there, which is what the card is for.
    */
    const landDef = (p: LegalPlay): CardDef | undefined => {
      const card = state.cardDefs[state.instances[p.card]!.defKey];
      return p.half === undefined ? card : card?.faces?.cards[p.half];
    };
    const ready = lands.find((p) => scriptFor(landDef(p)?.name)?.entersTapped !== true);
    const chosen = ready ?? lands[0]!;
    return {
      type: 'auto:playLand', by: seat, card: chosen.card,
      // Which face, for the reason every other half-carrying action says so: without it the engine
      // is told to play the *front* of the card as a land, and refuses the play it just offered.
      ...(chosen.half === undefined ? {} : { half: chosen.half }),
    };
  }

  const options = candidateActions(state, seat, actions);
  if (options.length === 0) return { type: 'auto:pass', by: seat };
  if (opts.lookahead === false) return options[0]!.action;

  /*
    The best of them, and no baseline for doing nothing.

    The first version weighed every play against the position as it stood, so a play had to be
    better than passing by a margin — the obvious way to stop a bot spending a Shock on a 1/1. It
    was measurably wrong. Against the shallow bot it won 28 games of 60 with a one-point margin and
    40 of 60 with none at all, and the reason is that the evaluation cannot see what holding a card
    buys: a card kept is a card scored, while the tempo it cost is invisible. So the discipline it
    bought was imaginary and the turns it wasted were real.

    What the search is for, then, is *which* play rather than *whether* to play: the best creature,
    the right target, the mode that does something. That it finds, and the measurement says so.
  */
  /*
    `null` rather than `options[0]` to begin with, which is the whole point of the rule below.

    The first version of the ritual rule `continue`d past a ritual that bought nothing and changed
    *nothing at all* — identical records, casts and follow-ups over 84 paired games — because
    `best` was seeded with the first option and a loop that skipped every option returned it
    anyway. The filter fired on exactly the lines it was meant to; it just had no way to say "none
    of these".
  */
  let best: Action | null = null;
  let bestScore = -Infinity;
  let dropped = 0;
  for (const option of options) {
    const after = simulate(state, option.action, stopsAtAction(opts));
    if (after === null) continue;
    /*
      A ritual with nothing to spend it on is not a play.

      The one case this still gets wrong is a chain: the spell it buys may be a second copy of the
      ritual, which the next decision then drops on its own terms — so the first was cast on a
      promise that is not kept. Rare, and cheaper than teaching the search to look two plays deep.
    */
    if (castsARitual(state, option.action) && !ritualBoughtSomething(state, after, seat)) {
      dropped += 1;
      continue;
    }
    // And the same judgement for a Fog with nothing attacking. Not a weight: a card that prevents
    // damage nobody is dealing has done nothing at all, which is a fact about the board.
    if (castsAPrevention(state, option.action) && !preventionCanMatter(state, seat, option.action)) {
      dropped += 1;
      continue;
    }
    /*
      And the same again for a protection trick with nothing to protect against.

      The third card in the family, and the one the search was worst at: 64 cast across 160 games,
      60 of them with an empty stack and no combat, each one a card spent to make a creature bigger
      until end of turn for no reason. Dropping those does not only stop the waste — it leaves the
      card in hand for the moment it is for, which is the only moment the search can tell "cast it"
      from "pass".
    */
    // The eighth: a land turned into a creature with nothing to attack or block. See
    // `animationCouldMatter` for the 854 presses that bought nothing.
    if (animatesSomething(state, option.action) && !animationCouldMatter(state, seat, option.action)) {
      dropped += 1;
      continue;
    }
    if (castsAProtection(state, option.action) && !creatureOfYoursIsThreatened(state, seat)) {
      dropped += 1;
      continue;
    }
    /*
      And the last of the family: a bonus that wears off tonight, spent this morning.

      The widest of the four measurements. Five pumps, 95 casts across 160 games, **none of them
      during a combat** and 59 in the caster's own upkeep or draw step. The search cannot see it —
      `simulate` stops when the stack empties, so "+3/+3 until end of turn" is a creature that is
      bigger *now* and the combat is past the horizon — and no weight fixes that, because the
      creature really is bigger. What the board can say is whether there is a better moment
      coming, which is a fact.
    */
    if (castsAnExpiringPump(state, option.action)
      && !expiringPumpCanMatter(state, seat, option.action)) {
      dropped += 1;
      continue;
    }
    /*
      And removal with nothing to remove, which ends up pointed at its own board.
    */
    if (castsRemoval(state, option.action) && !somethingToRemove(state, seat)) {
      dropped += 1;
      continue;
    }
    /*
      And an Equipment moved from one creature to another that is no bigger, which is the shell
      outside D35's "not the creature it is already on". See `equipMovesSideways`.
    */
    if (equipMovesSideways(state, seat, option.action)) {
      dropped += 1;
      continue;
    }
    /*
      And an ability the card allows and the board makes pointless: a second adapt, which puts no
      counters on anything. See `activationBuysNothing`.
    */
    if (activationBuysNothing(state, seat, option.action)) {
      dropped += 1;
      continue;
    }
    /*
      And the same spell pointed the wrong way: a "destroy target" aimed at its own board.

      The fifteenth, and the only one of the family an instrument asked for by name — 6% of Blight
      Vector's creatures were being killed by its own Naturalize, which can legally destroy an
      artifact creature and had nothing else to point at. See `destroysOneOfItsOwn`.
    */
    if (destroysOneOfItsOwn(state, seat, option.action)) {
      dropped += 1;
      continue;
    }
    /*
      And a Clone with nothing to copy, which is a 0/0 that dies as it arrives.
    */
    if (castsACopy(state, option.action) && !somethingToCopy(state)) {
      dropped += 1;
      continue;
    }
    /*
      And a goad with nowhere to send anything.

      The fifth, and the only one that is a fact about the table rather than the board: goad is
      "attacks somebody other than me", so in a duel it is four mana to make their creatures
      attack me. The search cannot see that either — `simulate` ends with this combat, and the
      attack goad forces comes round on their turn.
    */
    if (castsAGoad(state, option.action) && !goadHasSomewhereToSend(state, seat)) {
      dropped += 1;
      continue;
    }
    /*
      And a foretell with nothing spare to pay for it, which is the tenth of the family.

      The gain is real and entirely in the future: a card foretold this turn is cast for less on a
      later one. `simulate` cannot see any of that — it sees two mana spent and a card leaving hand
      for nothing at all — so without a rule the search would never foretell, and with a weight it
      would foretell on turn two instead of playing a creature. What the board can say is whether
      the mana was going to be spent anyway.
    */
    if (foretells(state, option.action) && !foretellIsSpareMana(state, seat, option.action)) {
      dropped += 1;
      continue;
    }

    /*
      And a crew that costs more than it buys, which is the ninth of the family and the first that
      is about arithmetic rather than about an empty board.

      `animationCouldMatter` already stops the bot crewing with nothing to attack or block. What it
      cannot see is the *price*: crewing taps creatures, so making a 4/3 Vehicle swing by tapping a
      3/3 and a 1/1 is four power of attack bought with four power of attack, plus a card's worth of
      bodies taken out of the combat. The search scores the board after the crew and the Vehicle is
      genuinely a creature, so the trade looks offered.
    */
    if (crewsAVehicle(state, option.action) && !crewBuysMoreThanItCosts(state, seat, option.action)) {
      dropped += 1;
      continue;
    }
    /*
      And an untap that puts the board back where it found it, which is the eleventh of the family
      and the only one about a cycle rather than a card. See `untapBoughtSomething`.
    */
    if (untapsSomething(state, option.action)
      && !untapBoughtSomething(state, after, seat, option.action)) {
      dropped += 1;
      continue;
    }
    /*
      And a spell whose own number comes out nought, which is the twelfth of the family and the
      first about a question rather than a play. See `chosenNumberIsNothing`.
    */
    if (chosenNumberIsNothing(state, seat, option.action)) {
      dropped += 1;
      continue;
    }
    /*
      And a play that spends the mana an answer in hand is waiting for, which is the thirteenth of
      the family and the first about a *later* turn rather than this one. See
      `spendsAnAnswersMana` for the measurement that asked for it.
    */
    if (opts.reserveForAnswers !== false && spendsAnAnswersMana(state, after, seat, option.action)) {
      dropped += 1;
      continue;
    }
    const score = evaluate(after, seat);
    // `>` rather than `>=` keeps the heuristic order as the tie-break: the options arrive
    // best-first by the old shallow ranking, so two plays that look identical one move out are
    // separated by the cheaper judgement rather than by whichever happened to be enumerated last.
    if (best === null || score > bestScore) {
      bestScore = score;
      best = option.action;
    }
  }
  if (best !== null) return best;
  // Nothing survived. If the rule above is why, pass — that is it working. If it is because every
  // simulation was refused, which should not happen, fall back to the shallow ranking rather than
  // silently doing nothing.
  return dropped > 0 ? { type: 'auto:pass', by: seat } : options[0]!.action;
}

/**
 * Applies one bot action for one seat.
 *
 * There is no mana bookkeeping here on purpose: the engine taps for a cost it can pay, so a play
 * `legalActions` offers is one the engine will accept. A bot that tapped lands itself would be
 * second-guessing that, and would get it wrong the first time a land made two colours.
 */
export function botStep(state: GameState, seat: SeatIndex, opts: BotOptions = {}): GameState {
  const action = botAction(state, seat, opts);
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
 * instead of only that it threw. `opts` goes to every seat — `{ lookahead: false }` is how the
 * breadth tests get through dozens of games in the time one search-driven game takes.
 */
export function playOut(state: GameState, maxActions = 6000, opts: BotOptions = {}): PlayOutResult {
  let next = state;
  let actions = 0;
  while (!next.finished && actions < maxActions) {
    const seat = seatToAct(next);
    if (seat === null) break;
    const before = next.stateVersion;
    next = botStep(next, seat, opts);
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
  // And a ward, which stops the table for the player who is not resolving anything.
  if (state.pendingPayment !== null) return [state.pendingPayment.seat];
  // And an offered cast on offer, which stops it for the player who is: a cascade hit is answered
  // before anybody does anything else, by casting it or by declining.
  if (state.pendingOfferedCast !== null) return [state.pendingOfferedCast.seat];
  if (state.pendingDiscard !== null) return [state.pendingDiscard.seat];
  const owed = pendingDeclaration(state);
  if (owed !== null) return [...owed.seats, ...offeredSeats(state, owed.seats)];
  const holder = state.priority === null ? [] : [state.priority];
  return [...holder, ...offeredSeats(state, holder)];
}

/**
 * Seats with a deal waiting for an answer, which the rules are not waiting on but a table is.
 *
 * Appended to the queue rather than put at its head, and never returned on its own ahead of a
 * question that blocks the engine: an unanswered offer stops nothing, so a seat that owes the
 * table an answer must not be able to push past the seat that owes it a move. The caller filters
 * this list to the seats it drives, so an offer made to a person sits there until they answer it.
 */
function offeredSeats(state: GameState, already: readonly SeatIndex[]): SeatIndex[] {
  const out: SeatIndex[] = [];
  for (const pact of state.pacts) {
    if (pact.status !== 'offered') continue;
    if (already.includes(pact.to) || out.includes(pact.to)) continue;
    if (state.seats[pact.to]?.eliminated === true) continue;
    out.push(pact.to);
  }
  return out;
}

/** The seat at the front of that queue, for a caller that only handles one at a time. */
export function seatToAct(state: GameState): SeatIndex | null {
  return seatsToAct(state)[0] ?? null;
}
