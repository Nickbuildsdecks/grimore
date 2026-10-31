/**
 * A deck list against the field, stock versus a variant built here — for a change nobody intends
 * to ship.
 *
 * Nothing here touches the repository: the stock arm is whatever `STARTER_DECKS` says today and
 * the variant is built from it in memory. That is the point — a change can be priced before it is
 * written, so the source only ever carries slot changes the instrument has already approved, and
 * a question like "how much of this deck's record is the cards and how much is the pilot" can be
 * asked without a commit that answers it wrongly.
 *
 * CHANGE is "Name:+1,Other:-2" as in deck-swap. A card the change adds need not already be in the
 * subject deck: its definition is looked up anywhere in the pool, which is where every card lives.
 *
 * COMMANDER names a card to lead the variant instead of the deck's own, which is the one question
 * this harness could not ask: every deck's write-up calls its commander "the half a deck list
 * cannot be", and until now that claim was unmeasured. Point it at a legend whose text is *dead* in
 * the subject deck — Balan in a deck with no Equipment — and the difference is what the real
 * commander is worth.
 *
 * SETS is how many disjoint seed sets to read the change on, two by default, because one reading
 * gives the direction and not the size (D258). The summary at the end says which of those two it
 * managed, and a run whose sets disagree on the sign says so instead of printing a number.
 *
 *     SUBJECT=dawn-tithe CHANGE='Serra Angel:+1,Sacred Cat:-1' SEEDS=12 node scripts/measure/deck-probe.mjs
 *     SETS=1 SUBJECT=tidal-mind CHANGE='Mulldrifter:+1,Think Twice:-1' node scripts/measure/deck-probe.mjs
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';
import { canonicalDecks } from './decks.mjs';

const SUBJECT = process.env.SUBJECT ?? 'tidal-mind';
/*
  Every deck in the pool, read from the registry rather than written out here.

  It used to be a literal list in each of seven harnesses, which is seven places to remember and
  six places to forget: the twelfth deck was added and the first table run after it measured the
  same eleven-deck field as the day before, with no warning of any kind. A measurement that
  silently answers last week's question is worse than one that fails.
*/
const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 17);
const SEED0 = Number(process.env.SEED0 ?? 3300);
/*
  How many **disjoint seed sets** to read the same change on, because one is not a measurement.

  D258 ran four changes through this harness on two seed sets each and the deltas came back +30/+18,
  −18/−1, +12/+5 and −14/−19: the **sign agreed in all eight readings** and the magnitudes differed
  by 12, 17, 7 and 5 games. So a single paired 288-game reading tells you the direction and is worth
  about ±10 on the size — which is the same order as most of the effects this project publishes, and
  is why two entries were published with numbers they had not earned.

  Pairing the arms (`canonicalDecks`, below) removes the reshuffle *between* the arms. It cannot
  remove the game: a changed card diverges the play from the turn it is drawn, and how far it
  diverges is itself a function of the seed. Nothing fixes that except more seeds.

  Default two, so the spread is in every output and nobody has to remember to look for it. `SETS=1`
  is a quick look and says so in its own output.
*/
const SETS = Number(process.env.SETS ?? 2);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

/*
  "Name:+1,Other:-1", or "Name:+1;Other:-1" when a name has a comma in it.

  Which every legendary creature does — "Adeliz, the Cinder Wind", "Nissa, Voice of Zendikar" — and
  a comma-separated list cannot express one: splitting on the comma turned the card into two names
  and the probe refused both. So a `;` anywhere in the string makes `;` the separator, which keeps
  every invocation this project has already written down working and makes the rest expressible.
*/
const CHANGE = (process.env.CHANGE ?? '')
  .split((process.env.CHANGE ?? '').includes(';') ? ';' : ',')
  .filter(Boolean)
  .map((part) => {
    const at = part.lastIndexOf(':');
    return { name: part.slice(0, at).trim(), delta: Number(part.slice(at + 1)) };
  });

const defNamed = (name) => Object.values(STARTER_DECKS)
  .flatMap((d) => d.cards).find((e) => e.card.name === name)?.card;

