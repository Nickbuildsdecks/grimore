/**
 * Every deck against every other deck, both seats, on one instrument.
 *
 * One number per deck: how many of its games it wins against the rest of the pool. Both
 * orientations of every pairing on the same seeds, so who goes first cancels out.
 */
import { applyAction, createGame, botAction, seatsToAct, STARTER_DECKS } from '../../packages/rules-engine/dist/index.js';
import { canonicalDecks } from './decks.mjs';

/*
  Every deck in the pool, read from the registry rather than written out here.

  It used to be a literal list in each of seven harnesses, which is seven places to remember and
  six places to forget: the twelfth deck was added and the first table run after it measured the
  same eleven-deck field as the day before, with no warning of any kind. A measurement that
  silently answers last week's question is worse than one that fails.
*/
const ALL = Object.keys(STARTER_DECKS);
const SEEDS = Number(process.env.SEEDS ?? 6);
const SEED0 = Number(process.env.SEED0 ?? 4400);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];
/*
  `BotOptions` for **every** seat, as JSON, so a change to the opponent can be read as a change to
  the standings.

  `bot-duel` asks whether a bot setting beats the bot without it, which is the right question about
  the setting and the wrong one about the pool: a rule that teaches every seat to hold mana for a
  counterspell does not make the bots better or worse than each other, it makes the five decks that
  hold counterspells better than the eight that do not. That is a table, not a duel.

  Default empty, so a published table means what it has always meant. Run both ways and read the
  rows that moved:

    BOT='{"reserveForAnswers":true}' SEEDS=12 node scripts/measure/deck-table.mjs
*/
const BOT = JSON.parse(process.env.BOT ?? '{}');

/*
  One deck's list changed, and the **whole field** re-measured with it in place.

  This exists because a slot change owes a reading of the **whole field**, which is the one question
  a probe cannot answer: a probe reports what the change did to the subject, and the table also
  reports what it did to the other twelve decks. In the Dawn Tithe re-ask of D258 every other deck
  gained a game or three off the weaker list without changing a card.

  What it is **not** for is checking a probe's number against a table's. The two harnesses derive
  their seeds differently (compare the `seedFor` below with `deck-probe`'s), so the two readings are
  different samples and differ by up to thirty games with nothing wrong at all — 3 and 17 games on
  unchanged decks in D258's own runs. That comparison produced the "believe the table" rule of D203
  and D247 and both conclusions were wrong. Pair the arms inside one instrument, read two seed sets,
  and keep the table for the field.

  Taking that reading used to mean editing `starterDecks.ts`, rebuilding, running, reverting and
  rebuilding again — four chances to publish a table of a deck list that is not in the repository.
  Now it is an argument:

    SUBJECT=verdant-guard CHANGE='Wolfir Silverheart:-1,Secure the Wastes:+1' \
      SEEDS=12 node scripts/measure/deck-table.mjs

  Same `CHANGE` grammar as `deck-swap` and `deck-probe`, including the `;` separator for the card
  names with a comma in them, and the same rule about where a card comes from: a name the change
  adds is looked up anywhere in the pool, which is where every card lives.
*/
const SUBJECT = process.env.SUBJECT ?? '';
const CHANGE = (process.env.CHANGE ?? '')
  .split((process.env.CHANGE ?? '').includes(';') ? ';' : ',')
  .filter(Boolean)
  .map((part) => {
    const at = part.lastIndexOf(':');
    return { name: part.slice(0, at).trim(), delta: Number(part.slice(at + 1)) };
  });
if (SUBJECT !== '' && STARTER_DECKS[SUBJECT] === undefined) {
  console.log(`no deck called ${SUBJECT}. Known: ${ALL.join(', ')}`);
  process.exit(1);
}
if (CHANGE.length > 0 && SUBJECT === '') {
  console.log('CHANGE needs a SUBJECT: it is one deck\'s list that is being changed');
  process.exit(1);
}

const defNamed = (name) => Object.values(STARTER_DECKS)
  .flatMap((d) => d.cards).find((e) => e.card.name === name)?.card;

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
  return { ...stock, cards };
}

/*
  The deck override travels on the **action context**, which is the same channel `deck-probe` uses
  and the reason neither harness has to touch the repository: `deck:load` reads `ctx.decks` in
  preference to the registry.

  Asserted rather than assumed, because a change that is also a change of deck size measures two
  things at once and the number would look like a card.
*/
/*
  Every deck canonically ordered, and the variant with them. See `canonicalDecks` — without it the
  arm with a change and the arm without are not comparable, because a list's written order decides
  the pre-shuffle order and so decides the games (D257).
*/
const CTX = canonicalDecks(
  STARTER_DECKS,
  CHANGE.length === 0 ? {} : { [SUBJECT]: variant() },
);
if (CHANGE.length > 0) {
  const size = (d) => d.cards.reduce((n, e) => n + e.count, 0);
  const stock = size(STARTER_DECKS[SUBJECT]);
  const changed = size(CTX.decks[SUBJECT]);
  console.log(`${SUBJECT}: ${stock} cards stock, ${changed} with the change`);
  if (stock !== changed) {
    console.log('!! the two lists are not the same size, so this measures deck size too');
  }
}

function duel(seed, decks) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  const host = { isHost: true, ...CTX };
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

const won = Object.fromEntries(ALL.map((d) => [d, 0]));
const played = Object.fromEntries(ALL.map((d) => [d, 0]));
const head = {};
/*
  A seed of its own for every game. One `seed` is one RNG stream, the stream shuffles each seat's
  deck in turn, and the same stream yields the same index permutation however different the deck
  list is — so a whole pass over the field on one seed was one shuffle wearing every pairing, and an
  absolute rate printed below had the error bars of its seed count rather than its game count.
  Measured in D240. Derived from the loop indices rather than a counter, because a counter
  desynchronises the arms of a paired harness the moment one of them skips a game.
*/
const seedFor = (pass, a, b, order) =>
  SEED0 + (((pass * ALL.length + a) * ALL.length + b) * 2) + order;

for (let i = 0; i < SEEDS; i++) {
  for (let a = 0; a < ALL.length; a++) {
    for (let b = a + 1; b < ALL.length; b++) {
      for (const [o, decks] of [[ALL[a], ALL[b]], [ALL[b], ALL[a]]].entries()) {
        const winner = duel(seedFor(i, a, b, o), decks);
        played[decks[0]] += 1; played[decks[1]] += 1;
        if (winner === null) continue;
        won[decks[winner]] += 1;
        const key = `${ALL[a]} v ${ALL[b]}`;
        head[key] ??= { [ALL[a]]: 0, [ALL[b]]: 0 };
        head[key][decks[winner]] += 1;
      }
    }
  }
}
const rows = ALL.map((d) => ({ deck: d, won: won[d], played: played[d],
  pct: Math.round((won[d] / Math.max(1, played[d])) * 100) }))
  .sort((x, y) => y.pct - x.pct);
console.log(`seeds ${SEEDS} from ${SEED0}: ${played[ALL[0]]} games per deck`);
for (const r of rows) console.log(`${String(r.pct).padStart(3)}%  ${r.won}-${r.played - r.won}  ${r.deck}`);
console.log(JSON.stringify(head));
