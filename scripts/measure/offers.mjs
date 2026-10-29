/**
 * What does the engine offer you, and do you take it?
 *
 * Three keywords share one piece of machinery — `pendingOfferedCast`, the engine stopping the table
 * to say "you may cast this card" — and all three turn on a distribution rather than on a rule.
 * **Cascade** reads like a free spell and is not one: it is a free spell drawn off the top of a
 * sixty-card deck, and twenty-three of those cards are lands it walks straight past. **Madness** is
 * a cheap spell you only get if you were discarding it anyway, and only if the mana is up when the
 * discard happens. And **miracle** is the narrowest of the three: two cards in sixty, and only on
 * the turn's *first* draw — so the number that matters is not how good the card is but how often
 * the deck gets to look at it. So this watches the offers themselves.
 *
 * Three questions, in the order a player would ask them:
 *
 * 1. **How often is an offer made, and how deep did it dig?** Every cascade is one trigger, and the
 *    depth is how many cards came off the library before one was cheap enough and not a land; a
 *    madness offer digs nothing and reads as depth one.
 * 2. **What was offered?** By name, so the answer is a list of cards rather than an average.
 * 3. **What was done with it?** A free spell can be declined, and the bot declines whenever
 *    `candidateActions` finds no legal way to cast the card — a Prey Upon with nothing to fight,
 *    a Flame Slash with nothing to burn. That number is the gap between what the keyword offers
 *    and what it is worth.
 *
 * It watches `pendingOfferedCast` rather than the log, which keeps it honest about one thing in
 * particular: the offer is in the *state*, so a cascade that fired and was answered inside the same
 * settle cannot hide from it. The pile that goes to the bottom is counted off the same field.
 *
 * Reads `packages/rules-engine/dist/index.js`, so build first:
 *
 *     pnpm --filter @grimore/rules-engine build
 *     SUBJECT=kindle-grove SEEDS=4 node scripts/measure/offers.mjs    # cascade
     SUBJECT=ashen-rite SEEDS=4 node scripts/measure/offers.mjs       # madness
 */
import {
  applyAction, canAfford, createGame, botAction, manaSources, parseManaCost, poolOf, scriptFor,
  seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const SUBJECT = process.env.SUBJECT ?? 'kindle-grove';
const ALL = Object.keys(STARTER_DECKS);
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 4);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

let games = 0;
/** Offers made at all, by the card whose keyword made them. */
const byCascader = new Map();
/** What was exiled as the hit, by name. */
const hits = new Map();
/** How many cards came off the library per cascade, including the hit. */
const depths = [];
let cast = 0;
let declined = 0;
/**
 * Casts of a card with cascade, which is how the ones that found nothing get counted.
 *
 * Every cast of a cascade card puts exactly one cascade trigger on the stack, and that trigger
 * either offers a card or exiles the whole library and offers none — so "fired and found nothing"
 * is this number minus the offers seen. The one case it over-counts is a game that ends while the
 * trigger is still on the stack, which is rare and named rather than corrected.
 */
let cascadeCasts = 0;

/** Whether a card's script carries the keyword, asked of the script rather than of a list here. */
const hasCascade = (name) => (scriptFor(name)?.triggers ?? [])
  .some((t) => t.on?.kind === 'spell-cast' && t.on?.self === true);

/**
 * Whether a card's script carries **madness**, asked of the script the same way.
 *
 * `script.madness` is a declarative field rather than a replacement the card writes out, which is
 * also a lesson this instrument learned the hard way: it used to read the `replaces` list and match
 * the word in a description, and when the keyword moved onto a field of its own the instrument went
 * quietly to reporting zero of everything. A measurement that reads a card's *shape* rather than
 * its *meaning* fails silently the day the shape changes.
 */
const hasMadness = (name) => scriptFor(name)?.madness !== undefined;

/*
  Discards, and the ones that could have been a madness card and were not.

  The question a bot rule would have to answer, measured before the rule is written. A madness card
  only ever does anything if it is the card that gets discarded, and the bot's discard policy knows
  nothing about the keyword — so the useful number is not "how many madness offers were made" but
  "how many discards were made while a madness card was sitting in that hand".

  Read by comparing each seat's hand before and after every action, because a discard is not an
  action: it happens inside a resolution (Faithless Looting) or at cleanup, and `state.discarded` is
  drained by `settle` before anything outside the engine can see it.
*/
let discards = 0;
let discardsOfMadness = 0;
let discardsWithMadnessInHand = 0;
/**
 * …and how many of those had the madness cost **payable** at that moment.
 *
 * The number that decides whether a bot rule can ever fire. A discard owed at cleanup is a discard
 * owed by a player who has spent their mana, and a madness cost nobody can pay is not a play the
 * rule could have taken — so "41 chances" and "41 chances with the mana up" are very different
 * findings about the same 41 discards.
 */
let affordableChances = 0;
/**
 * Offers the engine took back because the cost could not be paid (CR 601.2h).
 *
 * The third outcome, and for madness the commonest one: a card discarded with no mana up is a card
 * in a graveyard, and no prompt is ever shown. Counted off the log rather than the state, because
 * `settleOffer` writes its note through the replacement channel and `reduceAutoAction` drains that
 * onto the message of the action that provoked it.
 */
let unaffordable = 0;
/** Turns in which a seat drew a first card: the only window a miracle can be offered in. */
let firstDraws = 0;

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const nameOf = (s, id) => s.cardDefs[s.instances[id]?.defKey ?? '']?.name ?? '?';

