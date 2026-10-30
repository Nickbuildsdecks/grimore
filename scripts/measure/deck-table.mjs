/**
 * Every deck against every other deck, both seats, on one instrument.
 *
 * One number per deck: how many of its games it wins against the rest of the pool. Both
 * orientations of every pairing on the same seeds, so who goes first cancels out.
 */
import { applyAction, createGame, botAction, seatsToAct, STARTER_DECKS } from '../../packages/rules-engine/dist/index.js';

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

function duel(seed, decks) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
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
