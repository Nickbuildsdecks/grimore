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
import { characteristicsOf, hasType, type Keyword } from './characteristics.js';
import { canAttack, canBlock } from './combat.js';
import { creaturesControlledBy } from './effects.js';
import { applyAction } from './engine.js';
import { costValue, parseManaCost } from './mana.js';
import { scriptFor } from './scripts.js';
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
const LAND_ON_BOARD = 2.5;
const PERMANENT_ON_BOARD = 3;
/**
 * What a land left untapped is worth *while the hand holds an instant*, per point of mana, up to
 * the cost of the cheapest one.
 *
 * The one thing the search could not do, and the reason the two control decks lose to the three
 * aggressive ones: a land is worth `LAND_ON_BOARD` whether it is tapped or not, so spending mana
 * costs the evaluation nothing and the bot taps out every turn — and then holds a counterspell with
 * no mana when the spell worth answering arrives.
 *
 * Only while an instant is held, because mana up with nothing to do with it is worth exactly
 * nothing, and capped at the cheapest answer's cost, because that is all the mana the answer needs.
 * The weight is a measurement, not a preference; the numbers are in `claude/decisions-log.md`.
 */
const MANA_UP_WITH_ANSWER = 1.0;

/**
 * The cost of the cheapest card in hand that can be cast at instant speed, or null for none.
 *
 * The same test `legalActions` uses — a printed instant, or anything with flash — because the two
 * have to agree: valuing mana for an answer the engine would not let this seat cast at that moment
 * is valuing nothing.
 */
function cheapestAnswerHeld(state: GameState, seat: SeatIndex): number | null {
  let cheapest: number | null = null;
  for (const id of state.zones[`${seat}:hand`] ?? []) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const def = state.cardDefs[inst.defKey];
    if (def === undefined) continue;
    const ch = characteristicsOf(state, inst);
    const instantSpeed = ch.typeLine.types.some((t) => t.toLowerCase() === 'instant')
      || ch.keywords.has('flash');
    if (!instantSpeed) continue;
    const cost = parseManaCost(def.manaCost);
    if (cost.unsupported !== undefined) continue;
    const total = costValue(cost);
    if (cheapest === null || total < cheapest) cheapest = total;
  }
  return cheapest;
}

/** Everything one seat has, from that seat's point of view. */
function seatValue(state: GameState, seat: SeatIndex): number {
  let total = (state.seats[seat]?.life ?? 0) * LIFE_WEIGHT;
  total += (state.zones[`${seat}:hand`] ?? []).length * CARD_IN_HAND;
  // Mana left up, worth something only while there is an answer in hand to spend it on.
  const answer = cheapestAnswerHeld(state, seat);
  let untappedLands = 0;
  for (const id of listAt(state, zoneKey(seat, 'battlefield'))) {
    const inst = state.instances[id];
    if (inst === undefined) continue;
    const ch = characteristicsOf(state, inst);
    if (ch.isLand) {
      total += LAND_ON_BOARD;
      if (!inst.tapped) untappedLands += 1;
    } else if (ch.isCreature) total += creatureValue(state, id);
    // A planeswalker's loyalty is its life *and* its spell-per-turn, so a counter on one is worth
    // about what a point of life is worth. Without this the search could not see what a plus
    // ability bought and stopped using them — three activations across sixteen games, where the
    // bot it replaced managed more than one per planeswalker it cast.
    else total += PERMANENT_ON_BOARD + (inst.counters['loyalty'] ?? 0) * LIFE_WEIGHT;
  }
  if (answer !== null) total += Math.min(untappedLands, answer) * MANA_UP_WITH_ANSWER;
  return total;
}

/**
 * How much this seat likes a position.
 *
 * Its own side, less the average opponent — the average rather than the sum, so a four-player pod
 * is scored on "am I ahead of the table" instead of on "is the rest of the table small", which
 * would have the bot ignore the player about to kill it in favour of the two who are behind.
 */
