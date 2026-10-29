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
/*
  Every deck in the pool, read from the registry rather than written out here.

  It used to be a literal list in each of seven harnesses, which is seven places to remember and
  six places to forget: the twelfth deck was added and the first table run after it measured the
  same eleven-deck field as the day before, with no warning of any kind. A measurement that
  silently answers last week's question is worse than one that fails.
*/
const ALL = Object.keys(STARTER_DECKS);
const FIELD = ALL.filter((id) => id !== SUBJECT);
const SEEDS = Number(process.env.SEEDS ?? 8);
const SEED0 = Number(process.env.SEED0 ?? 3300);
const PLAYERS = [{ playerId: 'p0', name: 'A' }, { playerId: 'p1', name: 'B' }];

/*
  A variant list, so the question can be asked of a deck nobody ships.

  Same `CHANGE` grammar as `deck-probe` — "Name:+1,Other:-1", with `;` as the separator when a name
  has a comma in it — and the same route into the engine: the list is built here and handed over as
  `ActionContext.decks`, which is the path a pasted decklist takes. It exists because "how often
  does the bot press this" and "what happens with a second copy" are the same question, and
  measuring the second one by editing `starterDecks.ts` would mean a commit to ask it. D143's
  two-copy row is this.
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

function listFor(id) {
  const stock = STARTER_DECKS[id];
  if (CHANGE.length === 0) return stock;
  const cards = [];
  for (const entry of stock.cards) {
    const change = CHANGE.find((c) => c.name === entry.card.name);
    const count = entry.count + (change?.delta ?? 0);
    if (count > 0) cards.push({ card: entry.card, count });
  }
  for (const change of CHANGE) {
    if (change.delta <= 0 || stock.cards.some((e) => e.card.name === change.name)) continue;
    const card = defNamed(change.name);
    if (card === undefined) throw new Error(`no card named ${change.name} in the pool`);
    cards.push({ card, count: change.delta });
  }
  return { ...stock, cards };
}

const SUBJECT_LIST = listFor(SUBJECT);
const CTX = CHANGE.length === 0 ? { isHost: true } : { isHost: true, decks: { [SUBJECT]: SUBJECT_LIST } };
const size = (d) => d.cards.reduce((n, e) => n + e.count, 0);
if (size(SUBJECT_LIST) !== size(STARTER_DECKS[SUBJECT])) {
  console.log(`!! the variant is ${size(SUBJECT_LIST)} cards against the deck's ${size(STARTER_DECKS[SUBJECT])}`);
}

const used = new Map(); // name -> { cast, used, drawn }
/*
  And **which cost was paid**, for the cards that offer more than one.

  A card with an alternative cost is two cards, and the cast column cannot tell them apart: a
  Mulldrifter cast 30 times is a 2/2 flier or a Divination, and which it was is the only question
  the keyword raises. So every cast that carries one of the flags is tallied under `name (flag)`
  as well — the flags are read off the action rather than listed per card, so a keyword added
  later is counted here without this harness being told about it.
*/
const ALT_FLAGS = ['evoked', 'dashed', 'bestowed', 'spectacled', 'kicked', 'flashback', 'escape', 'foretold', 'offered', 'faceDown'];
const alt = new Map(); // "name (flag)" -> count
const bump = (name, key) => {
  const row = used.get(name) ?? { cast: 0, used: 0, drawn: 0 };
  row[key] += 1;
  used.set(name, row);
};

function duel(seed, decks, mine) {
  let s = createGame({ id: `g${seed}`, format: 'modern', players: PLAYERS, seed });
  for (const seat of [0, 1]) {
    s = applyAction(s, { type: 'deck:load', by: seat, seat, deckId: decks[seat] }, CTX);
  }
  s = applyAction(s, { type: 'game:start', by: 0, firstSeat: 0 }, CTX);
  s = applyAction(s, { type: 'auto:start', by: 0, firstSeat: 0, autoPass: true }, CTX);
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
      for (const flag of ALT_FLAGS) {
        if (action[flag] !== true) continue;
        const key = `${nameOf(s, action.card)} (${flag})`;
        alt.set(key, (alt.get(key) ?? 0) + 1);
      }
    }
    /*
      An activated ability is the other way a card gets used, and for some cards it is the only
      way: a cycling land is *played* as a land or *cycled* from hand, and counting only the first
      would read "never played" on a card the deck used in every game. Every activation counts,
      mana taps included — a land's own column is meaningless either way, and filtering them would
      mean teaching this harness which abilities make mana.
    */
    if (seat === mine && action.type === 'auto:activate') bump(nameOf(s, action.card), 'used');
    /*
      And the two special actions, which are the other way a card gets spent.

      A foretold card is cast on a later turn, so without this a foretell reads as a card that sat
      in hand doing nothing — and a morph turned face up is a second press on a card already
      counted as cast. Both land in the `used` column beside the activations, which is what that
      column is for: a use that is not a casting.
    */
    if (seat === mine && (action.type === 'auto:foretell' || action.type === 'auto:turnUp')) {
      bump(nameOf(s, action.card), 'used');
    }
    const before = s.stateVersion;
    try { s = applyAction(s, action, CTX); } catch { break; }
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

const list = SUBJECT_LIST.cards;
console.log(`${SUBJECT}: ${games} games, seeds ${SEEDS} from ${SEED0}`);
const rows = list.map((e) => {
  const row = used.get(e.card.name) ?? { cast: 0, used: 0, drawn: 0 };
  return { name: e.card.name, count: e.count, ...row };
}).sort((a, b) => ((a.cast + a.used) / Math.max(1, a.drawn)) - ((b.cast + b.used) / Math.max(1, b.drawn)));
for (const r of rows) {
  const rate = r.drawn === 0 ? '   —' : `${Math.round((100 * (r.cast + r.used)) / r.drawn).toString().padStart(3)}%`;
  console.log(`${rate}  cast ${String(r.cast).padStart(4)} + used ${String(r.used).padStart(4)} / in hand ${String(r.drawn).padStart(4)} games  x${r.count}  ${r.name}`);
}
/*
  The alternative costs, under the table rather than in it: these are casts already counted above,
  split by which cost was paid. A card with an alternative cost and no row here was always cast
  for what is printed on it, which is a finding rather than a blank.
*/
if (alt.size > 0) {
  console.log('');
  console.log('of those casts, the ones that paid something other than the printed cost:');
  for (const [key, n] of [...alt].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${key}`);
  }
}