function duel(seed, decks) {
  const host = { isHost: true };
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, host);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, host);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, host);

  let offer = null;

  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    if (action.type === 'auto:cast' && hasCascade(nameOf(s, action.card))) cascadeCasts += 1;
    const hands = [0, 1].map((i) => [...(s.zones[`${i}:hand`] ?? [])]);
    const logged = s.log.length;
    const was = s;
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;

    /*
      Which cards left a hand for a graveyard or an exile on this action: the discards.

      Both destinations, because a madness card discarded goes to exile rather than to the
      graveyard — counting only the graveyard would report every madness discard as not having
      happened, which is the one mistake this measurement cannot afford.

      **The spell that was just cast is excluded, and the first version of this was wrong without
      it.** Auto-pass can resolve a spell inside the same action that cast it, so a Fiery Temper
      cast and resolved went hand → stack → graveyard in one step and was counted as a discard:
      698 "discards" in 96 games, ten of them "madness", and not one real discard among them. A
      card cast is the action's own card, which is the one thing here that can tell the two apart.
    */
    const castId = action.type === 'auto:cast' ? action.card : undefined;
    for (const entry of s.log.slice(logged)) {
      if (/could not be paid/.test(entry.message ?? '')) unaffordable += 1;
    }
    /*
      First draws, which are miracle's denominator.

      A seat's draw count going from nothing to something is the turn's first card, and that is the
      only moment the keyword can fire — so "six offers" means nothing without "and four hundred
      first draws". Read off `cardsDrawnThisTurn` rather than off `drew`, because `settle` drains
      that list before anything outside the engine can see it.
    */
    for (const i of [0, 1]) {
      if ((was.cardsDrawnThisTurn[String(i)] ?? 0) === 0
        && (s.cardsDrawnThisTurn[String(i)] ?? 0) > 0) firstDraws += 1;
    }
    for (const i of [0, 1]) {
      const held = new Set(s.zones[`${i}:hand`] ?? []);
      const gone = hands[i].filter((id) => !held.has(id) && id !== castId);
      const left = gone.filter((id) => {
        const zone = s.instances[id]?.zone;
        return zone === 'graveyard' || zone === 'exile';
      });
      if (left.length === 0) continue;
      discards += left.length;
      const madnessGone = left.filter((id) => hasMadness(nameOf(was, id))).length;
      discardsOfMadness += madnessGone;
      // A discard that was not a madness card, made from a hand that held one: the opportunity a
      // bot rule would be about.
      const held_madness = hands[i].filter((id) => hasMadness(nameOf(was, id)));
      if (madnessGone === 0 && held_madness.length > 0) {
        discardsWithMadnessInHand += left.length;
        // Asked of the state *before* the action, which is the board the decision was made on.
        const payable = held_madness.some((id) => {
          const cost = parseManaCost(scriptFor(nameOf(was, id))?.madness?.cost ?? '');
          return cost.unsupported === undefined
            && canAfford(poolOf(was, i), cost, manaSources(was, i));
        });
        if (payable) affordableChances += left.length;
      }
    }

    const now = s.pendingOfferedCast;
    /*
      A new offer: record what it found and how far it dug for it.

      Compared by card id rather than by truthiness, because two cascades in a row — a cascade hit
      that cascades again — are two offers and the second must not be read as the first still
      standing.
    */
    if (now !== null && now.card !== offer?.card) {
      bump(byCascader, nameOf(s, now.source));
      bump(hits, nameOf(s, now.card));
      // `bottom` is cascade's pile and is absent for the other two keywords, which read as depth
      // one: a madness or miracle offer digs through nothing at all.
      depths.push((now.bottom ?? []).length + 1);
      offer = now;
    } else if (now === null && offer !== null) {
      /*
        The offer is gone, so it was answered — and *where the card ended up* is how to tell which
        way, which means the test is different for each keyword's disposition. A cascade hit goes
        back to the library when declined; a miracle card **stays in the hand it was drawn into**,
        so reading "not in the library" as "cast" would count every declined miracle as a cast.
      */
      const where = s.instances[offer.card]?.zone;
      const kept = offer.stays === true ? where === 'hand' : where === 'library';
      if (kept) declined += 1;
      else cast += 1;
      offer = null;
    }

  }
  games += 1;
}

for (let i = 0; i < SEEDS; i++) {
  for (const other of FIELD) {
    duel(SEED0 + i, [SUBJECT, other]);
    duel(SEED0 + i, [other, SUBJECT]);
  }
}

const total = [...byCascader.values()].reduce((n, v) => n + v, 0);
const mean = depths.length === 0
  ? '—'
  : (depths.reduce((n, d) => n + d, 0) / depths.length).toFixed(2);
console.log(`${SUBJECT}: ${games} games, seeds ${SEEDS} from ${SEED0}`);
console.log(`${total} offers made, ${mean} cards exiled each (the card offered included)`);
console.log(`of them: ${cast} cast, ${declined} declined`);
console.log(`${cascadeCasts} cascade cards were cast, so ${cascadeCasts - total} of those found`
  + ' nothing at all (or were still on the stack when the game ended). A madness card that was'
  + ' discarded with no mana up makes no offer either, and shows up only as a card in a graveyard.');
console.log('');
for (const [name, n] of [...byCascader].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  offered off ${name}`);
}
console.log('');
console.log(`${discards} cards were discarded: ${discardsOfMadness} of them had madness, and`
  + ` ${discardsWithMadnessInHand} were discarded out of a hand that was holding one`);
console.log(`${unaffordable} offers were taken back because the cost could not be paid`);
console.log(`${firstDraws} turns had a first card drawn in them, which is what miracle has to hit`);
console.log(`of those missed chances, ${affordableChances} had the madness cost payable at the time`);
console.log('');
console.log('what was offered:');
for (const [name, n] of [...hits].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${name}`);
}
