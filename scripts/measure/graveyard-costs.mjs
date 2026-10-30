/**
 * Does the bot ever pay a cost out of its own graveyard, and what does it pay?
 *
 * Escape and delve are the first costs in this engine that spend a *zone*, and both are invisible
 * to every instrument that was already here. `cast-counts` counts a Phoenix of Ash cast twice and
 * cannot say whether the second one came out of the graveyard or out of a second copy — there is no
 * second copy, but the harness does not know that. And delve does not change what is cast at all:
 * a Gurmag Angler cast for {B} and one cast for {6}{B} are the same row.
 *
 * So this counts the **action** a player took and the cards that left their graveyard while it was
 * applied: a cast of a watched card is one casting, and the cards of theirs that reached exile in
 * the same step are what paid for it. It used to read the stack instead, which was wrong by a
 * factor of about eight — see the note in `duel` below.
 *
 * Three questions, and the third is the one worth building for:
 *
 * - **Does it happen at all?** A mechanic the bot never uses is a mechanic with no coverage beyond
 *   its unit tests, whatever the deck list says.
 * - **How deep does the delve go?** `delvePlan` takes the fewest cards that make the spell
 *   payable, so the distribution is a picture of when the card gets cast rather than of how big
 *   the graveyard got.
 * - **Does the same card escape twice in one game?** That is the whole difference between escape
 *   and flashback — a flashback spell is exiled as it leaves the stack and there is no third
 *   casting — and a count of one per game would mean the engine was quietly treating it as one.
 *
 * And a fourth block, added with embalm: the costs paid out of a graveyard that are **not casts**.
 * Unearth, embalm and eternalize are activated abilities, so nothing above sees them — they never
 * put a spell on the stack and `cast-counts` has no row for them at all. They are read off the
 * stack the same way the triggers are, because an activated ability is an object on it, and
 * counted beside the one number that makes a zero legible: how many games the card reached the
 * graveyard in. "Never used" and "never drawn" are different findings, and the second one is the
 * commoner.
 */
