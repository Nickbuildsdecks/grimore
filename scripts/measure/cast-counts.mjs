/**
 * Every slot in one deck, and how often the bot actually uses it.
 *
 * The dead-card question, asked of a whole list rather than of one card: a deck whose record is
 * bad because six of its sixty cards are never cast is a deck problem, and a deck whose every card
 * gets cast and still loses is a pilot problem. Which of those it is decides whether the fix is a
 * slot change or a better opponent, and guessing has been wrong before.
 *
 * Counted per game drawn and per game cast, not per game played, because a card is not dead for
 * sitting in the library: "drawn 41, cast 3" and "drawn 41, cast 39" are different diagnoses.
 */
import {
  applyAction, createGame, botAction, seatsToAct, STARTER_DECKS,
} from '../../packages/rules-engine/dist/index.js';

const SUBJECT = process.env.SUBJECT ?? 'tidal-mind';
const ALL = ['ember-rush', 'verdant-guard', 'tidal-mind', 'rot-harvest', 'forge-alliance',
  'skyward-writ', 'hollow-tide', 'ashen-rite'];
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 8);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

const used = new Map(); // name -> { cast, used, drawn }
const bump = (name, key) => {
  const row = used.get(name) ?? { cast: 0, used: 0, drawn: 0 };
  row[key] += 1;
  used.set(name, row);
};

function duel(seed, decks, mine) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, { isHost: true });
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, { isHost: true });
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, { isHost: true });
  const nameOf = (st, id) => st.cardDefs[st.instances[id]?.defKey ?? '']?.name;
  // Every card of the subject's that was ever in its owner's hand, so "drawn" counts a card the
  // deck saw rather than one it shuffled past.
  const seen = new Set();
  for (let move = 0; move < 4000 && !s.finished; move++) {
    for (const id of Object.keys(s.instances)) {
      const inst = s.instances[id];
      if (inst.owner === mine && inst.zone === 'hand') seen.add(nameOf(s, id));
    }
    const seat = seatsToAct(s)[0];
    if (seat === undefined) break;
    const action = botAction(s, seat);
    if (action === null) break;
    if (seat === mine && (action.type === 'auto:cast' || action.type === 'auto:playLand')) {
      bump(nameOf(s, action.card), 'cast');
    }
    /*
      An activated ability is the other way a card gets used, and for some cards it is the only
      way: a cycling land is *played* as a land or *cycled* from hand, and counting only the first
      would read "never played" on a card the deck used in every game. Every activation counts,
      mana taps included — a land's own column is meaningless either way, and filtering them would
      mean teaching this harness which abilities make mana.
    */
    if (seat === mine && action.type === 'auto:activate') bump(nameOf(s, action.card), 'used');
    const before = s.stateVersion;
    try { s = applyAction(s, action); } catch { break; }
    if (s.stateVersion === before) break;
  }
  for (const name of seen) if (name !== undefined) bump(name, 'drawn');
}

let games = 0;
for (let i = 0; i < SEEDS; i++) {
  for (const other of FIELD) {
    duel(SEED0 + i, [SUBJECT, other], 0); games += 1;
    duel(SEED0 + i, [other, SUBJECT], 1); games += 1;
  }
}

const list = STARTER_DECKS[SUBJECT].cards;
console.log(`${SUBJECT}: ${games} games, seeds ${SEEDS} from ${SEED0}`);
const rows = list.map((e) => {
  const row = used.get(e.card.name) ?? { cast: 0, used: 0, drawn: 0 };
  return { name: e.card.name, count: e.count, ...row };
}).sort((a, b) => ((a.cast + a.used) / Math.max(1, a.drawn)) - ((b.cast + b.used) / Math.max(1, b.drawn)));
for (const r of rows) {
  const rate = r.drawn === 0 ? '   —' : `${Math.round((100 * (r.cast + r.used)) / r.drawn).toString().padStart(3)}%`;
  console.log(`${rate}  cast ${String(r.cast).padStart(4)} + used ${String(r.used).padStart(4)} / in hand ${String(r.drawn).padStart(4)} games  x${r.count}  ${r.name}`);
}