const COMMANDER = process.env.COMMANDER ?? '';

function variant() {
  const stock = STARTER_DECKS[SUBJECT];
  const cards = [];
  for (const entry of stock.cards) {
    const change = CHANGE.find((c) => c.name === entry.card.name);
    const count = entry.count + (change?.delta ?? 0);
    if (count > 0) cards.push({ card: entry.card, count });
  }
  for (const change of CHANGE) {
    if (change.delta <= 0) continue;
    if (stock.cards.some((e) => e.card.name === change.name)) continue;
    const card = defNamed(change.name);
    if (card === undefined) throw new Error(`no card named ${change.name} in the pool`);
    cards.push({ card, count: change.delta });
  }
  if (COMMANDER === '') return { ...stock, cards };
  const lead = Object.values(STARTER_DECKS).map((d) => d.commander).find((c) => c?.name === COMMANDER)
    ?? defNamed(COMMANDER);
  if (lead === undefined) throw new Error(`no card named ${COMMANDER} in the pool`);
  return { ...stock, cards, commander: lead };
}

const FIELD = ALL.filter((id) => id !== SUBJECT);
const VARIANT = variant();
const size = (d) => d.cards.reduce((n, e) => n + e.count, 0);
console.log(`stock ${size(STARTER_DECKS[SUBJECT])} cards, variant ${size(VARIANT)} cards`);
if (size(VARIANT) !== size(STARTER_DECKS[SUBJECT])) {
  console.log('!! the two lists are not the same size, so this measures deck size too');
}

/*
  `BotOptions` for both seats, as JSON, so a slot can be priced with a bot rule turned on.

  The question it exists for: a card the bot plays badly measures as a bad card, and the two are
  only separable by pricing the slot twice. Terminus cost Skyward Writ thirty games of 288 with the
  bot casting every one it was offered (D204); the same probe with `sparesItsOwnBoard` on says how
  much of that was the card. Default empty, so a published probe means what it has always meant.

    BOT='{"sparesItsOwnBoard":true}' SUBJECT=skyward-writ node scripts/measure/deck-probe.mjs
*/
const BOT = JSON.parse(process.env.BOT ?? '{}');

function duel(seed, decks, ctx) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  const host = { isHost: true, ...ctx };
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, host);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, host);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, host);
  for (let move = 0; move < 4000 && !s.finished; move++) {
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat, BOT);
    if (action === null) break;
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
  }
  return s.finished ? s.winnerSeat : null;
}

/**
 * The subject's record against the field, and against each deck in it.
 *
 * The per-opponent split is what says *why* a change worked: a trim that wins fifty more games
 * against the two fastest decks and none against the slowest is a change about aggression, and
 * one that wins five everywhere is a change about card quality. Without the split both read as
 * one number.
 */
/*
  A seed per game, and the arms stay paired because this is a **pure function of the loop indices**.

  One seed used for a whole pass meant the 24 games in it shared a shuffle (D240), so the absolute
  `stock:` and `variant:` lines below were worth a handful of trials rather than hundreds. The two
  calls here are the two *orders* of a pairing, not two arms — the arms are the two `record()`
  calls, which re-run this identical loop. Deriving the seed from `(pass, j, order)` therefore gives
  both arms the same games, which is the whole design: the negative control is that a variant
  identical to stock prints the same record twice (151-137 and 151-137), and that must still hold.

  A counter would also work today and would break silently the first time one arm skipped a game.
*/
/*
  One set consumes exactly this many seeds, so set `k` starts past the end of set `k-1` and no game
  is ever played twice. Written as the loop's own bound rather than a round number for that reason:
  a hand-picked offset that overlapped would make the second set a partial re-run of the first and
  the spread would read smaller than it is.
*/
const STRIDE = SEEDS * FIELD.length * 2;
const seedFor = (set, pass, j, order) =>
  SEED0 + (set * STRIDE) + ((pass * FIELD.length + j) * 2) + order;