import {
  applyAction, createGame, botAction, legalActions, seatsToAct, scriptFor, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const SUBJECT = process.env.SUBJECT ?? 'arc-tempest';
/*
  Every deck in the pool, read from the registry rather than written out here — the same reason
  every other harness in this directory does it. A deck added tomorrow is in the field without
  anybody remembering to come back.
*/
const ALL = Object.keys(STARTER_DECKS);
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

/*
  Which cards to watch, worked out from the scripts rather than listed here: a card is in this
  table because its script declares `escape` or `delve`.
*/
const WATCHED = new Map();
for (const deck of Object.values(STARTER_DECKS)) {
  for (const entry of deck.cards) {
    const script = scriptFor(entry.card.name);
    if (script?.escape !== undefined) WATCHED.set(entry.card.name, 'escape');
    else if (script?.delve === true) WATCHED.set(entry.card.name, 'delve');
  }
}
/*
  Which of them are in the subject's own sixty, so a zero can be told apart from an absence.

  The watch list is the whole pool on purpose — a card that pays this way in somebody else's deck
  is still worth a row, because a run with the wrong SUBJECT is the mistake this catches. But
  "never" and "not in this deck" are different findings and a harness that prints the same word
  for both has lost the one it was built for.
*/
const MINE = new Set((STARTER_DECKS[SUBJECT]?.cards ?? []).map((entry) => entry.card.name));

/*
  The costs paid out of a graveyard that are not casts: unearth, embalm and eternalize.

  An ability rather than a spell, so none of the machinery above can see one. Found the same way
  everything else here is — a card is watched because one of its abilities declares
  `cost.fromGraveyard` — and the keyword's name is the first word of its own reminder text, which
  is the only place the engine writes down which of the three it is.
*/
const ABILITIES = new Map();
for (const deck of Object.values(STARTER_DECKS)) {
  for (const entry of deck.cards) {
    for (const ability of scriptFor(entry.card.name)?.abilities ?? []) {
      if (ability.cost?.fromGraveyard !== true) continue;
      ABILITIES.set(entry.card.name, ability.description.split(' ')[0].toLowerCase());
    }
  }
}
/*
  Per watched card: abilities activated, the games it reached the subject's graveyard in, and the
  turns on which the engine actually **offered** the ability.

  The third number is the only honest denominator, and the reason is that the second one is not a
  denominator at all. A card sitting in a graveyard is not a chance to use it: embalm is sorcery
  speed, so a Sacred Cat that dies blocking on somebody else's turn offers nothing until the next
  main phase, and only then if the mana is spare. Offers are counted per **turn** rather than per
  priority pass, because one turn is one chance and a seat gets priority a dozen times in it.

  Read the two together and the answer is clear: the bot takes nearly every chance it is given.
*/
const abilityRows = new Map();
for (const name of ABILITIES.keys()) abilityRows.set(name, { used: 0, inYard: 0, offered: 0 });

/*
  And the other side of the same dimension: the cards that *answer* a graveyard.

  A cost paid out of the graveyard and a card that exiles graveyards are the same question asked
  from two ends, so they belong in one harness rather than two — a run that says "eleven delved
  Anglers" and a run that says "nine Planar Void triggers" cannot be compared, and the thing worth
  knowing is whether the two ever meet.

  Discovered from the scripts, like everything else here: a card is watched because its script has
  a `to-graveyard` trigger.
*/
const ANSWERS = new Map();
for (const deck of Object.values(STARTER_DECKS)) {
  for (const entry of deck.cards) {
    const script = scriptFor(entry.card.name);
    if ((script?.triggers ?? []).some((trigger) => trigger.on.kind === 'to-graveyard')) {
      ANSWERS.set(entry.card.name, 0);
    }
  }
}

/** Per card: how many times it was cast this way, and the cards that paid for it. */
const rows = new Map();
const row = (name) => {
  const got = rows.get(name) ?? { casts: 0, cards: 0, counts: new Map() };
  rows.set(name, got);
  return got;
};
let games = 0;
/** Games in which one card escaped more than once — the thing flashback cannot do. */
let twiceGames = 0;

function duel(seed, decks, mine) {
  const ctx = { isHost: true };
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, ctx);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, ctx);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, ctx);

  const perCard = new Map();
  /** Triggered abilities already counted, keyed by stack object. */
  const countedTriggers = new Set();
  /** Which watched cards reached my graveyard this game. */
  const reachedYard = new Set();
  /** Turns on which a watched ability was offered, keyed `name:turn` so one turn is one chance. */
  const offeredTurns = new Set();
  for (let move = 0; move < 4000 && !s.finished; move++) {
    /*
      The answers, which are the one thing still read off the stack — and the one thing that can be.
      A triggered ability is put on the stack by the engine rather than by an action, so there is no
      action to count; both seats' are counted, because a Planar Void in the field is the half of
      this measurement that says whether the hate ever meets the cost.
    */
    for (const id of s.stackOrder) {
      const object = s.stackObjects[id];
      if (object?.kind !== 'triggered' || countedTriggers.has(id)) continue;
      const name = s.cardDefs[object.cardKey]?.name;
      if (!ANSWERS.has(name)) continue;
      countedTriggers.add(id);
      ANSWERS.set(name, ANSWERS.get(name) + 1);
    }
    /*
      And whether the card was ever in my graveyard to be paid with at all, which is the
      denominator for an ability. Counted once per game per card, from the zone rather than from an
      event: a card that arrived and was embalmed on the same turn still spent a moment there.
    */
    for (const inst of Object.values(s.instances)) {
      if (inst.zone !== 'graveyard' || inst.zoneSeat !== mine) continue;
      const name = s.cardDefs[inst.defKey]?.name;
      if (ABILITIES.has(name)) reachedYard.add(name);
    }
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    /*
      The offers, read from the same list the bot chooses out of, so "declined" means declined.
      Only when it is my priority, because `legalActions` for a seat that cannot act is empty.
    */
    if (seat === mine && ABILITIES.size > 0) {
      for (const play of legalActions(s, mine).plays) {
        if (play.kind !== 'activate') continue;
        const inst = s.instances[play.card];
        if (inst?.zone !== 'graveyard') continue;
        const name = s.cardDefs[inst.defKey]?.name;
        if (!ABILITIES.has(name)) continue;
        const key = `${name}:${s.turn}`;
        if (offeredTurns.has(key)) continue;
        offeredTurns.add(key);
        abilityRows.get(name).offered += 1;
      }
    }
    const action = botAction(s, seat);
    if (action === null) break;
    /*
      Everything a *player* did is counted off the **action**, not off the stack, and that is a
      correction rather than a preference. The first version of this harness read the stack between
      actions and reported seventeen escaped Woe Striders across 288 games; `cast-counts`, which
      counts the action, reads twenty-three in 48. With `autoPass: true` an object that nobody wants
      to respond to is put on the stack and resolved **inside the same `applyAction`**, so a harness
      that looks between actions sees only the few that somebody held priority over. Roughly one in
      eight. Every number this block has ever printed for escape and delve was that fraction.

      A card leaving my graveyard for exile during the action is the cost being paid, which is how
      the cards-per-cast spread survives the change: snapshot the graveyard before, count how many
      of those cards are in exile after. (A graveyard hoser could in principle move one of them in
      the same window; none in this pool moves a card that is *already* in a graveyard.)
    */
    const name = seat === mine ? nameOf(s, action.card) : undefined;
    const watchedCast = action.type === 'auto:cast' && WATCHED.has(name) ? name : undefined;
    const yardBefore = watchedCast === undefined ? null : Object.values(s.instances)
      .filter((inst) => inst.zone === 'graveyard' && inst.zoneSeat === mine)
      .map((inst) => inst.id);
    if (action.type === 'auto:activate' && ABILITIES.has(name)) {
      abilityRows.get(name).used += 1;
    }
    const before = s.stateVersion;
    try { s = applyAction(s, action, ctx); } catch { break; }
    if (s.stateVersion === before) break;
    if (watchedCast !== undefined) {
      const spent = yardBefore
        .filter((id) => id !== action.card && s.instances[id]?.zone === 'exile').length;
      /*
        Only the casts that actually spent the graveyard, which the first action-counting version
        got wrong: a Phoenix of Ash cast from **hand** is the same card and the same action type,
        and counting those read 97 “escapes” in 144 games of which 72 exiled nothing at all.
        Escape says so on the action; delve does not, so for delve the test is whether any card was
        exiled — a delve cast that chose to spend nothing is an ordinary cast of the card.
      */
      const paid = WATCHED.get(watchedCast) === 'escape' ? action.escape === true : spent > 0;
      if (paid) {
        const r = row(watchedCast);
        r.casts += 1;
        r.cards += spent;
        r.counts.set(spent, (r.counts.get(spent) ?? 0) + 1);
        perCard.set(watchedCast, (perCard.get(watchedCast) ?? 0) + 1);
      }
    }
  }
  if ([...perCard.values()].some((n) => n > 1)) twiceGames += 1;
  for (const name of reachedYard) abilityRows.get(name).inYard += 1;
}