export function evaluate(state: GameState, seat: SeatIndex): number {
  if (state.finished) return state.winnerSeat === seat ? 1e6 : -1e6;
  if (state.seats[seat]?.eliminated === true) return -1e6;
  const foes = foesOf(state, seat);
  let theirs = 0;
  for (const foe of foes) theirs += seatValue(state, foe);
  return seatValue(state, seat) - (foes.length === 0 ? 0 : theirs / foes.length);
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
function simulate(state: GameState, action: Action): GameState | null {
  let next: GameState;
  try {
    next = applyAction(state, action, HOST);
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

/** How many ways of aiming one spell are worth simulating. */
const AIM_WIDTH = 3;

/**
 * The ways this play could be aimed, best-first, at most `AIM_WIDTH` of them.
 *
 * Only the *first* target of a spell is varied. Which creature a Doom Blade kills is the choice
 * that decides whether the card was worth playing; the second target of a two-target spell almost
 * never is, and varying both would multiply the search for nothing.
 */
function aimings(state: GameState, seat: SeatIndex, play: LegalPlay): (readonly Target[])[] {
  const first = chooseTargets(state, seat, play);
  if (first === null) return [];
  if (first.length === 0) return [[]];
  const spec = play.targetSpecs[0];
  const foes = foesOf(state, seat);
  const alternatives = [...(play.candidates[0] ?? [])]
    .sort((a, b) => rank(state, b, foes) - rank(state, a, foes))
    .slice(0, AIM_WIDTH);
  const out: (readonly Target[])[] = [first];
  // One spec wanting several targets is left alone: the heuristic filled all of them, and swapping
  // one out would need the rest re-picked around it.
  if (spec !== undefined && Math.max(1, spec.count ?? 1) === 1) {
    for (const option of alternatives) {
      if (targetKeyOf(option) === targetKeyOf(first[0]!)) continue;
      const rest = first.slice(1);
      if (rest.some((t) => targetKeyOf(t) === targetKeyOf(option))) continue;
      out.push([option, ...rest]);
    }
  }
  return out.slice(0, AIM_WIDTH);
}

const targetKeyOf = (t: Target): string => (t.kind === 'card' ? `c${t.id}` : `p${t.seat}`);

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
    for (const targets of aimings(state, seat, play)) {
      if (play.kind === 'cast') {
        /*
          A spell with an additional cost: something has to be fed to it before it can be cast at
          all, and the bot has to decide whether that is worth doing.

          Shallow in the same way as every other judgement in this file, and deliberately so: it
          feeds the cheapest creature it has, and it will not do it unless that creature is worth
          less than what the spell is aimed at — or, for a spell with no target, unless the
          creature is nearly free anyway. Without this it was happy to eat its best creature to
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
            ...(fodder === null ? {} : { sacrifice: fodder }),
            // X as large as the mana allows. The search sees what that buys, which is new: it
            // will not cast a Hurricane for eight into a board of its own fliers any more.
            ...(play.xMax === undefined ? {} : { x: play.xMax }),
            ...(play.modes === undefined ? {} : { modes: [...play.modes] }),
            ...(targets.length > 0 ? { targets: [...targets] } : {}),
          },
        });
        continue;
      }
      // An ability paid for by sacrificing something is only worth it when the thing eaten is
      // worth less than the thing fed.
      if (play.sacrificeOptions.length > 0) {
        const fodder = cheapestCreature(state, play.sacrificeOptions);
        if (fodder === null) continue;
        const self = state.instances[play.card];
        const worth = self === undefined ? 0 : characteristicsOf(state, self).power;
        if (characteristicsOf(state, state.instances[fodder]!).power >= worth) continue;
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
      .filter((t) => !used.has(t.kind === 'card' ? `c${t.id}` : `p${t.seat}`))
      .sort((a, b) => rank(state, b, foes) - rank(state, a, foes));
    for (const pick of ranked.slice(0, want)) {
      used.add(pick.kind === 'card' ? `c${pick.id}` : `p${pick.seat}`);
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
    return ask === null ? null : { type: 'auto:decide', by: seat, cards: decideCards(state, seat, ask) };
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
 * Holding back needs to be chosen by seeing the swing back, which is the second ply.
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
      const action: Action = owed.kind === 'attackers'
        ? { type: 'auto:attack', by: seat, attackers: chooseAttackers(next, seat) }
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
function scoreDeclaration(state: GameState, seat: SeatIndex, action: Action): number | null {
  let after: GameState;
  try {
    after = applyAction(state, action, HOST);
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
function attackPlans(state: GameState, seat: SeatIndex): AttackPlan[] {
  const heuristic = chooseAttackers(state, seat);
  const plans: AttackPlan[] = [heuristic, []];

  const able = legalActions(state, seat).attackers.filter((id) => canAttack(state, id, seat) === null);
  const foes = foesOf(state, seat)
    .map((index) => ({ index, life: state.seats[index]?.life ?? 0 }))
    .sort((a, b) => a.life - b.life);
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
  return plans;
}

/**
 * The blocks worth considering.
 *
 * The same idea, shorter: what the heuristic would do, no blocks at all, and every blocker thrown
 * in front of the biggest thing it may legally block. "No blocks" matters more than it sounds —
 * the heuristic blocks whenever a trade looks even, and an even trade is a bad deal when the
 * creature it gives up was the only thing holding the next attack off.
 */
function blockPlans(state: GameState, seat: SeatIndex): { blocker: string; attacker: string }[][] {
  const heuristic = chooseBlocks(state, seat);
  const plans: { blocker: string; attacker: string }[][] = [heuristic, []];
  const everything: { blocker: string; attacker: string }[] = [];
  const taken = new Set<string>();
  for (const option of legalActions(state, seat).blockers) {
    let best: string | null = null;
    for (const attackerId of option.canBlock) {
      if (taken.has(attackerId)) continue;
      const attacker = state.instances[attackerId];
      if (attacker === undefined) continue;
      if (characteristicsOf(state, attacker).keywords.has('menace')) continue;
      if (best === null || creatureValue(state, attackerId) > creatureValue(state, best)) best = attackerId;
    }
    if (best === null) continue;
    taken.add(best);
    everything.push({ blocker: option.blocker, attacker: best });
  }
  if (everything.length > heuristic.length) plans.push(everything);
  return plans;
}

/** The declaration this seat owes, chosen by playing each plan out. */
function declareBySearch(
  state: GameState, seat: SeatIndex, kind: 'attackers' | 'blockers', opts: BotOptions,
): Action {
  if (kind === 'attackers') {
    const plans = attackPlans(state, seat);
    const fallback: Action = { type: 'auto:attack', by: seat, attackers: plans[0]! };
    if (opts.lookahead === false) return fallback;
    return bestPlan(state, seat, plans.map((attackers) => ({
      type: 'auto:attack', by: seat, attackers,
    } as Action))) ?? fallback;
  }
  const plans = blockPlans(state, seat);
  const fallback: Action = { type: 'auto:block', by: seat, blocks: plans[0]! };
  if (opts.lookahead === false) return fallback;
  return bestPlan(state, seat, plans.map((blocks) => ({
    type: 'auto:block', by: seat, blocks,
  } as Action))) ?? fallback;
}

/** The highest-scoring of a set of declarations, or null when none of them can be applied. */
function bestPlan(state: GameState, seat: SeatIndex, actions: readonly Action[]): Action | null {
  let best: Action | null = null;
  let bestScore = -Infinity;
  for (const action of actions) {
    const score = scoreDeclaration(state, seat, action);
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
export function botAction(state: GameState, seat: SeatIndex, opts: BotOptions = {}): Action | null {
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
  if (choice !== null) return aimPending(state, seat, choice);

  if (actions.mustDiscard > 0) {
    // Pitch the most expensive thing, which is the card least likely to be castable.
    const worst = handByCost(state, seat)[0];
    return worst === undefined ? null : { type: 'auto:discard', by: seat, card: worst.id };
  }

  const owed = pendingDeclaration(state);
  if (owed !== null && owed.seats.includes(seat)) {
    return declareBySearch(state, seat, owed.kind, opts);
  }

  if (!actions.hasPriority) return null;

  /*
    One move ahead.

    Everything above this line is a rule — answer the question, declare the blockers — and has one
    right answer. Which spell to cast is not like that: it is a judgement, and until now the bot
    made it by preferring the most expensive thing it could afford, which is how it came to cast
    a Hurricane that killed its own board and point a Shock at a 1/1 while a 5/5 attacked it.

    So: build every play it could make, *play each one out* far enough to see what happens, and
    keep the position it likes best. Doing nothing is one of the options, which is what makes the
    bot capable of holding a card back rather than spending it on nothing.

    It is one ply and no further. A second ply needs to model the opponent's reply, which needs an
    opponent model, and the honest version of that is this same function recursing — worth doing
    only once there is a reason to believe the evaluation below is any good.
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
    const ready = lands.find((p) => scriptFor(state.cardDefs[state.instances[p.card]!.defKey]?.name)?.entersTapped !== true);
    return { type: 'auto:playLand', by: seat, card: (ready ?? lands[0]!).card };
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
  let best = options[0]!.action;
  let bestScore = -Infinity;
  for (const option of options) {
    const after = simulate(state, option.action);
    if (after === null) continue;
    const score = evaluate(after, seat);
    // `>` rather than `>=` keeps the heuristic order as the tie-break: the options arrive
    // best-first by the old shallow ranking, so two plays that look identical one move out are
    // separated by the cheaper judgement rather than by whichever happened to be enumerated last.
    if (score > bestScore) {
      bestScore = score;
      best = option.action;
    }
  }
  return best;
}

/**
 * Applies one bot action for one seat.
 *
 * There is no mana bookkeeping here on purpose: the engine taps for a cost it can pay, so a play
 * `legalActions` offered is one the engine will accept. A bot that tapped lands itself would be
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
  if (state.pendingDiscard !== null) return [state.pendingDiscard.seat];
  const owed = pendingDeclaration(state);
  if (owed !== null) return [...owed.seats];
  return state.priority === null ? [] : [state.priority];
}

/** The seat at the front of that queue, for a caller that only handles one at a time. */
export function seatToAct(state: GameState): SeatIndex | null {
  return seatsToAct(state)[0] ?? null;
}
