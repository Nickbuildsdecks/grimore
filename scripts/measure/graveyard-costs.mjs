/**
 * Does the bot ever pay a cost out of its own graveyard, and what does it pay?
 *
 * Escape and delve are the first costs in this engine that spend a *zone*, and both are invisible
 * to every instrument that was already here. `cast-counts` counts a Phoenix of Ash cast twice and
 * cannot say whether the second one came out of the graveyard or out of a second copy — there is no
 * second copy, but the harness does not know that. And delve does not change what is cast at all:
 * a Gurmag Angler cast for {B} and one cast for {6}{B} are the same row.
 *
 * So this reads the **stack**, which is where the engine writes down how a spell was paid for. A
 * cast with escape carries "(escaped, 3 cards)" in its description and a delved one carries
 * "(delved 6)", because both halves of those costs are things the opponent is entitled to see
 * before deciding whether to answer the spell. Anything this prints, a player could have read off
 * the table.
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
 */
import {
  applyAction, createGame, botAction, seatsToAct, scriptFor, STARTER_DECKS,
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

  /** Stack objects already counted, so a spell sitting on the stack is one casting. */
  const counted = new Set();
  const perCard = new Map();
  for (let move = 0; move < 4000 && !s.finished; move++) {
    for (const id of s.stackOrder) {
      const object = s.stackObjects[id];
      if (object === undefined || object.kind !== 'spell' || object.controller !== mine) continue;
      // Keyed by the object *and* its description, because an escaped Phoenix that dies and
      // escapes again is the same card id with a new casting on it.
      const key = `${id}:${object.description}`;
      if (counted.has(key)) continue;
      const name = s.cardDefs[object.cardKey]?.name;
      if (!WATCHED.has(name)) continue;
      const paid = /\((?:escaped, (\d+) cards|delved (\d+))\)/.exec(object.description ?? '');
      if (paid === null) continue;
      counted.add(key);
      const spent = Number(paid[1] ?? paid[2]);
      const r = row(name);
      r.casts += 1;
      r.cards += spent;
      r.counts.set(spent, (r.counts.get(spent) ?? 0) + 1);
      perCard.set(name, (perCard.get(name) ?? 0) + 1);
    }
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    const before = s.stateVersion;
    try { s = applyAction(s, action, ctx); } catch { break; }
    if (s.stateVersion === before) break;
  }
  if ([...perCard.values()].some((n) => n > 1)) twiceGames += 1;
}

for (let i = 0; i < SEEDS; i++) {
  for (const other of FIELD) {
    duel(SEED0 + i, [SUBJECT, other], 0); games += 1;
    duel(SEED0 + i, [other, SUBJECT], 1); games += 1;
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