function record(ctx, set) {
  let won = 0; let lost = 0; let draw = 0;
  const each = new Map(FIELD.map((id) => [id, { won: 0, lost: 0 }]));
  for (let i = 0; i < SEEDS; i++) {
    for (const [j, other] of FIELD.entries()) {
      const row = each.get(other);
      const first = duel(seedFor(set, i, j, 0), [SUBJECT, other], ctx);
      if (first === 0) { won += 1; row.won += 1; } else if (first === 1) { lost += 1; row.lost += 1; } else draw += 1;
      const second = duel(seedFor(set, i, j, 1), [other, SUBJECT], ctx);
      if (second === 1) { won += 1; row.won += 1; } else if (second === 0) { lost += 1; row.lost += 1; } else draw += 1;
    }
  }
  return { won, lost, draw, each };
}

/*
  Both arms get **canonically ordered** lists, which is what makes them comparable at all.

  A deck's written order decides its pre-shuffle order and so decides the games (D257), and the
  variant this builds puts a card the deck did not already hold at the end of the list — so without
  this the stock arm and the variant arm differed by the change *and* by a reshuffle of everything
  else. See `canonicalDecks`.
*/
const STOCK = canonicalDecks(STARTER_DECKS);
const VARIED = canonicalDecks(STARTER_DECKS, { [SUBJECT]: VARIANT });
const signed = (n) => `${n >= 0 ? '+' : ''}${n}`;
const deltas = [];

for (let set = 0; set < SETS; set++) {
  const before = record(STOCK, set);
  const after = record(VARIED, set);
  const delta = after.won - before.won;
  deltas.push(delta);
  if (SETS > 1) console.log(`\nset ${set + 1} of ${SETS}, ${SEEDS} seeds from ${SEED0 + set * STRIDE}`);
  console.log(`stock:   ${before.won}-${before.lost}${before.draw ? ` (${before.draw} unfinished)` : ''}`);
  console.log(`variant: ${after.won}-${after.lost}${after.draw ? ` (${after.draw} unfinished)` : ''}  ${signed(delta)}`);
  // The per-opponent breakdown on the first set only: thirteen rows per set is a wall, and the
  // question a breakdown answers — which matchup moved — is asked of one set at a time anyway.
  if (set > 0) continue;
  for (const other of FIELD) {
    const b = before.each.get(other); const a = after.each.get(other);
    console.log(`  ${b.won}-${b.lost} -> ${a.won}-${a.lost}  ${signed(a.won - b.won)}  v ${other}`);
  }
}

/*
  And the reading, which is the part that was being left to the person holding the output.

  A change is **measured** when every set agrees on the sign; the size is then the range, not a
  single number. When the sets disagree the honest answer is that this harness cannot resolve the
  change at this sample count, and that is a result worth printing rather than a run worth repeating
  until it comes out the other way.
*/
if (SETS > 1) {
  const low = Math.min(...deltas); const high = Math.max(...deltas);
  console.log('');
  console.log(`deltas: ${deltas.map(signed).join(', ')}   (spread ${high - low} games)`);
  if (low > 0 || high < 0) {
    console.log(`every set agrees on the sign, so the change is worth ${signed(low)} to ${
      signed(high)} of ${STRIDE} a set  (direction measured, size only to within the spread)`);
  } else if (low === 0 && high === 0) {
    // Which is also the negative control: an empty CHANGE must land here, because a variant
    // identical to stock has to play identical games. If it ever does not, the arms are not paired
    // and nothing else this harness prints can be read.
    console.log('every set read exactly zero. With a real CHANGE that is a card worth nothing; with');
    console.log('an empty one it is the negative control passing — identical arms, identical games.');
  } else {
    console.log('the sets disagree on the sign, so this change is NOT measured at this sample');
    console.log('count. More seeds, or a bigger change — not a third run read as a tie-break.');
  }
} else {
  console.log('');
  console.log('one seed set, which is a look rather than a measurement: D258 found paired readings');
  console.log('of the same change 5 to 17 games apart. Re-run with SETS=2 before publishing it.');
}