/** A card's name, for an action that names one. */
function nameOf(state, card) {
  const inst = card === undefined ? undefined : state.instances[card];
  return inst === undefined ? undefined : state.cardDefs[inst.defKey]?.name;
}

/*
  A seed of its own for every game. One `seed` is one RNG stream, the stream shuffles seat 0's deck
  and then seat 1's, and the same stream yields the same index permutation however different the
  deck list is — so a whole pass over the field on one seed was one shuffle wearing every pairing,
  and an absolute rate printed below had the error bars of its seed count rather than its game
  count. Measured in D240. Derived from the loop indices rather than a counter, because a counter
  desynchronises the arms of a paired harness the moment one of them skips a game.
*/
const seedFor = (pass, j, order) => SEED0 + ((pass * FIELD.length + j) * 2) + order;

for (let i = 0; i < SEEDS; i++) {
  for (const [j, other] of FIELD.entries()) {
    duel(seedFor(i, j, 0), [SUBJECT, other], 0); games += 1;
    duel(seedFor(i, j, 1), [other, SUBJECT], 1); games += 1;
  }
}

console.log(`${SUBJECT}: ${games} games, seeds ${SEEDS} from ${SEED0}`);
console.log('');
if (WATCHED.size === 0) {
  console.log('no card in the pool pays a cost out of the graveyard — nothing to count');
} else {
  console.log('costs paid out of the graveyard:');
  for (const [name, kind] of WATCHED) {
    const r = rows.get(name);
    if (r === undefined) {
      console.log(`      0  ${name} (${kind}) — ${MINE.has(name) ? 'never' : 'not in this deck'}`);
      continue;
    }
    const spread = [...r.counts.entries()].sort((a, b) => a[0] - b[0])
      .map(([n, count]) => `${n}:${count}`).join(' ');
    console.log(`${String(r.casts).padStart(7)}  ${name} (${kind}), ${r.cards} cards exiled`
      + `  [cards per cast — ${spread}]`);
  }
  console.log('');
  console.log(`games where one card paid this way more than once: ${twiceGames} of ${games}`);
}
if (ABILITIES.size > 0) {
  console.log('');
  console.log('and the costs paid out of a graveyard that are abilities rather than casts:');
  for (const [name, keyword] of ABILITIES) {
    const r = abilityRows.get(name);
    const where = MINE.has(name)
      ? `offered on ${r.offered} turns, across ${r.inYard} games it reached the graveyard`
      : 'not in this deck';
    console.log(`${String(r.used).padStart(7)}  ${name} (${keyword}) \u2014 ${where}`);
  }
}
if (ANSWERS.size > 0) {
  console.log('');
  console.log('and the answers to a graveyard, counting abilities that reached the stack:');
  for (const [name, count] of ANSWERS) {
    console.log(`${String(count).padStart(7)}  ${name}`);
  }
}
